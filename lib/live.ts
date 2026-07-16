/**
 * Instantané « live » de l'activité des agents.
 *
 * Alimente le HUD flottant ([live-hud.tsx](../components/live-hud.tsx)), qui le
 * réinterroge en boucle : tout ce qui est ici doit rester bon marché (quelques
 * agrégats indexés, pas de jointure large) et se lire d'un coup d'œil.
 */
import "server-only";

import {
  executionStats,
  executionUsageSince,
  usageByModel,
  type ExecutionStats,
  type ModelUsageRow,
} from "@/lib/executions";
import { listActiveRuns, type RunStatus } from "@/lib/runs";

/** Fenêtre du delta « en ce moment ». */
const RECENT_WINDOW_MS = 60 * 60 * 1000;

export interface LiveAgent {
  id: string;
  taskId: string;
  goal: string;
  status: RunStatus;
  /** `llm`, ou l'identifiant du CLI (`claude`, `gemini`…) pour un run CLI. */
  engine: string;
  boost: boolean;
  iterations: number;
  maxIterations: number;
  spentUsd: number;
  maxCostUsd: number;
  /** Millisecondes écoulées depuis le démarrage ; null si encore en file. */
  elapsedMs: number | null;
}

export interface LiveSnapshot {
  running: number;
  queued: number;
  agents: LiveAgent[];
  tokens: { prompt: number; completion: number; total: number };
  costUsd: number;
  executions: { total: number };
  /** Consommation sur la dernière heure. */
  recent: { tokens: number; costUsd: number; count: number; windowMs: number };
  /** Ventilation par (provider, modèle) : global, et sur la fenêtre live. */
  byModel: { global: ModelUsageRow[]; recent: ModelUsageRow[] };
}

export async function liveSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<LiveSnapshot> {
  const since = new Date(now.getTime() - RECENT_WINDOW_MS);
  const [runs, stats, recent, byModelGlobal, byModelRecent] = await Promise.all([
    listActiveRuns(userId),
    executionStats(userId),
    executionUsageSince(userId, since),
    usageByModel(userId),
    usageByModel(userId, since),
  ]);

  return {
    running: runs.filter((r) => r.status === "running").length,
    queued: runs.filter((r) => r.status === "queued").length,
    agents: runs.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      goal: r.goal,
      status: r.status,
      engine: r.engine === "cli" ? (r.engineCli ?? "cli") : "llm",
      boost: r.boost,
      iterations: r.iterations,
      maxIterations: r.maxIterations,
      spentUsd: r.spentUsd,
      maxCostUsd: r.maxCostUsd,
      elapsedMs: r.startedAt ? now.getTime() - r.startedAt.getTime() : null,
    })),
    tokens: tokenTotals(stats),
    costUsd: stats.totalCostUsd,
    executions: { total: stats.count },
    recent: { ...recent, windowMs: RECENT_WINDOW_MS },
    byModel: { global: byModelGlobal, recent: byModelRecent },
  };
}

function tokenTotals(stats: ExecutionStats): LiveSnapshot["tokens"] {
  return {
    prompt: stats.totalPromptTokens,
    completion: stats.totalCompletionTokens,
    total: stats.totalPromptTokens + stats.totalCompletionTokens,
  };
}
