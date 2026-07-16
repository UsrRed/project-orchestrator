/**
 * Câblage du moteur `cli` du mode Autonome.
 *
 * Pendant de [autonomous-agent.ts](autonomous-agent.ts) : même contrat
 * (`WorkerDeps`), même boucle ([worker.ts](worker.ts)), mêmes garde-fous — mais
 * l'étape lance un vrai agent de code (`claude`, `gemini`, `opencode`) dans le
 * workspace du projet au lieu d'appeler le routeur LLM.
 *
 * **Une invocation = une itération = fin du run.** Un agent CLI boucle déjà en
 * interne avec ses outils ; le re-boucler serait redondant et coûteux. D'où
 * `done: true` dès qu'une invocation aboutit, et `maxIterations` à 1 par défaut
 * (cf. [runs.ts](runs.ts)). Au-delà de 1, les itérations reprennent la session.
 */
import "server-only";

import {
  cliAgentInfo,
  type CliAgentId,
  type CliAgentInfo,
} from "@/lib/cli-agents";
import { addArtifact, addMessage, getTaskContext, listMessages } from "@/lib/conversation";
import { projectBudgetExceeded } from "@/lib/budgets";
import { buildPhaseNormsContext } from "@/lib/normes";
import { recordExecution } from "@/lib/executions";
import { getRunFresh } from "@/lib/runs";
import { runProcess } from "@/lib/process";
import { captureException, logInfo } from "@/lib/observability";
import { ensureWorkspace, workspaceChanges } from "@/lib/workspace";
import type { StepFn, WorkerDeps } from "@/lib/worker";

/**
 * Plafond dur d'une invocation, même si le run n'a pas de timeout : un agent
 * CLI parti en vrille ne doit pas immobiliser le worker indéfiniment.
 */
const HARD_TIMEOUT_MS = 30 * 60_000;
/** Fréquence de relecture du run pendant l'invocation (kill switch, budget). */
const WATCH_INTERVAL_MS = 2_000;
/** Les notes vivent dans le fil de discussion : on ne le noie pas. */
const NOTE_MAX_CHARS = 4_000;

/** Contexte projet/phase/tâche + Normes, en tête du prompt (comme les 3 modes). */
function buildPrompt(
  goal: string,
  ctxText: string,
  normsText: string,
  priorNotes: string,
): string {
  return [
    normsText ? `${normsText}\n` : "",
    ctxText,
    "",
    `Objectif : ${goal}`,
    priorNotes ? `\nCe qui a déjà été fait :\n${priorNotes}` : "",
    "",
    "Tu travailles dans le dépôt courant. Réalise l'objectif directement dans " +
      "les fichiers. Ne commite pas et ne pousse pas : les changements seront " +
      "relus. Termine par un résumé court de ce que tu as fait.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Session à reprendre pour ce run, mémorisée dans les notes d'étape.
 * `opencode` génère lui-même ses identifiants (`ses_…`) : on ne peut pas en
 * imposer un, seulement relire celui qu'il a renvoyé.
 */
async function lastSessionId(
  userId: string,
  taskId: string,
  runId: string,
): Promise<string | undefined> {
  const messages = await listMessages(userId, taskId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = messages[i]?.data as
      | { runId?: string; sessionId?: string }
      | null
      | undefined;
    if (d?.runId === runId && d.sessionId) return d.sessionId;
  }
  return undefined;
}

/**
 * Surveille le run pendant l'invocation et annule dès qu'un garde-fou tombe.
 *
 * Sans ça, le kill switch serait décoratif : `guardStop` n'est évalué qu'entre
 * les étapes ([worker.ts](worker.ts)), alors qu'une invocation CLI dure des
 * minutes. Renvoie de quoi arrêter la surveillance.
 */
function watchRun(
  runId: string,
  projectId: string,
  controller: AbortController,
): () => void {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const fresh = await getRunFresh(runId);
      if (fresh?.killRequested || (await projectBudgetExceeded(projectId))) {
        controller.abort();
      }
    } catch (err) {
      // Une base momentanément indisponible ne doit pas tuer un run en cours.
      await captureException(err, "cli_agent.watch_failed", { runId });
    } finally {
      checking = false;
    }
  }, WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Délai accordé à l'invocation : le reste du run, borné par le plafond dur. */
function invocationTimeoutMs(timeoutAt: Date | null, now: Date): number {
  if (!timeoutAt) return HARD_TIMEOUT_MS;
  const remaining = timeoutAt.getTime() - now.getTime();
  return Math.max(1_000, Math.min(remaining, HARD_TIMEOUT_MS));
}

async function runCli(
  cli: CliAgentInfo,
  prompt: string,
  cwd: string,
  opts: { runId: string; resumeSessionId?: string; timeoutMs: number; signal: AbortSignal },
) {
  const args = cli.buildArgs(prompt, {
    runId: opts.runId,
    resumeSessionId: opts.resumeSessionId,
  });

  const r = await runProcess({
    bin: cli.bin,
    args,
    cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStderrLine: (line) =>
      logInfo("cli_agent.stderr", { runId: opts.runId, cli: cli.id, line }),
  });

  // Annulation demandée : on rend la main sans exception. La boucle du worker
  // relit le run juste après et conclut proprement (killed / project_budget).
  if (r.aborted) return { outcome: null, result: r };

  if (r.timedOut) {
    throw new Error(
      `\`${cli.bin}\` a dépassé le délai d'exécution (${Math.round(opts.timeoutMs / 1000)} s) et a été arrêté.`,
    );
  }
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 800);
    throw new Error(
      `\`${cli.bin}\` a échoué (code ${r.code})${detail ? ` : ${detail}` : "."}`,
    );
  }

  return { outcome: cli.parseOutcome(r.stdout), result: r };
}

/**
 * Construit un `WorkerDeps` qui exécute les runs avec un agent CLI.
 * Aucune clé LLM n'est requise : le CLI utilise son propre login.
 */
export function makeCliAgentDeps(userId: string, cliId: CliAgentId): WorkerDeps {
  const cli = cliAgentInfo(cliId);
  if (!cli) throw new Error(`Agent CLI inconnu : « ${cliId} ».`);

  const stepFn: StepFn = async (ctx, run) => {
    const taskCtx = await getTaskContext(userId, ctx.taskId);
    if (!taskCtx) throw new Error("Tâche introuvable pour le run.");

    const ws = await ensureWorkspace(userId, taskCtx.projectId);
    const norms = await buildPhaseNormsContext(userId, taskCtx.phaseId);

    const priorNotes = (await listMessages(userId, ctx.taskId))
      .filter((m) => m.kind === "auto_step")
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join("\n");

    const prompt = buildPrompt(
      ctx.goal,
      `Projet « ${taskCtx.projectName} » (${taskCtx.projectType}), ` +
        `phase « ${taskCtx.phaseName} », tâche « ${taskCtx.taskTitle} »` +
        (taskCtx.taskDescription ? `.\nDescription : ${taskCtx.taskDescription}` : "."),
      norms.text,
      priorNotes,
    );

    const resumeSessionId =
      ctx.iteration > 0
        ? await lastSessionId(userId, ctx.taskId, ctx.runId)
        : undefined;

    const controller = new AbortController();
    const stopWatching = watchRun(ctx.runId, taskCtx.projectId, controller);
    const startedAt = new Date();

    let outcome, result;
    try {
      ({ outcome, result } = await runCli(cli, prompt, ws.path, {
        runId: ctx.runId,
        resumeSessionId,
        timeoutMs: invocationTimeoutMs(run.timeoutAt, startedAt),
        signal: controller.signal,
      }));
    } catch (err) {
      await recordExecution({
        userId,
        taskLabel: `[cli:${cli.id}] ${taskCtx.taskTitle}`,
        projectId: taskCtx.projectId,
        taskId: ctx.taskId,
        provider: cli.execProvider,
        model: cli.id,
        tier: "cli",
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: new Date(),
      });
      throw err;
    } finally {
      stopWatching();
    }

    // Interrompu : pas d'artefact, pas de `done`. Le worker tranchera.
    if (!outcome) {
      return {
        done: false,
        note: `Agent \`${cli.id}\` interrompu (arrêt demandé ou budget projet dépassé).`,
        costUsd: 0,
      };
    }

    // Une invocation traverse souvent plusieurs modèles : on journalise une
    // ligne PAR modèle, sinon la consommation par modèle serait perdue à
    // l'écriture et irrécupérable ensuite. Le total par run reste la somme.
    const finishedAt = new Date();
    const base = {
      userId,
      taskLabel: `[cli:${cli.id}] ${taskCtx.taskTitle}`,
      projectId: taskCtx.projectId,
      taskId: ctx.taskId,
      provider: cli.execProvider,
      tier: "cli" as const,
      status: "succeeded" as const,
      startedAt,
      finishedAt,
    };

    if (outcome.usage.length > 0) {
      for (const u of outcome.usage) {
        await recordExecution({
          ...base,
          model: u.model,
          promptTokens: u.inputTokens,
          completionTokens: u.outputTokens,
          costUsd: u.costUsd,
        });
      }
    } else {
      // Le CLI n'a rien exposé d'exploitable : on garde la trace de l'appel et
      // son coût, sans inventer ni modèle ni tokens.
      await recordExecution({
        ...base,
        model: cli.id,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: outcome.costUsd,
      });
    }

    const changes = await workspaceChanges(ws.path);
    const note = outcome.text.slice(0, NOTE_MAX_CHARS);

    logInfo("cli_agent.step_done", {
      runId: ctx.runId,
      cli: cli.id,
      costUsd: outcome.costUsd,
      truncated: result.truncated,
    });

    return {
      done: true,
      note,
      costUsd: outcome.costUsd,
      artifact: {
        title: `${cli.label} — ${taskCtx.taskTitle}`,
        content: [
          note,
          "",
          `---`,
          `**Workspace** : \`${ws.path}\``,
          "",
          "**Changements** (non commités) :",
          changes ?? "_Workspace hors dépôt git : pas de diff disponible._",
        ].join("\n"),
      },
      // Mémorise la session pour une éventuelle itération suivante.
      meta: { sessionId: outcome.sessionId },
    };
  };

  return {
    stepFn,
    budgetExceeded: async (run) => {
      const taskCtx = await getTaskContext(userId, run.taskId);
      return taskCtx ? projectBudgetExceeded(taskCtx.projectId) : false;
    },
    onNote: async (run, note, meta) => {
      await addMessage(run.taskId, {
        role: "assistant",
        content: note,
        kind: "auto_step",
        data: { runId: run.id, cli: cli.id, sessionId: meta?.sessionId },
      });
    },
    onArtifact: async (run, artifact) => {
      const id = await addArtifact(run.taskId, {
        type: "document",
        title: artifact.title,
        content: artifact.content,
      });
      await addMessage(run.taskId, {
        role: "assistant",
        content: `Artefact produit par \`${cli.id}\` : « ${artifact.title} »`,
        kind: "artifact",
        data: { artifactId: id },
      });
    },
  };
}
