/**
 * Boucle du worker autonome — le point d'entrée unique de la queue.
 *
 * Existe pour que la file se vide **toute seule** : la boucle est démarrée par
 * `instrumentation.ts` dans le process Next (`npm run dev`, `npm start`), si
 * bien qu'un run mis en file part sans que personne lance quoi que ce soit.
 * `npm run worker` reste disponible et exécute exactement ce code — c'est le
 * même module, pas une seconde implémentation à garder alignée.
 *
 * Enchaînement pour chaque run :
 *   claim → **planification** (niveau + limites + source) → deps du moteur →
 *   `processRun` (garde-fous à chaque étape).
 *
 * La planification a lieu **ici et pas à la mise en file** : c'est un appel LLM,
 * et le faire dans l'action serveur ferait attendre le formulaire pour un
 * travail que la queue est justement là pour absorber.
 */
import "server-only";

import { makeCliAgentDeps } from "@/lib/cli-agent";
import { addMessage, getTaskContext } from "@/lib/conversation";
import { captureException, logInfo } from "@/lib/observability";
import {
  applyPlan,
  claimNextRun,
  finishRun,
  getRunFresh,
  touchRun,
  type RunRow,
} from "@/lib/runs";
import { processRun, type WorkerDeps } from "@/lib/worker";

/**
 * Un run dont les limites sont posées. C'est ce que la boucle d'itérations attend.
 */
type PreparedRun = RunRow & { maxIterations: number };

/** L'unique source d'exécution depuis le passage en « Claude uniquement ». */
const SOURCE_LABEL = "Claude Code (abonnement)";

/**
 * Limites par défaut de l'agent Claude Code : il boucle déjà en interne, une
 * invocation suffit — mais elle dure des minutes, pas des secondes.
 */
const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_TIMEOUT_MIN = 30;

/**
 * Période du battement de verrou. Doit rester largement sous les 60 s de
 * `staleLockMs` (cf. `claimNextRun`) pour qu'un battement raté ne suffise pas à
 * faire passer le run pour abandonné.
 */
const HEARTBEAT_MS = 20_000;

/**
 * Pose les limites du run et arme son timeout.
 *
 * Plus de planification par IA ni de routage : un seul moteur (l'agent Claude
 * Code), une seule source (l'abonnement). On ne fait que compléter les limites
 * que l'utilisateur n'a pas imposées. Renvoie `null` si le run a été terminé en
 * échec — l'appelant n'a alors rien à exécuter.
 */
async function prepareRun(run: RunRow): Promise<PreparedRun | null> {
  const fail = async (message: string): Promise<null> => {
    await addMessage(run.taskId, {
      role: "assistant",
      content: message,
      // Surtout pas `auto_step` : le moteur relit ces messages-là comme la
      // progression du run et les imiterait.
      kind: "auto_notice",
    });
    await finishRun(run.id, "failed", "error", message);
    return null;
  };

  const taskCtx = await getTaskContext(run.userId, run.taskId);
  if (!taskCtx) return fail("Tâche introuvable : run abandonné.");

  const imposed = run.maxIterations !== null || run.timeoutMin !== null;
  const maxIterations = run.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMin = run.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
  const planReason = imposed
    ? "Limites imposées par l'utilisateur."
    : "Limites par défaut de l'agent Claude Code.";

  await applyPlan(run.id, {
    planReason,
    sourceLabel: SOURCE_LABEL,
    maxIterations,
    timeoutMin,
  });

  await addMessage(run.taskId, {
    role: "assistant",
    content:
      `Plan du run — ${maxIterations} itération(s) max, ${timeoutMin} min max. ` +
      `Source : ${SOURCE_LABEL}. ${planReason}`,
    kind: "auto_plan",
  });

  const fresh = await getRunFresh(run.id);
  if (!fresh || fresh.maxIterations === null) {
    return fail("La préparation du run n'a pas pu être enregistrée.");
  }
  return fresh as PreparedRun;
}

/** Dépendances d'exécution : toujours l'agent Claude Code, sur l'abonnement. */
function depsFor(run: PreparedRun): WorkerDeps {
  return makeCliAgentDeps(run.userId, "claude");
}

/**
 * Réclame, planifie et exécute le prochain run. Renvoie `false` si la file est
 * vide (l'appelant peut alors attendre).
 */
export async function processNextQueuedRun(): Promise<boolean> {
  const claimed = await claimNextRun(new Date());
  if (!claimed) return false;

  // Le verrou doit battre pendant TOUT le traitement : la planification puis
  // l'étape peuvent dépasser `staleLockMs` à elles seules (un agent CLI tourne
  // plusieurs minutes), et un verrou périmé ferait reprendre le run par un autre
  // worker alors qu'il tourne encore.
  const heartbeat = setInterval(() => {
    void touchRun(claimed.id).catch(() => {
      // Un battement raté n'est pas fatal : le suivant réessaie. Faire échouer
      // le run pour ça serait pire que le risque qu'on couvre.
    });
  }, HEARTBEAT_MS);

  try {
    const prepared = await prepareRun(claimed);
    if (!prepared) return true;

    const final = await processRun(prepared, depsFor(prepared));
    logInfo("worker.run_done", {
      runId: final.id,
      status: final.status,
      stopReason: final.stopReason,
      iterations: final.iterations,
      spentUsd: final.spentUsd,
      source: final.sourceLabel,
    });
  } catch (err) {
    await finishRun(
      claimed.id,
      "failed",
      "error",
      err instanceof Error ? err.message : String(err),
    );
    await captureException(err, "worker.run_error", { runId: claimed.id });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

// --- Boucle -------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Garde de singleton : `instrumentation.register()` ne s'exécute qu'une fois par
 * process, mais le rechargement de modules en dev peut réévaluer ce fichier.
 * Deux boucles ne corrompraient rien (le claim est atomique) mais doubleraient
 * le polling pour rien.
 */
let running = false;

export interface WorkerLoopHandle {
  stop(): void;
}

/**
 * Démarre la boucle de polling. Idempotent : un second appel ne fait rien.
 *
 * Ne rejette jamais : une erreur de queue (base indisponible au démarrage,
 * typiquement) est journalisée et retentée au tick suivant. Le worker vit dans
 * le process du serveur web — le faire tomber pour ça couperait le site.
 */
export function startWorkerLoop(): WorkerLoopHandle {
  if (running) return { stop: () => {} };
  running = true;

  void (async () => {
    logInfo("worker.started", { pollIntervalMs: POLL_INTERVAL_MS });
    while (running) {
      try {
        const worked = await processNextQueuedRun();
        if (!worked) await sleep(POLL_INTERVAL_MS);
      } catch (err) {
        await captureException(err, "worker.loop_error", {});
        await sleep(POLL_INTERVAL_MS);
      }
    }
    logInfo("worker.stopped", {});
  })();

  return {
    stop: () => {
      running = false;
    },
  };
}
