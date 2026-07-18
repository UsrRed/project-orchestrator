/**
 * Test fonctionnel : la vie d'un projet, de l'idée à sa clôture.
 *
 * Ce que ce fichier vérifie et que les tests unitaires/d'intégration ne
 * vérifient pas : que les morceaux **s'enchaînent**. Chaque étape passe par la
 * vraie Server Action que déclenche l'UI (avec son `FormData`), et non par les
 * fonctions `lib/` sous-jacentes.
 *
 * **Répartition des rôles** : le test joue l'**humain** (écrit en Manuel, choisit
 * en Cowork, clôt les tâches) ; la **plateforme** fait tout le reste pour de vrai
 * (architecture, worker, garde-fous, journal de coût).
 *
 * **Exécutable en CI** : aucune clé API, aucun abonnement. Le seul élément simulé
 * est la sortie de `claude`, via le faux binaire posé sur le PATH
 * ([fake-claude.ts](fake-claude.ts)) — l'app appelle `claude -p` pour de vrai
 * (spawn, buildEnv), seule sa réponse est fabriquée.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  addTaskAction,
  generateProjectAction,
  updateTaskAction,
} from "@/app/projects/actions";
import {
  chooseOptionAction,
  generateWidgetAction,
  sendMessageAction,
  setModeAction,
  startRunAction,
} from "@/app/tasks/[taskId]/actions";
import { db } from "@/lib/db";
import { getCoworkStatus, listArtifacts, listMessages } from "@/lib/conversation";
import { listExecutions } from "@/lib/executions";
import { getProjectTree, listProjects, type TaskView } from "@/lib/projects";
import { listRunsForTask } from "@/lib/runs";
import { getCurrentUserId } from "@/lib/users";
import { processNextQueuedRun } from "@/lib/worker-runtime";
import { installFakeClaude, type FakeClaude } from "./fake-claude";
import { redirectUrlOf } from "./stubs/next-navigation";

let fake: FakeClaude;
let userId: string;

/** Le `FormData` que le navigateur enverrait. */
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const INITIAL = { ok: false, message: "" };

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE projects, normes, agent_executions, autonomous_runs, oauth_config, profiles RESTART IDENTITY CASCADE`,
  );
}

beforeAll(() => {
  fake = installFakeClaude();
});

afterAll(() => {
  fake.uninstall();
});

beforeEach(async () => {
  userId = await getCurrentUserId();
  await reset();
  fake.reset();
  fake.configure({
    // Le seul champ imposé : le nom du projet que l'architecte doit produire.
    values: { projectName: "Boutique de thé" },
    text: "Voici ma réponse en mode manuel.",
  });
});

/** Crée le projet depuis une idée et renvoie son id (l'action redirige). */
async function createProject(idea: string): Promise<string> {
  try {
    await generateProjectAction(
      INITIAL,
      form({ idea, type: "tech", repoMode: "none" }),
    );
  } catch (err) {
    // Succès = redirection vers /projects/<id> : c'est le contrat de l'action.
    return redirectUrlOf(err).split("/").pop()!;
  }
  throw new Error("L'action n'a pas redirigé : la génération a échoué.");
}

function allTasks(phases: { tasks: TaskView[] }[]): TaskView[] {
  return phases.flatMap((p) => p.tasks);
}

describe("cycle de vie d'un projet, de l'idée à la clôture", () => {
  it("l'architecte transforme une idée en arborescence exploitable", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");

    const tree = await getProjectTree(userId, projectId);
    expect(tree?.name).toBe("Boutique de thé");
    expect(tree?.idea).toBe("Une boutique de thé en ligne");
    expect(tree!.phases.length).toBeGreaterThanOrEqual(2);
    for (const phase of tree!.phases) {
      expect(phase.tasks.length).toBeGreaterThanOrEqual(1);
    }

    // L'appel est journalisé, sous l'agent Claude Code, avec de vrais tokens.
    const [exec] = await listExecutions(userId);
    expect(exec?.taskLabel).toContain("[architecture]");
    expect(exec?.provider).toBe("claude_cli");
    expect(exec?.promptTokens).toBeGreaterThan(0);
    // …et rattaché au projet : ce qui rend les budgets par projet possibles.
    const attached = (await db.execute(
      sql`select count(*)::int as n from agent_executions where project_id = ${projectId}`,
    )) as unknown as { n: number }[];
    expect(attached[0]?.n).toBe(1);
  });

  it("mode Manuel : l'humain écrit, l'agent répond, rien ne part tout seul", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[0]!.id;

    await setModeAction(form({ taskId, mode: "manual" }));
    const state = await sendMessageAction(
      INITIAL,
      form({ taskId, message: "Par quoi je commence ?" }),
    );
    expect(state.ok).toBe(true);

    const messages = await listMessages(userId, taskId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toBe("Voici ma réponse en mode manuel.");
    expect(await listArtifacts(userId, taskId)).toHaveLength(0);
  });

  it("mode Cowork : l'agent s'arrête sur des options, le choix humain produit l'artefact", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[0]!.id;

    await setModeAction(form({ taskId, mode: "cowork" }));
    expect(
      (await sendMessageAction(INITIAL, form({ taskId, message: "Aide-moi." })))
        .ok,
    ).toBe(true);

    const pending = await getCoworkStatus(userId, taskId);
    expect(pending.awaitingChoice).toBe(true);
    expect(pending.pendingOptions?.options.length).toBeGreaterThanOrEqual(2);
    expect(await listArtifacts(userId, taskId)).toHaveLength(0);

    const chosen = await chooseOptionAction(
      INITIAL,
      form({ taskId, optionIndex: "0" }),
    );
    expect(chosen.ok).toBe(true);

    const after = await getCoworkStatus(userId, taskId);
    expect(after.awaitingChoice).toBe(false);
    const artifacts = await listArtifacts(userId, taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.type).toBe("document");
  });

  it("un choix Cowork sans options en attente est refusé", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[0]!.id;
    await setModeAction(form({ taskId, mode: "cowork" }));

    const res = await chooseOptionAction(INITIAL, form({ taskId, optionIndex: "0" }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Aucune option");
  });

  it("mode Autonome : la plateforme prépare et exécute le run via Claude Code", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[1]!.id;

    await setModeAction(form({ taskId, mode: "autonomous" }));
    // L'humain ne donne QUE l'objectif : ni itérations, ni timeout. Plafond 0.
    const started = await startRunAction(
      INITIAL,
      form({ taskId, goal: "Rédiger le plan de lancement.", maxCostUsd: "0" }),
    );
    expect(started.ok).toBe(true);

    const [queued] = await listRunsForTask(userId, taskId);
    expect(queued?.maxIterations).toBeNull();
    expect(queued?.sourceLabel).toBeNull();

    // Le worker prend la suite — comme la boucle démarrée avec le serveur Next.
    expect(await processNextQueuedRun()).toBe(true);

    const [run] = await listRunsForTask(userId, taskId);
    expect(run?.status).toBe("succeeded");
    expect(run?.stopReason).toBe("completed");
    // Un seul moteur : l'agent Claude Code, une invocation = une itération.
    expect(run?.sourceLabel).toBe("Claude Code (abonnement)");
    expect(run?.maxIterations).toBe(1);
    expect(run?.iterations).toBe(1);

    // Le livrable existe (le résumé de l'agent + le diff du workspace).
    const artifacts = await listArtifacts(userId, taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content).toBeTruthy();

    // Le journal raconte le run : plan + étape + artefact.
    const kinds = (await listMessages(userId, taskId)).map((m) => m.kind);
    expect(kinds).toContain("auto_plan");
    expect(kinds.filter((k) => k === "auto_step")).toHaveLength(1);
    expect(kinds).toContain("artifact");
  });

  it("le run autonome est journalisé sous claude_cli", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[1]!.id;
    await setModeAction(form({ taskId, mode: "autonomous" }));
    await startRunAction(
      INITIAL,
      form({ taskId, goal: "Rédiger le plan.", maxCostUsd: "0" }),
    );
    await processNextQueuedRun();

    const execs = await listExecutions(userId);
    expect(execs.length).toBeGreaterThan(0);
    // Tout ce qui a tourné est passé par l'agent Claude Code.
    for (const e of execs) expect(e.provider).toBe("claude_cli");
  });

  it("un widget est produit à la demande, en données structurées", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[0]!.id;

    const res = await generateWidgetAction(
      INITIAL,
      form({ taskId, instruction: "Compare 3 fournisseurs de thé." }),
    );
    expect(res.ok).toBe(true);

    const [widget] = await listArtifacts(userId, taskId);
    expect(widget?.type).toBe("widget");
    const parsed = JSON.parse(widget?.content ?? "null") as { type?: string };
    expect(typeof parsed?.type).toBe("string");
  });

  it("le projet se clôt : toutes les tâches faites, le tableau de bord suit", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const tasks = allTasks(tree!.phases);

    const before = (await listProjects(userId)).find((p) => p.id === projectId);
    expect(before?.doneTaskCount).toBe(0);
    expect(before?.taskCount).toBe(tasks.length);

    await addTaskAction(
      form({ phaseId: tree!.phases[0]!.id, title: "Relire les CGV" }),
    );
    const full = allTasks((await getProjectTree(userId, projectId))!.phases);
    for (const t of full) {
      await updateTaskAction(form({ taskId: t.id, status: "done" }));
    }

    const after = (await listProjects(userId)).find((p) => p.id === projectId);
    expect(after?.taskCount).toBe(tasks.length + 1);
    expect(after?.doneTaskCount).toBe(after?.taskCount);
  });

  it("de bout en bout : idée → manuel → cowork → autonome → clôture", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const tasks = allTasks(tree!.phases);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    const [manual, cowork, auto] = [tasks[0]!, tasks[1]!, tasks[2]!];

    // 1. Manuel — l'humain écrit.
    await setModeAction(form({ taskId: manual.id, mode: "manual" }));
    await sendMessageAction(INITIAL, form({ taskId: manual.id, message: "Go" }));

    // 2. Cowork — l'agent propose, l'humain choisit.
    await setModeAction(form({ taskId: cowork.id, mode: "cowork" }));
    await sendMessageAction(INITIAL, form({ taskId: cowork.id, message: "Aide" }));
    await chooseOptionAction(INITIAL, form({ taskId: cowork.id, optionIndex: "1" }));

    // 3. Autonome — la plateforme se débrouille.
    await setModeAction(form({ taskId: auto.id, mode: "autonomous" }));
    await startRunAction(
      INITIAL,
      form({ taskId: auto.id, goal: "Produire le livrable.", maxCostUsd: "0" }),
    );
    expect(await processNextQueuedRun()).toBe(true);
    // File vide ensuite : aucun run fantôme.
    expect(await processNextQueuedRun()).toBe(false);

    // 4. Clôture.
    for (const t of tasks) {
      await updateTaskAction(form({ taskId: t.id, status: "done" }));
    }

    const summary = (await listProjects(userId)).find((p) => p.id === projectId);
    expect(summary?.doneTaskCount).toBe(summary?.taskCount);

    // Chaque mode a laissé sa trace, et chaque appel de Claude Code est
    // journalisé — la promesse du produit. Un appel → une ligne (un modèle).
    expect(await listArtifacts(userId, cowork.id)).toHaveLength(1);
    expect((await listRunsForTask(userId, auto.id))[0]?.status).toBe("succeeded");
    const execs = await listExecutions(userId);
    expect(execs.length).toBe(fake.calls.length);
    expect(execs.every((e) => e.status === "succeeded")).toBe(true);
  });
});
