/**
 * Exécuteur de runs autonomes (Milestone 4).
 *
 * Boucle d'itérations avec garde-fous vérifiés à CHAQUE étape (cf. risque #6 du
 * plan : plafond de coût vérifié en continu, pas seulement en fin de run) :
 *  - kill switch (arrêt utilisateur) ;
 *  - nombre maximal d'itérations ;
 *  - plafond de coût (avant ET après accumulation) ;
 *  - timeout mural.
 *
 * La fonction d'étape (`stepFn`) et l'horloge (`now`) sont injectées → toute la
 * mécanique de queue/garde-fous est testable sans appel LLM réel.
 */
import {
  claimNextRun,
  finishRun,
  getRunFresh,
  recordIteration,
  type RunRow,
} from "@/lib/runs";
import { captureException, logInfo } from "@/lib/observability";

export interface StepContext {
  runId: string;
  taskId: string;
  userId: string;
  goal: string;
  iteration: number;
}

export interface StepArtifact {
  title: string;
  content: string;
}

export interface StepResult {
  /** true → l'agent estime le but atteint (arrêt en succès). */
  done: boolean;
  /** Note de progression (persistée dans le fil de la tâche). */
  note: string;
  /** Coût réel de l'étape (accumulé et comparé au plafond). */
  costUsd: number;
  /** Artefact éventuel produit à cette étape. */
  artifact?: StepArtifact;
  /**
   * Données libres transmises telles quelles à `onNote`, pour ce qu'une étape
   * doit se rappeler d'une itération à l'autre (le moteur `cli` y range
   * l'identifiant de session à reprendre). Volontairement opaque : la boucle
   * n'a pas à connaître les moteurs.
   */
  meta?: Record<string, unknown>;
}

export type StepFn = (
  ctx: StepContext,
  run: RunRow,
) => Promise<StepResult>;

export interface WorkerDeps {
  stepFn: StepFn;
  /** Persistance d'une note d'étape (ex: message dans le fil). */
  onNote?: (
    run: RunRow,
    note: string,
    meta?: Record<string, unknown>,
  ) => Promise<void>;
  /** Persistance d'un artefact produit. */
  onArtifact?: (run: RunRow, artifact: StepArtifact) => Promise<void>;
  /** Garde-fou budget projet : true → arrêt (raison project_budget). */
  budgetExceeded?: (run: RunRow) => Promise<boolean>;
  now?: () => Date;
}

type StopReason =
  | "completed"
  | "budget"
  | "project_budget"
  | "iterations"
  | "timeout"
  | "killed"
  | "error";

/**
 * Évalue les garde-fous d'arrêt ; renvoie la raison ou null pour continuer.
 *
 * Le plafond de coût se lit en deux régimes, et les confondre était le bug qui
 * rendait « 0 » inutilisable : **0 ne veut pas dire « plafond atteint »**, il
 * veut dire « ce run ne doit rien coûter » (local/abonnement/gratuit). On
 * n'arrête donc que si une dépense apparaît malgré tout — ce qui ne devrait
 * jamais arriver, la source ayant été choisie gratuite, mais un run qui se met
 * à facturer en silence est exactement ce que ce garde-fou doit attraper.
 *
 * `maxIterations` peut être null (run pas encore planifié) : la boucle ne
 * tourne qu'après `applyPlan`, mais on ne se fie pas à cet ordre pour terminer.
 */
function guardStop(run: RunRow, now: Date): StopReason | null {
  if (run.killRequested) return "killed";
  if (run.maxIterations === null) return "error";
  if (run.iterations >= run.maxIterations) return "iterations";
  const overBudget =
    run.maxCostUsd > 0 ? run.spentUsd >= run.maxCostUsd : run.spentUsd > 0;
  if (overBudget) return "budget";
  if (run.timeoutAt && now.getTime() > run.timeoutAt.getTime()) return "timeout";
  return null;
}

const TERMINAL: Record<StopReason, "succeeded" | "failed" | "cancelled"> = {
  completed: "succeeded",
  budget: "failed",
  project_budget: "failed",
  iterations: "failed",
  timeout: "failed",
  killed: "cancelled",
  error: "failed",
};

/** Exécute un run déjà réclamé jusqu'à son terme. Renvoie l'état final. */
export async function processRun(
  claimed: RunRow,
  deps: WorkerDeps,
): Promise<RunRow> {
  const now = deps.now ?? (() => new Date());
  const runId = claimed.id;

  // Boucle bornée par maxIterations (garantit la terminaison même si stepFn
  // ne renvoie jamais done et qu'aucun autre garde-fou ne se déclenche).
  for (;;) {
    const fresh = await getRunFresh(runId);
    if (!fresh) break;

    const preStop = guardStop(fresh, now());
    if (preStop) {
      await finishRun(
        runId,
        TERMINAL[preStop],
        preStop,
        preStop === "error"
          ? "Run démarré sans limites : la planification n'a pas eu lieu."
          : undefined,
        now(),
      );
      break;
    }
    if (deps.budgetExceeded && (await deps.budgetExceeded(fresh))) {
      await finishRun(runId, "failed", "project_budget", undefined, now());
      break;
    }

    let result: StepResult;
    try {
      result = await deps.stepFn(
        {
          runId,
          taskId: fresh.taskId,
          userId: fresh.userId,
          goal: fresh.goal,
          iteration: fresh.iterations,
        },
        fresh,
      );
    } catch (err) {
      await captureException(err, "run.step_failed", {
        runId,
        taskId: fresh.taskId,
        iteration: fresh.iterations,
      });
      await finishRun(
        runId,
        "failed",
        "error",
        err instanceof Error ? err.message : String(err),
        now(),
      );
      break;
    }

    if (result.note && deps.onNote) {
      await deps.onNote(fresh, result.note, result.meta);
    }
    await recordIteration(runId, result.costUsd);
    if (result.artifact && deps.onArtifact) {
      await deps.onArtifact(fresh, result.artifact);
    }

    if (result.done) {
      await finishRun(runId, "succeeded", "completed", undefined, now());
      break;
    }

    // Garde-fous re-vérifiés APRÈS accumulation du coût/itération : on ne
    // dépasse jamais le plafond silencieusement.
    const after = await getRunFresh(runId);
    if (after) {
      const postStop = guardStop(after, now());
      if (postStop) {
        await finishRun(runId, TERMINAL[postStop], postStop, undefined, now());
        break;
      }
      if (deps.budgetExceeded && (await deps.budgetExceeded(after))) {
        await finishRun(runId, "failed", "project_budget", undefined, now());
        break;
      }
    }
  }

  const done = (await getRunFresh(runId)) as RunRow;
  logInfo("run.finished", {
    runId,
    status: done.status,
    stopReason: done.stopReason,
    iterations: done.iterations,
    spentUsd: done.spentUsd,
  });
  return done;
}

/** Réclame et traite le prochain run de la file. Renvoie null si file vide. */
export async function processNextRun(
  deps: WorkerDeps,
): Promise<RunRow | null> {
  const now = deps.now ?? (() => new Date());
  const claimed = await claimNextRun(now());
  if (!claimed) return null;
  return processRun(claimed, deps);
}
