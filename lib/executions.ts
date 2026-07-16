/**
 * Persistance des exécutions d'agents (`agent_executions`) — Milestone 1.
 *
 * C'est la table de vérité du coût réel : chaque appel LLM routé y est
 * journalisé (provider, modèle, tier, tokens, coût, statut). L'écran de suivi
 * budgétaire s'appuie sur ces lignes.
 */
import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Provider, Tier } from "@/lib/models";
import { logWarn } from "@/lib/observability";
import { agentExecutions } from "@/drizzle/schema";

export interface RecordExecutionInput {
  userId: string;
  taskLabel: string;
  provider: Provider;
  model: string;
  tier: Tier;
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
