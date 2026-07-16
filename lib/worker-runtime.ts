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

import { makeAutonomousDeps } from "@/lib/autonomous-agent";
import { makeCliAgentDeps } from "@/lib/cli-agent";
import { cliAgentInfo, isCliAgentId } from "@/lib/cli-agents";
import { addMessage, getTaskContext } from "@/lib/conversation";
import { getProviderConnections } from "@/lib/keys";
import { estimateTokens } from "@/lib/llm-router";
import { getProfile } from "@/lib/profile";
import { captureException, logInfo } from "@/lib/observability";
import {
  noSourceMessage,
  planRun,
  resolveSource,
  type RunPlan,
} from "@/lib/run-planner";
import {
  applyPlan,
  claimNextRun,
  finishRun,
  getRunFresh,
  touchRun,
  type RunRow,
} from "@/lib/runs";
import type { SourceKind } from "@/lib/sources";
import { processRun, type WorkerDeps } from "@/lib/worker";

/**
 * Un run déjà planifié : `engine` est résolu, les limites sont posées. C'est ce
 * que la boucle d'itérations attend.
 */
type PreparedRun = RunRow & { maxIterations: number };

/**
 * Facteur appliqué à l'objectif pour estimer le contexte que le modèle devra
 * tenir. L'objectif n'est qu'une fraction du prompt réel : s'y ajoutent le
 * système, les normes de la phase, les notes des itérations précédentes et
 * l'artefact produit. Sous-estimer élirait un modèle trop étroit, qui
 * tronquerait sa propre progression au fil des étapes.
 */
const CONTEXT_HEADROOM = 4;

/**
 * Période du battement de verrou. Doit rester largement sous les 60 s de
 * `staleLockMs` (cf. `claimNextRun`) pour qu'un battement raté ne suffise pas à
 * faire passer le run pour abandonné.
 */
const HEARTBEAT_MS = 20_000;

/**
 * Planifie un run réclamé et fige son plan en base.
 *
 * Respecte ce que l'utilisateur a imposé : un moteur choisi à la main n'est pas
 * re-routé, une limite saisie n'est pas réestimée. L'IA ne comble que les trous.
 * Renvoie `null` si le run a été terminé en échec (aucune source utilisable) —
 * l'appelant n'a alors rien à exécuter.
 */
async function prepareRun(run: RunRow): Promise<PreparedRun | null> {
  const fail = async (message: string): Promise<null> => {
    await addMessage(run.taskId, {
      role: "assistant",
      content: message,
      // Surtout pas `auto_step` : les moteurs relisent ces messages-là comme la
      // progression du run et les imiteraient.
      kind: "auto_notice",
    });
    await finishRun(run.id, "failed", "error", message);
    return null;
  };

  const taskCtx = await getTaskContext(run.userId, run.taskId);
  if (!taskCtx) return fail("Tâche introuvable : run abandonné.");

  const keys = await getProviderConnections(run.userId);
  const profile = await getProfile(run.userId);

  // Le moteur imposé change la forme des limites (un CLI boucle en interne),
  // donc la planification doit le connaître avant d'estimer.
  const forcedCli = run.engine === "cli";
  const plan: RunPlan = await planRun(
    {
      goal: run.goal,
      taskTitle: taskCtx.taskTitle,
      projectName: taskCtx.projectName,
      projectType: taskCtx.projectType,
      cliEngine: forcedCli,
    },
    keys,
  );

  // Routage dynamique : seulement si l'utilisateur n'a pas choisi lui-même.
  let engine: "llm" | "cli" = forcedCli ? "cli" : "llm";
  let engineCli: string | null = run.engineCli;
  // Un moteur imposé n'est pas issu du routage : on ne lui invente pas de
  // source. `paid` serait faux sur un run à plafond 0, et `subscription` ne dit
  // rien du modèle qu'un CLI choisira lui-même.
  let sourceKind: SourceKind | null = forcedCli ? "subscription" : null;
  let sourceLabel = forcedCli
    ? `Abonnement — ${cliAgentInfo(run.engineCli ?? "")?.label ?? run.engineCli}`
    : "Routeur LLM (imposé)";

  if (run.engine === "auto") {
    const resolved = resolveSource({
      level: plan.level,
      keys,
      order: profile.sourceOrder,
      maxCostUsd: run.maxCostUsd,
      minContext: Math.ceil(estimateTokens(run.goal) * CONTEXT_HEADROOM),
    });
    if (!resolved) return fail(noSourceMessage(plan.level, run.maxCostUsd));
    engine = resolved.engine;
    engineCli = resolved.engineCli ?? null;
    sourceKind = resolved.kind;
    sourceLabel = resolved.label;
  }

  // Le moteur peut avoir basculé vers un CLI après estimation : ses limites ne
  // sont pas celles d'une boucle `llm`.
  const cliNow = engine === "cli";
  const maxIterations = run.maxIterations ?? (cliNow ? 1 : plan.maxIterations);
  const timeoutMin =
    run.timeoutMin ?? Math.max(plan.timeoutMin, cliNow ? 30 : 1);

  await applyPlan(run.id, {
    engine,
    engineCli,
    plannedLevel: plan.level,
    planReason: plan.reason,
    planner: plan.planner,
    sourceKind,
    sourceLabel,
    maxIterations,
    timeoutMin,
  });

  await addMessage(run.taskId, {
    role: "assistant",
    content:
      `Plan du run — niveau ${plan.level} requis, ${maxIterations} itération(s) max, ` +
      `${timeoutMin} min max. Source : ${sourceLabel}. ${plan.reason}` +
      (plan.planner === "heuristic"
        ? " (estimation par défaut : aucun modèle gratuit n'était disponible pour évaluer.)"
        : ""),
    kind: "auto_plan",
  });

  const fresh = await getRunFresh(run.id);
  if (!fresh || fresh.maxIterations === null) {
    return fail("La planification du run n'a pas pu être enregistrée.");
  }
  return fresh as PreparedRun;
}

/** Construit les dépendances d'exécution du moteur résolu. */
async function depsFor(run: PreparedRun): Promise<WorkerDeps | null> {
  if (run.engine === "cli" && run.engineCli && isCliAgentId(run.engineCli)) {
    // Un run `cli` n'a besoin d'aucune clé LLM : l'agent CLI s'authentifie avec
    // son propre login.
    return makeCliAgentDeps(run.userId, run.engineCli);
  }
  const keys = await getProviderConnections(run.userId);
  if (Object.keys(keys).length === 0) {
    await finishRun(
      run.id,
      "failed",
      "error",
      "Aucune clé API disponible pour exécuter ce run.",
    );
    return null;
  }
  return makeAutonomousDeps(run.userId, keys, {
    boost: run.boost,
    minLevel: run.plannedLevel ?? undefined,
    // Le plafond à 0 est une contrainte de sélection, pas seulement un
    // garde-fou : sans ça le routeur élirait un payant et le run s'arrêterait
    // au premier centime, après l'avoir dépensé.
    freeOnly: run.maxCostUsd <= 0,
    restrictTo: run.sourceKind === "local" ? ["ollama"] : undefined,
  });
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

    const deps = await depsFor(prepared);
    if (!deps) return true;

    const final = await processRun(prepared, deps);
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
