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
  saveDraft,
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
   * Livrable **complet** dans son état actuel, à conserver pour l'itération
   * suivante. Persisté sur le run et resservi tel quel : c'est le plan de
   * travail de l'agent, sans quoi il n'a que sa note de 1-2 phrases pour se
   * souvenir de ce qu'il produit.
   *
   * Sans objet pour un moteur qui écrit ailleurs (le `cli` a son workspace).
   */
  draft?: StepArtifact;
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
  /**
   * Persistance d'un artefact produit. `salvaged` → le run a été coupé par un
   * garde-fou et c'est le livrable **en l'état**, pas un travail achevé : à ne
   * pas présenter comme tel.
   */
  onArtifact?: (
    run: RunRow,
    artifact: StepArtifact,
    opts?: { salvaged?: boolean },
  ) => Promise<void>;
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

  /**
   * Termine le run — et **sauve d'abord le livrable en cours** si l'arrêt n'est
   * pas un succès.
   *
   * Un garde-fou qui coupe (itérations épuisées, timeout, plafond, kill) coupait
   * aussi le travail déjà produit : le brouillon mourait avec le run, et
   * l'utilisateur ne récupérait rien de ce qu'il avait payé en temps de calcul.
   * Le statut reste un échec — le run n'a pas convergé, et le dire est utile —
   * mais l'artefact, lui, est conservé.
   *
   * Point de passage unique : tous les chemins d'arrêt passent ici, sinon il
   * suffit d'en oublier un pour reperdre le brouillon.
   */
  const stop = async (reason: StopReason, error?: string): Promise<void> => {
    if (reason !== "completed") {
      const run = await getRunFresh(runId);
      if (run?.draft && deps.onArtifact) {
        await deps.onArtifact(run, run.draft, { salvaged: true });
      }
    }
    await finishRun(runId, TERMINAL[reason], reason, error, now());
  };

  // Boucle bornée par maxIterations (garantit la terminaison même si stepFn
  // ne renvoie jamais done et qu'aucun autre garde-fou ne se déclenche).
  for (;;) {
    const fresh = await getRunFresh(runId);
    if (!fresh) break;

    const preStop = guardStop(fresh, now());
    if (preStop) {
      await stop(
        preStop,
        preStop === "error"
          ? "Run démarré sans limites : la planification n'a pas eu lieu."
          : undefined,
      );
      break;
    }
    if (deps.budgetExceeded && (await deps.budgetExceeded(fresh))) {
      await stop("project_budget");
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
      await stop("error", err instanceof Error ? err.message : String(err));
      break;
    }

    // Avant la note et le comptage : c'est le travail lui-même. Une étape qui
    // avance le livrable puis meurt sur un incident doit tout de même le laisser
    // derrière elle.
    if (result.draft) await saveDraft(runId, result.draft);

    if (result.note && deps.onNote) {
      await deps.onNote(fresh, result.note, result.meta);
    }
    await recordIteration(runId, result.costUsd);
    if (result.artifact && deps.onArtifact) {
      await deps.onArtifact(fresh, result.artifact);
    }

    if (result.done) {
      await stop("completed");
      break;
    }

    // Garde-fous re-vérifiés APRÈS accumulation du coût/itération : on ne
    // dépasse jamais le plafond silencieusement.
    const after = await getRunFresh(runId);
    if (after) {
      const postStop = guardStop(after, now());
      if (postStop) {
        await stop(postStop);
        break;
      }
      if (deps.budgetExceeded && (await deps.budgetExceeded(after))) {
        await stop("project_budget");
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
