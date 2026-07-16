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
import {
  earliestSampleSince,
  sampleClaudeUsage,
  type ClaudeLimit,
} from "@/lib/claude-usage";
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
  /** Quota d'abonnement Claude de la machine (null si non relevable). */
  claude: ClaudeQuota | null;
}

/** Une limite d'abonnement, avec son évolution depuis le début de la fenêtre. */
export interface ClaudeQuotaLimit extends ClaudeLimit {
  /**
   * Points de pourcentage consommés depuis le relevé « avant ». null si aucun
   * point de comparaison (première ouverture, limite apparue depuis).
   */
  deltaPoints: number | null;
}

export interface ClaudeQuota {
  limits: ClaudeQuotaLimit[];
  capturedAt: Date;
  /** Instant du relevé « avant ». null si on n'a qu'un seul relevé. */
  comparedTo: Date | null;
  /** Des agents tournaient-ils au moment du relevé « avant » ? */
  agentsActiveBefore: boolean;
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

  // Après `listActiveRuns` : le relevé horodate le nombre d'agents actifs, ce
  // qui est ce qui distingue « pendant » de « au repos ».
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "queued",
  ).length;
  const claude = await claudeQuota(activeRuns, since, now);

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
    claude,
  };
}

/**
 * Relève le quota et le compare au plus ancien relevé de la fenêtre — le
 * « avant » face au « maintenant ».
 *
 * Le delta est en **points de pourcentage**, pas en pourcentage relatif :
 * passer de 6 % à 8 % consomme 2 points de quota, pas « +33 % ».
 */
async function claudeQuota(
  activeRuns: number,
  since: Date,
  now: Date,
): Promise<ClaudeQuota | null> {
  const current = await sampleClaudeUsage(activeRuns, now);
  if (!current) return null;

  const before = await earliestSampleSince(since);
  // Le plus ancien relevé de la fenêtre PEUT être le relevé courant : il n'y a
  // alors rien à comparer, et afficher un delta de 0 laisserait croire à une
  // consommation nulle plutôt qu'à une absence de mesure.
  const comparable =
    before && before.capturedAt.getTime() < current.capturedAt.getTime()
      ? before
      : null;

  return {
    capturedAt: current.capturedAt,
    comparedTo: comparable?.capturedAt ?? null,
    agentsActiveBefore: (comparable?.activeRuns ?? 0) > 0,
    limits: current.limits.map((l) => {
      const prev = comparable?.limits.find((p) => p.key === l.key);
      return {
        ...l,
        deltaPoints: prev ? l.percentUsed - prev.percentUsed : null,
      };
    }),
  };
}

function tokenTotals(stats: ExecutionStats): LiveSnapshot["tokens"] {
  return {
    prompt: stats.totalPromptTokens,
    completion: stats.totalCompletionTokens,
    total: stats.totalPromptTokens + stats.totalCompletionTokens,
  };
}
