/**
 * Test fonctionnel : la vie d'un projet, de l'idée à sa clôture.
 *
 * Ce que ce fichier vérifie et que les tests unitaires/d'intégration ne
 * vérifient pas : que les morceaux **s'enchaînent**. Chaque étape passe par la
 * vraie Server Action que déclenche l'UI (avec son `FormData`), et non par les
 * fonctions `lib/` sous-jacentes — c'est le seul moyen de couvrir la validation
 * des formulaires, le gating des options avancées et les invariants
 * inter-modules.
 *
 * **Répartition des rôles**, telle que le produit la définit :
 *  - le test joue l'**humain** là où le produit attend un humain — il écrit le
 *    message en mode Manuel, choisit une option en mode Cowork, clôt les
 *    tâches ;
 *  - la **plateforme** fait tout le reste, pour de vrai : architecture,
 *    routage par niveau et par source, planification du run, worker, garde-fous,
 *    journal de coût.
 *
 * **Exécutable en CI** (cf. `.github/workflows/ci.yml`, job `test`) : aucune clé
 * API, aucun modèle local, aucun agent CLI. Le seul élément simulé est la
 * réponse du modèle, servie en HTTP par [fake-llm.ts](fake-llm.ts) et branchée
 * via `LOCAL_AI_BASE_URL` — le provider `ollama` est un serveur
 * OpenAI-compatible, donc rien de notre code n'a besoin d'être contourné.
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
import { addConnection } from "@/lib/keys";
import { getCoworkStatus, listArtifacts, listMessages } from "@/lib/conversation";
import { listExecutions } from "@/lib/executions";
import { getProjectTree, listProjects, type TaskView } from "@/lib/projects";
import { listRunsForTask } from "@/lib/runs";
import { getCurrentUserId } from "@/lib/users";
import { processNextQueuedRun } from "@/lib/worker-runtime";
import { startFakeLlm, type FakeCall, type FakeLlm } from "./fake-llm";
import { redirectUrlOf } from "./stubs/next-navigation";

let fake: FakeLlm;
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
    sql`TRUNCATE projects, normes, api_keys, agent_executions, autonomous_runs, oauth_config, profiles RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  fake = await startFakeLlm();
  // Lu à CHAQUE appel par `buildModel` (llm-router) : le brancher ici suffit,
  // sans rien réimporter.
  process.env.LOCAL_AI_BASE_URL = fake.url;
});

afterAll(async () => {
  await fake.close();
});

beforeEach(async () => {
  userId = await getCurrentUserId();
  await reset();
  fake.reset();
  fake.configure({
    values: {
      projectName: "Boutique de thé",
      // Le niveau que le planificateur estimera. 2 : atteignable par le modèle
      // local (niveau 3 par défaut) → la source `local` doit gagner.
      level: 2,
      maxIterations: 2,
      timeoutMin: 5,
      // L'agent autonome conclut à sa 2e étape : la 1re écrit un brouillon, la
      // 2e le reprend. C'est la boucle « rédiger puis réviser » qu'on veut
      // exercer, pas un aller simple.
      done: (call: FakeCall) => call.sameSchemaIndex >= 1,
    },
    text: "Voici ma réponse en mode manuel.",
  });
  // Le seul connecteur : le « modèle local ». Aucun secret, donc rien à chiffrer
  // ni à fournir en CI.
  await addConnection(userId, "ollama", "none", null, "local-test");
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
    // Le schéma impose au moins 2 phases, chacune avec des tâches : une
    // arborescence vide serait acceptée en base mais inutilisable.
    expect(tree!.phases.length).toBeGreaterThanOrEqual(2);
    for (const phase of tree!.phases) {
      expect(phase.tasks.length).toBeGreaterThanOrEqual(1);
    }

    // L'appel est journalisé, avec de vrais tokens comptés.
    const [exec] = await listExecutions(userId);
    expect(exec?.taskLabel).toContain("[architecture]");
    expect(exec?.provider).toBe("ollama");
    expect(exec?.promptTokens).toBeGreaterThan(0);
    // …et rattaché au projet : c'est ce qui rend les budgets par projet
    // possibles. `ExecutionView` ne l'expose pas, on le vérifie donc en base.
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
    // Manuel ne produit pas d'artefact : il discute.
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

    // Point d'arrêt : l'agent attend, il n'a rien tranché.
    const pending = await getCoworkStatus(userId, taskId);
    expect(pending.awaitingChoice).toBe(true);
    expect(pending.pendingOptions?.options.length).toBeGreaterThanOrEqual(2);
    expect(await listArtifacts(userId, taskId)).toHaveLength(0);

    // L'humain tranche.
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

  it("mode Autonome : la plateforme évalue, route, planifie et exécute seule", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[1]!.id;

    await setModeAction(form({ taskId, mode: "autonomous" }));
    // L'humain ne donne QUE l'objectif : ni moteur, ni itérations, ni timeout.
    // Le plafond reste à 0 — « ne rien dépenser ».
    const started = await startRunAction(
      INITIAL,
      form({ taskId, goal: "Rédiger le plan de lancement.", maxCostUsd: "0" }),
    );
    expect(started.ok).toBe(true);

    const [queued] = await listRunsForTask(userId, taskId);
    expect(queued?.engine).toBe("auto");
    expect(queued?.maxIterations).toBeNull();
    expect(queued?.plannedLevel).toBeNull();

    // Le worker prend la suite — exactement ce que fait la boucle démarrée avec
    // le serveur Next.
    expect(await processNextQueuedRun()).toBe(true);

    const [run] = await listRunsForTask(userId, taskId);
    expect(run?.status).toBe("succeeded");
    expect(run?.stopReason).toBe("completed");
    // Planifié par l'IA, pas par l'humain.
    expect(run?.planner).toBe("ai");
    expect(run?.plannedLevel).toBe(2);
    expect(run?.maxIterations).toBe(2);
    // Plafond 0 → une source gratuite, et zéro dépense réelle.
    expect(run?.sourceKind).toBe("local");
    expect(run?.sourceLabel).toContain("Local");
    expect(run?.spentUsd).toBe(0);
    // Conclut de lui-même sans épuiser ses itérations.
    expect(run?.iterations).toBe(2);

    // Le livrable existe, et il a bien été révisé (2 étapes), pas rendu au 1er jet.
    const artifacts = await listArtifacts(userId, taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content).toBeTruthy();
    expect(run?.draft?.content).toBe(artifacts[0]?.content);

    // Le journal raconte le run : plan + étapes + artefact.
    const kinds = (await listMessages(userId, taskId)).map((m) => m.kind);
    expect(kinds).toContain("auto_plan");
    expect(kinds.filter((k) => k === "auto_step")).toHaveLength(2);
    expect(kinds).toContain("artifact");
  });

  it("le plafond à 0 n'élit jamais une source payante", async () => {
    const projectId = await createProject("Une boutique de thé en ligne");
    const tree = await getProjectTree(userId, projectId);
    const taskId = allTasks(tree!.phases)[1]!.id;
    await setModeAction(form({ taskId, mode: "autonomous" }));
    await startRunAction(
      INITIAL,
      form({ taskId, goal: "Rédiger le plan.", maxCostUsd: "0" }),
    );
    await processNextQueuedRun();

    // Tout ce qui a tourné est passé par le local : aucune facturation possible.
    const execs = await listExecutions(userId);
    expect(execs.length).toBeGreaterThan(0);
    for (const e of execs) {
      expect(e.provider).toBe("ollama");
      expect(e.costUsd).toBe(0);
    }
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
    // Des données, jamais du code : le contenu doit reparser, et porter le
    // discriminant que le rendu whitelisté attend.
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

    // L'humain ajoute une tâche oubliée, puis clôt tout.
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
    // Une tâche par mode : sans ça, le scénario testerait deux fois la même et
    // les assertions par tâche se marcheraient dessus.
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

    // Chaque mode a laissé sa trace, et chaque appel de modèle est journalisé
    // avec son coût — la promesse du produit.
    expect(await listArtifacts(userId, cowork.id)).toHaveLength(1);
    expect((await listRunsForTask(userId, auto.id))[0]?.status).toBe("succeeded");
    const execs = await listExecutions(userId);
    expect(execs.length).toBe(fake.calls.length);
    expect(execs.every((e) => e.status === "succeeded")).toBe(true);
  });
});
