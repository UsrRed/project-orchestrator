import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { getCurrentUserId } from "@/lib/users";
import {
  executionHealth,
  listFailedExecutions,
  projectSpendTokens,
  recordExecution,
} from "@/lib/executions";
import {
  createProjectFromArchitecture,
  getProjectTree,
  listProjects,
  renameProject,
  replaceProjectTree,
  updateTask,
} from "@/lib/projects";
import {
  getProfile,
  profilePreamble,
  upsertProfile,
} from "@/lib/profile";
import {
  addMessage,
  getCoworkStatus,
  getTaskContext,
  setTaskMode,
} from "@/lib/conversation";
import {
  applyPlan,
  claimNextRun,
  enqueueRun,
  getRunFresh,
  listRunsForTask,
  runHealth,
  touchRun,
} from "@/lib/runs";
import { processRun } from "@/lib/worker";
import {
  associateNorme,
  buildPhaseNormsContext,
  createNorme,
} from "@/lib/normes";
import {
  assertWithinBudget,
  getBudgetStatus,
  projectBudgetExceeded,
  setBudget,
} from "@/lib/budgets";
import {
  getGitHubOAuthConfig,
  setGitHubOAuthConfig,
} from "@/lib/oauth-config";
import type { Architecture } from "@/lib/architect";

const OTHER = "00000000-0000-0000-0000-000000000000";

async function reset() {
  await db.execute(
    sql`TRUNCATE projects, normes, agent_executions, autonomous_runs, oauth_config, profiles RESTART IDENTITY CASCADE`,
  );
}

const ARCH: Architecture = {
  projectName: "Proj",
  summary: "s",
  phases: [
    {
      name: "Conception",
      type: "design",
      tasks: [
        { title: "T1", description: "d", mode: "manual", priority: 2 },
        { title: "T2", description: "d", mode: "cowork", priority: 1 },
      ],
    },
    {
      name: "Dév",
      type: "developpement",
      tasks: [{ title: "T3", description: "d", mode: "autonomous", priority: 0 }],
    },
  ],
};

let userId: string;
beforeEach(async () => {
  userId = await getCurrentUserId();
  await reset();
});

describe("projets : arborescence & édition", () => {
  it("persiste, lit, édite, garde-fous, cascade", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const tree = await getProjectTree(userId, pid);
    expect(tree?.phases).toHaveLength(2);
    expect(tree?.phases[0]!.tasks).toHaveLength(2);

    const list = await listProjects(userId);
    expect(list[0]!.phaseCount).toBe(2);
    expect(list[0]!.taskCount).toBe(3);

    await renameProject(userId, pid, "Renommé");
    expect((await getProjectTree(userId, pid))?.name).toBe("Renommé");

    const taskId = tree!.phases[0]!.tasks[0]!.id;
    await updateTask(userId, taskId, { status: "done" });
    const t = await getProjectTree(userId, pid);
    expect(t!.phases[0]!.tasks.find((x) => x.id === taskId)?.status).toBe("done");

    expect(await getProjectTree(OTHER, pid)).toBeNull();
    await expect(renameProject(OTHER, pid, "hack")).rejects.toThrow();
  });
});

describe("conversation & machine Cowork", () => {
  it("contexte, mode, fil, point d'arrêt", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[0]!.tasks[0]!.id;

    const ctx = await getTaskContext(userId, taskId);
    expect(ctx?.projectName).toBe("Proj");
    await setTaskMode(userId, taskId, "cowork");
    expect((await getTaskContext(userId, taskId))?.taskMode).toBe("cowork");

    await addMessage(taskId, { role: "user", content: "?" });
    expect((await getCoworkStatus(userId, taskId)).awaitingChoice).toBe(false);
    await addMessage(taskId, {
      role: "assistant",
      content: "opts",
      kind: "cowork_options",
      data: { intro: "i", options: [{ title: "a", detail: "d" }, { title: "b", detail: "d" }] },
    });
    const st = await getCoworkStatus(userId, taskId);
    expect(st.awaitingChoice).toBe(true);
    expect(st.pendingOptions?.options).toHaveLength(2);
  });
});

describe("normes : injection traçable", () => {
  it("associe et injecte le contenu en préprompt", async () => {
    const nId = await createNorme(userId, {
      name: "Charte",
      category: "design",
      promptContent: "Palette sobre.",
      scope: "global",
    });
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const phaseId = (await getProjectTree(userId, pid))!.phases[0]!.id;
    await associateNorme(userId, phaseId, nId, false);
    const ctx = await buildPhaseNormsContext(userId, phaseId);
    expect(ctx.text).toContain("Palette sobre.");
    expect(ctx.applied.map((n) => n.name)).toContain("Charte");
  });
});

describe("runs autonomes & garde-fous", () => {
  it("queue, claim, max itérations, santé", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;

    const rid = await enqueueRun(userId, taskId, { goal: "g", maxIterations: 3, maxTokens: 0 });
    const claimed = await claimNextRun(new Date());
    expect(claimed?.id).toBe(rid);

    const final = await processRun(claimed!, {
      stepFn: async () => ({ done: false, note: "n", tokens: 0 }),
    });
    expect(final.status).toBe("failed");
    expect(final.stopReason).toBe("iterations");
    expect(final.iterations).toBe(3);

    const health = await runHealth(userId);
    expect(health.total).toBe(1);
    expect(health.failed).toBe(1);
  });

  it("garde-fou budget projet stoppe le run", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;
    // Plafond de 100 tokens, déjà dépassé par une exécution de 180 tokens.
    await setBudget(userId, pid, 100);
    await recordExecution({
      userId, taskLabel: "t", projectId: pid, provider: "claude_cli", model: "claude",
      tier: "cli", status: "succeeded", promptTokens: 120, completionTokens: 60,
      costUsd: 0, startedAt: new Date(), finishedAt: new Date(),
    });
    const rid = await enqueueRun(userId, taskId, { goal: "g", maxIterations: 5, maxTokens: 0 });
    void rid;
    const claimed = await claimNextRun(new Date());
    let steps = 0;
    const final = await processRun(claimed!, {
      stepFn: async () => { steps++; return { done: false, note: "n", tokens: 0 }; },
      budgetExceeded: async () => projectBudgetExceeded(pid),
    });
    expect(final.stopReason).toBe("project_tokens");
    expect(steps).toBe(0);
  });

  it("plafond 0 = illimité : le run tourne malgré la consommation de tokens", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;

    await enqueueRun(userId, taskId, { goal: "g", maxIterations: 2, maxTokens: 0 });
    const claimed = await claimNextRun(new Date());
    expect(claimed?.maxTokens).toBe(0);

    let steps = 0;
    const final = await processRun(claimed!, {
      // Chaque étape consomme des tokens : avec un plafond à 0 (illimité), ça ne
      // doit jamais arrêter le run — sinon tout run mourrait à la 1re étape.
      stepFn: async () => {
        steps++;
        return { done: steps === 2, note: "n", tokens: 500 };
      },
    });
    expect(steps).toBe(2);
    expect(final.stopReason).toBe("completed");
  });

  it("plafond de tokens atteint arrête le run", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;

    await enqueueRun(userId, taskId, { goal: "g", maxIterations: 5, maxTokens: 100 });
    const claimed = await claimNextRun(new Date());
    const final = await processRun(claimed!, {
      stepFn: async () => ({ done: false, note: "n", tokens: 150 }),
    });
    expect(final.stopReason).toBe("tokens");
    expect(final.iterations).toBe(1);
  });

  it("mise en file sans limites : tout reste à préparer", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;

    const rid = await enqueueRun(userId, taskId, { goal: "g" });
    const [run] = await listRunsForTask(userId, taskId);
    expect(run?.id).toBe(rid);
    expect(run?.maxIterations).toBeNull();
    expect(run?.timeoutMin).toBeNull();
    expect(run?.maxTokens).toBe(0);
    expect(run?.sourceLabel).toBeNull();

    // applyPlan fige les limites et arme le timeout à partir de MAINTENANT, pas
    // de la mise en file.
    const now = new Date("2026-07-16T12:00:00Z");
    await applyPlan(
      rid,
      {
        planReason: "Limites par défaut de l'agent Claude Code.",
        sourceLabel: "Claude Code (abonnement)",
        maxIterations: 1,
        timeoutMin: 30,
      },
      now,
    );
    const planned = await getRunFresh(rid);
    expect(planned?.maxIterations).toBe(1);
    expect(planned?.sourceLabel).toBe("Claude Code (abonnement)");
    expect(planned?.timeoutAt?.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it("objectif atteint : l'artefact est produit une seule fois", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;
    await enqueueRun(userId, taskId, { goal: "g", maxIterations: 5, maxTokens: 0 });
    const claimed = await claimNextRun(new Date());

    const saved: { salvaged: boolean }[] = [];
    const final = await processRun(claimed!, {
      stepFn: async () => ({
        done: true,
        note: "fini",
        tokens: 0,
        artifact: { title: "Doc", content: "# ok" },
      }),
      onArtifact: async (_run, _artifact, opts) => {
        saved.push({ salvaged: Boolean(opts?.salvaged) });
      },
    });

    expect(final.stopReason).toBe("completed");
    expect(saved).toEqual([{ salvaged: false }]);
  });

  it("le battement de verrou empêche un second worker de reprendre un run vivant", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;
    await enqueueRun(userId, taskId, { goal: "long", maxIterations: 5, maxTokens: 0 });

    const claimed = await claimNextRun(new Date());
    expect(claimed).not.toBeNull();

    // Sans battement, une étape longue (l'agent Claude Code : plusieurs minutes)
    // laisse le verrou pourrir, et un second worker relance le MÊME run.
    const stolen = await claimNextRun(new Date(Date.now() + 5 * 60_000));
    expect(stolen?.id).toBe(claimed!.id);

    await touchRun(claimed!.id);
    expect(await claimNextRun(new Date(Date.now() + 30_000))).toBeNull();
  });

  it("un run non préparé ne boucle pas indéfiniment", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const taskId = (await getProjectTree(userId, pid))!.phases[1]!.tasks[0]!.id;

    await enqueueRun(userId, taskId, { goal: "g" });
    const claimed = await claimNextRun(new Date());
    let steps = 0;
    const final = await processRun(claimed!, {
      stepFn: async () => {
        steps++;
        return { done: false, note: "n", tokens: 0 };
      },
    });
    // Sans limites, la boucle n'a aucune borne : elle doit refuser de démarrer.
    expect(steps).toBe(0);
    expect(final.status).toBe("failed");
    expect(final.stopReason).toBe("error");
  });
});

describe("budgets & exécutions", () => {
  it("rattache les tokens, seuils, blocage", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    // Budget en tokens : `rec(n)` journalise n tokens (entrée) sur le projet.
    const rec = (tokens: number, status: "succeeded" | "failed" = "succeeded") =>
      recordExecution({
        userId, taskLabel: "t", projectId: pid, provider: "claude_cli", model: "claude",
        tier: "cli", status, promptTokens: tokens, completionTokens: 0,
        costUsd: 0, startedAt: new Date(), finishedAt: new Date(),
      });

    await rec(50);
    expect(await projectSpendTokens(pid)).toBe(50);

    await setBudget(userId, pid, 100);
    await rec(40); // 90 → 90%
    let s = await getBudgetStatus(userId, pid);
    expect(s.alert).toBe(true);
    expect(s.exceeded).toBe(false);
    await expect(assertWithinBudget(pid)).resolves.toBeUndefined();

    await rec(30); // 120 → dépassé
    s = await getBudgetStatus(userId, pid);
    expect(s.exceeded).toBe(true);
    await expect(assertWithinBudget(pid)).rejects.toThrow();

    await rec(0, "failed");
    const h = await executionHealth(userId);
    expect(h.failed).toBe(1);
    expect((await listFailedExecutions(userId))).toHaveLength(1);
  });
});

describe("profil utilisateur", () => {
  it("défauts, upsert, préambule", async () => {
    const def = await getProfile(userId);
    expect(def.language).toBe("fr");
    expect(def.defaultProjectType).toBe("tech");
    expect(def.defaultBudgetTokens).toBeNull();

    await upsertProfile(userId, {
      displayName: "Alice",
      language: "en",
      tone: "direct",
      defaultProjectType: "marketing",
      defaultBudgetTokens: 500_000,
    });
    const p = await getProfile(userId);
    expect(p.displayName).toBe("Alice");
    expect(p.language).toBe("en");
    expect(p.defaultProjectType).toBe("marketing");
    expect(p.defaultBudgetTokens).toBe(500_000);
    expect(profilePreamble(p)).toContain("anglais");
    expect(profilePreamble(p)).toContain("direct");
  });
});

describe("raffinement d'arborescence", () => {
  it("replaceProjectTree remplace phases & tâches", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    expect((await getProjectTree(userId, pid))?.phases).toHaveLength(2);

    await replaceProjectTree(userId, pid, {
      projectName: "Révisé",
      summary: "s",
      phases: [
        {
          name: "Sécurité",
          type: "securite",
          tasks: [{ title: "Audit", description: "d", mode: "manual", priority: 1 }],
        },
      ],
    });
    const tree = await getProjectTree(userId, pid);
    expect(tree?.name).toBe("Révisé");
    expect(tree?.phases).toHaveLength(1);
    expect(tree?.phases[0]!.name).toBe("Sécurité");
  });
});

describe("config OAuth (secret chiffré)", () => {
  // La suite tourne sur la base de DEV : ne pas laisser derrière soi une config
  // OAuth factice, sinon le login GitHub répond 404 avec un client_id bidon.
  afterAll(reset);

  it("stocke et relit les creds GitHub", async () => {
    await setGitHubOAuthConfig("Ov23liTESTONLY123456", "super_secret_value");
    const c = await getGitHubOAuthConfig();
    expect(c?.clientId).toBe("Ov23liTESTONLY123456");
    expect(c?.clientSecret).toBe("super_secret_value");
  });

  it("refuse un client_id qui ferait échouer le login", async () => {
    await expect(
      setGitHubOAuthConfig("Iv1.client_id", "s"),
    ).rejects.toThrow(/GitHub App/);
  });
});
