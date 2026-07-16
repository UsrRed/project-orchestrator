import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { getCurrentUserId } from "@/lib/users";
import {
  addConnection,
  deleteConnection,
  getProviderConnections,
  listConnections,
} from "@/lib/keys";
import {
  executionHealth,
  listFailedExecutions,
  projectSpendUsd,
  recordExecution,
} from "@/lib/executions";
import {
  createProjectFromArchitecture,
  getProjectTree,
  listProjects,
  renameProject,
  updateTask,
} from "@/lib/projects";
import {
  addMessage,
  getCoworkStatus,
  getTaskContext,
  setTaskMode,
} from "@/lib/conversation";
import {
  claimNextRun,
  enqueueRun,
  finishRun,
  runHealth,
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
    sql`TRUNCATE projects, normes, api_keys, agent_executions, autonomous_runs, oauth_config RESTART IDENTITY CASCADE`,
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

describe("connecteurs (clé API / OAuth / local)", () => {
  it("ajoute, masque, déchiffre, upsert, supprime", async () => {
    await addConnection(userId, "anthropic", "api_key", "sk-ant-TESTKEY-abcdef123456", "perso");
    await addConnection(userId, "groq", "api_key", "gsk_TESTKEY-zyxwvu987654", null);
    const conns = await listConnections(userId);
    expect(conns).toHaveLength(2);
    expect(conns.every((c) => !c.masked.includes("TESTKEY"))).toBe(true);

    const dec = await getProviderConnections(userId);
    expect(dec.anthropic?.secret).toBe("sk-ant-TESTKEY-abcdef123456");
    expect(dec.groq?.secret).toBe("gsk_TESTKEY-zyxwvu987654");

    await addConnection(userId, "anthropic", "api_key", "sk-ant-NEW-000111", "perso");
    expect((await listConnections(userId))).toHaveLength(2);
    expect((await getProviderConnections(userId)).anthropic?.secret).toBe("sk-ant-NEW-000111");

    await deleteConnection(userId, conns[0]!.id);
    expect(await listConnections(userId)).toHaveLength(1);
  });

  it("supporte les méthodes oauth (jeton chiffré) et none (local sans secret)", async () => {
    await addConnection(userId, "google", "oauth", "ya29.oauth-token-xyz", null);
    await addConnection(userId, "ollama", "none", null, null);
    const dec = await getProviderConnections(userId);
    expect(dec.google).toEqual({ method: "oauth", secret: "ya29.oauth-token-xyz" });
    expect(dec.ollama).toEqual({ method: "none" });

    const views = await listConnections(userId);
    const local = views.find((v) => v.provider === "ollama");
    expect(local?.method).toBe("none");
    expect(local?.masked).not.toContain("token");
  });
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

    const rid = await enqueueRun(userId, taskId, { goal: "g", maxIterations: 3, maxCostUsd: 10 });
    const claimed = await claimNextRun(new Date());
    expect(claimed?.id).toBe(rid);

    const final = await processRun(claimed!, {
      stepFn: async () => ({ done: false, note: "n", costUsd: 0 }),
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
    await setBudget(userId, pid, 0.1);
    await recordExecution({
      userId, taskLabel: "t", projectId: pid, provider: "ollama", model: "x",
      tier: "fast", status: "succeeded", promptTokens: 0, completionTokens: 0,
      costUsd: 0.2, startedAt: new Date(), finishedAt: new Date(),
    });
    const rid = await enqueueRun(userId, taskId, { goal: "g", maxIterations: 5, maxCostUsd: 10 });
    void rid;
    const claimed = await claimNextRun(new Date());
    let steps = 0;
    const final = await processRun(claimed!, {
      stepFn: async () => { steps++; return { done: false, note: "n", costUsd: 0 }; },
      budgetExceeded: async () => projectBudgetExceeded(pid),
    });
    expect(final.stopReason).toBe("project_budget");
    expect(steps).toBe(0);
  });
});

describe("budgets & exécutions", () => {
  it("rattache le coût, seuils, blocage", async () => {
    const pid = await createProjectFromArchitecture(userId, "idée", "tech", ARCH);
    const rec = (cost: number, status: "succeeded" | "failed" = "succeeded") =>
      recordExecution({
        userId, taskLabel: "t", projectId: pid, provider: "ollama", model: "x",
        tier: "fast", status, promptTokens: 0, completionTokens: 0,
        costUsd: cost, startedAt: new Date(), finishedAt: new Date(),
      });

    await rec(0.05);
    expect(await projectSpendUsd(pid)).toBeCloseTo(0.05, 9);

    await setBudget(userId, pid, 0.1);
    await rec(0.04); // 0.09 → 90%
    let s = await getBudgetStatus(userId, pid);
    expect(s.alert).toBe(true);
    expect(s.exceeded).toBe(false);
    await expect(assertWithinBudget(pid)).resolves.toBeUndefined();

    await rec(0.03); // 0.12 → dépassé
    s = await getBudgetStatus(userId, pid);
    expect(s.exceeded).toBe(true);
    await expect(assertWithinBudget(pid)).rejects.toThrow();

    await rec(0, "failed");
    const h = await executionHealth(userId);
    expect(h.failed).toBe(1);
    expect((await listFailedExecutions(userId))).toHaveLength(1);
  });
});

describe("config OAuth (secret chiffré)", () => {
  it("stocke et relit les creds GitHub", async () => {
    await setGitHubOAuthConfig("Iv1.client_id", "super_secret_value");
    const c = await getGitHubOAuthConfig();
    expect(c?.clientId).toBe("Iv1.client_id");
    expect(c?.clientSecret).toBe("super_secret_value");
  });
});
