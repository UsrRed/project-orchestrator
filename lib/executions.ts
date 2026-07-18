/**
 * Persistance des exécutions d'agents (`agent_executions`) — Milestone 1.
 *
 * C'est la table de vérité du coût réel : chaque appel LLM routé y est
 * journalisé (provider, modèle, tier, tokens, coût, statut). L'écran de suivi
 * budgétaire s'appuie sur ces lignes.
 */
import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { CliModelUsage } from "@/lib/cli-agents";
import { logWarn } from "@/lib/observability";
import { agentExecutions } from "@/drizzle/schema";

/**
 * Provider journalisé dans `agent_executions`.
 *
 * Depuis le passage en « Claude uniquement », le code n'écrit plus que
 * `claude_cli` (agent Claude Code sur abonnement). Les autres valeurs subsistent
 * pour **lire l'historique** : la colonne est passée en `text` (migration 0016),
 * les anciennes lignes gardent leur libellé lisible (`anthropic`, `ollama`…).
 */
export type ExecProvider =
  | "claude_cli"
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "opencode"
  | "groq"
  | "ollama"
  | "gemini_cli"
  | "opencode_cli";

/**
 * Tier journalisé. `"cli"` : un agent CLI choisit son propre modèle, l'app ne le
 * route pas. `fast`/`frontier` restent pour lire l'historique du routeur retiré.
 */
export type ExecTier = "fast" | "frontier" | "cli";

export interface RecordExecutionInput {
  userId: string;
  taskLabel: string;
  provider: ExecProvider;
  model: string;
  tier: ExecTier;
  status: "succeeded" | "failed";
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  /** Rattachement au projet (suivi budgétaire) et à la tâche, si connus. */
  projectId?: string;
  taskId?: string;
}

/** Journalise une exécution terminée (succès ou échec). */
export async function recordExecution(
  input: RecordExecutionInput,
): Promise<void> {
  await db.insert(agentExecutions).values({
    userId: input.userId,
    taskLabel: input.taskLabel,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    provider: input.provider,
    model: input.model,
    tier: input.tier,
    mode: "manual",
    status: input.status,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    // numeric() est mappé en string par postgres.js : on formate proprement.
    costUsd: input.costUsd.toFixed(6),
    error: input.error ?? null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });

  if (input.status === "failed") {
    logWarn("execution.failed", {
      userId: input.userId,
      projectId: input.projectId,
      provider: input.provider,
      model: input.model,
      tier: input.tier,
      label: input.taskLabel,
      error: input.error,
    });
  }
}

/** Métadonnées communes d'un appel Claude synchrone à journaliser. */
export interface ClaudeExecutionBase {
  userId: string;
  taskLabel: string;
  status: "succeeded" | "failed";
  startedAt: Date;
  finishedAt: Date;
  projectId?: string;
  taskId?: string;
  error?: string;
}

/**
 * Journalise un appel `claude -p` synchrone (architecture, chat, widget…) —
 * **une ligne par modèle**, comme le moteur `cli` ([cli-agent.ts](cli-agent.ts)) :
 * une invocation traverse souvent plusieurs modèles, et agréger perdrait la
 * ventilation qu'affiche le HUD. Si le CLI n'a rien ventilé, une seule ligne
 * `model:"claude"` porte le coût, sans inventer de modèle ni de tokens.
 */
export async function recordClaudeExecution(
  base: ClaudeExecutionBase,
  usage: CliModelUsage[],
  costUsd: number,
): Promise<void> {
  const common = { ...base, provider: "claude_cli" as const, tier: "cli" as const };
  if (usage.length > 0) {
    for (const u of usage) {
      await recordExecution({
        ...common,
        model: u.model,
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        costUsd: u.costUsd,
      });
    }
  } else {
    await recordExecution({
      ...common,
      model: "claude",
      promptTokens: 0,
      completionTokens: 0,
      costUsd,
    });
  }
}

/** Coût total réel dépensé sur un projet (somme des exécutions). */
export async function projectSpendUsd(projectId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${agentExecutions.costUsd}), 0)`,
    })
    .from(agentExecutions)
    .where(eq(agentExecutions.projectId, projectId));
  return Number(row?.total ?? 0);
}

export interface ExecutionView {
  id: string;
  taskLabel: string | null;
  provider: string;
  model: string;
  tier: string | null;
  status: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  createdAt: Date;
}

/** Historique récent des exécutions d'un utilisateur. */
export async function listExecutions(
  userId: string,
  limit = 20,
): Promise<ExecutionView[]> {
  const rows = await db
    .select()
    .from(agentExecutions)
    .where(eq(agentExecutions.userId, userId))
    .orderBy(desc(agentExecutions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    taskLabel: r.taskLabel,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    status: r.status,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    costUsd: Number(r.costUsd),
    createdAt: r.createdAt,
  }));
}

export interface ExecutionHealth {
  total: number;
  failed: number;
  succeeded: number;
  failureRate: number;
  totalCostUsd: number;
}

/** Santé des exécutions : total, échecs, taux d'échec, coût. */
export async function executionHealth(
  userId: string,
): Promise<ExecutionHealth> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${agentExecutions.status} = 'failed')::int`,
      succeeded: sql<number>`count(*) filter (where ${agentExecutions.status} = 'succeeded')::int`,
      totalCostUsd: sql<string>`coalesce(sum(${agentExecutions.costUsd}), 0)`,
    })
    .from(agentExecutions)
    .where(eq(agentExecutions.userId, userId));

  const total = row?.total ?? 0;
  const failed = row?.failed ?? 0;
  return {
    total,
    failed,
    succeeded: row?.succeeded ?? 0,
    failureRate: total > 0 ? failed / total : 0,
    totalCostUsd: Number(row?.totalCostUsd ?? 0),
  };
}

/**
 * Consommation sur une fenêtre récente (tokens, coût, nombre d'appels).
 *
 * Le total cumulé ne bouge presque plus une fois le compte ancien : c'est ce
 * delta glissant qui montre ce que les agents consomment *en ce moment*.
 */
export async function executionUsageSince(
  userId: string,
  since: Date,
): Promise<{ tokens: number; costUsd: number; count: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${agentExecutions.promptTokens} + ${agentExecutions.completionTokens}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${agentExecutions.costUsd}), 0)`,
    })
    .from(agentExecutions)
    .where(
      and(
        eq(agentExecutions.userId, userId),
        gte(agentExecutions.createdAt, since),
      ),
    );

  return {
    count: row?.count ?? 0,
    tokens: row?.tokens ?? 0,
    costUsd: Number(row?.costUsd ?? 0),
  };
}

export interface ModelUsageRow {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  costUsd: number;
  count: number;
}

/**
 * Consommation ventilée par (provider, modèle) — la lecture « qui consomme
 * quoi ». `provider` distingue les appels API (`anthropic`, `openai`…) des
 * agents CLI (`claude_cli`…) ; deux façons très différentes de payer.
 *
 * `since` borne la fenêtre (live) ; omis → tout l'historique (global).
 */
export async function usageByModel(
  userId: string,
  since?: Date,
): Promise<ModelUsageRow[]> {
  const rows = await db
    .select({
      provider: agentExecutions.provider,
      model: agentExecutions.model,
      promptTokens: sql<number>`coalesce(sum(${agentExecutions.promptTokens}), 0)::int`,
      completionTokens: sql<number>`coalesce(sum(${agentExecutions.completionTokens}), 0)::int`,
      costUsd: sql<string>`coalesce(sum(${agentExecutions.costUsd}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(agentExecutions)
    .where(
      since
        ? and(
            eq(agentExecutions.userId, userId),
            gte(agentExecutions.createdAt, since),
          )
        : eq(agentExecutions.userId, userId),
    )
    .groupBy(agentExecutions.provider, agentExecutions.model)
    .orderBy(
      desc(
        sql`sum(${agentExecutions.promptTokens} + ${agentExecutions.completionTokens})`,
      ),
    );

  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    tokens: r.promptTokens + r.completionTokens,
    costUsd: Number(r.costUsd),
    count: r.count,
  }));
}

/** Dernières exécutions en échec (observabilité). */
export async function listFailedExecutions(
  userId: string,
  limit = 10,
): Promise<ExecutionView[]> {
  const rows = await db
    .select()
    .from(agentExecutions)
    .where(
      sql`${agentExecutions.userId} = ${userId} and ${agentExecutions.status} = 'failed'`,
    )
    .orderBy(desc(agentExecutions.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    taskLabel: r.taskLabel,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    status: r.status,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    costUsd: Number(r.costUsd),
    createdAt: r.createdAt,
  }));
}

export interface ExecutionStats {
  count: number;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/** Agrégats de coût (suivi de l'optimisation financière). */
export async function executionStats(userId: string): Promise<ExecutionStats> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalCostUsd: sql<string>`coalesce(sum(${agentExecutions.costUsd}), 0)`,
      totalPromptTokens: sql<number>`coalesce(sum(${agentExecutions.promptTokens}), 0)::int`,
      totalCompletionTokens: sql<number>`coalesce(sum(${agentExecutions.completionTokens}), 0)::int`,
    })
    .from(agentExecutions)
    .where(eq(agentExecutions.userId, userId));

  return {
    count: row?.count ?? 0,
    totalCostUsd: Number(row?.totalCostUsd ?? 0),
    totalPromptTokens: row?.totalPromptTokens ?? 0,
    totalCompletionTokens: row?.totalCompletionTokens ?? 0,
  };
}
