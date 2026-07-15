/**
 * Queue durable des runs autonomes (Milestone 4).
 *
 * La table `autonomous_runs` EST la queue : les lignes `queued` sont réclamées
 * atomiquement par un worker via `FOR UPDATE SKIP LOCKED` (plusieurs workers
 * possibles sans double traitement), et les runs `running` dont le verrou est
 * périmé (worker mort) sont repris. La progression (coût, itérations) est
 * persistée à CHAQUE étape → garde-fous vérifiables en continu, reprise après
 * crash.
 */
import "server-only";

import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { autonomousRuns } from "@/drizzle/schema";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunRow {
  id: string;
  userId: string;
  taskId: string;
  goal: string;
  status: RunStatus;
  maxIterations: number;
  maxCostUsd: number;
  timeoutAt: Date | null;
  killRequested: boolean;
  iterations: number;
  spentUsd: number;
  lockedAt: Date | null;
  stopReason: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

function mapRow(r: typeof autonomousRuns.$inferSelect): RunRow {
  return {
    id: r.id,
    userId: r.userId,
    taskId: r.taskId,
    goal: r.goal,
    status: r.status as RunStatus,
    maxIterations: r.maxIterations,
    maxCostUsd: Number(r.maxCostUsd),
    timeoutAt: r.timeoutAt,
    killRequested: r.killRequested,
    iterations: r.iterations,
    spentUsd: Number(r.spentUsd),
    lockedAt: r.lockedAt,
    stopReason: r.stopReason,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
  };
}

export interface EnqueueInput {
  goal: string;
  maxIterations?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
}

/** Place un run en file (statut `queued`). L'appartenance de la tâche doit être
 *  vérifiée par l'appelant (action). */
export async function enqueueRun(
  userId: string,
  taskId: string,
  input: EnqueueInput,
  now: Date = new Date(),
): Promise<string> {
  const goal = input.goal.trim();
  if (!goal) throw new Error("Objectif du run vide.");

  const timeoutAt =
    input.timeoutMs && input.timeoutMs > 0
      ? new Date(now.getTime() + input.timeoutMs)
      : null;

  const [row] = await db
    .insert(autonomousRuns)
    .values({
      userId,
      taskId,
      goal,
      maxIterations: input.maxIterations ?? 5,
      maxCostUsd: (input.maxCostUsd ?? 0.5).toFixed(6),
      timeoutAt,
    })
    .returning({ id: autonomousRuns.id });
  if (!row) throw new Error("Échec de mise en file du run.");
  return row.id;
}

/**
 * Réclame atomiquement le prochain run à traiter : soit `queued`, soit
 * `running` dont le verrou est périmé (reprise après crash). Passe le run en
 * `running` et pose le verrou. Renvoie null si la file est vide.
 */
export async function claimNextRun(
  now: Date = new Date(),
  staleLockMs = 60_000,
): Promise<RunRow | null> {
  const staleBefore = new Date(now.getTime() - staleLockMs);

  // Transaction : on verrouille une ligne candidate (queued, ou running dont le
  // verrou est périmé) avec SKIP LOCKED — deux workers concurrents ne peuvent
  // pas réclamer le même run — puis on la passe en running.
  return db.transaction(async (tx) => {
    const [picked] = await tx
      .select()
      .from(autonomousRuns)
      .where(
        or(
          eq(autonomousRuns.status, "queued"),
          and(
            eq(autonomousRuns.status, "running"),
            or(
              sql`${autonomousRuns.lockedAt} is null`,
              lt(autonomousRuns.lockedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(autonomousRuns.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!picked) return null;

    const [updated] = await tx
      .update(autonomousRuns)
      .set({
        status: "running",
        lockedAt: now,
        startedAt: picked.startedAt ?? now,
      })
      .where(eq(autonomousRuns.id, picked.id))
      .returning();

    return updated ? mapRow(updated) : null;
  });
}

/** Renvoie l'état frais d'un run (le worker le relit à chaque itération). */
export async function getRunFresh(runId: string): Promise<RunRow | null> {
  const [r] = await db
    .select()
    .from(autonomousRuns)
    .where(eq(autonomousRuns.id, runId))
    .limit(1);
  return r ? mapRow(r) : null;
}

/** Ajoute le coût/incrémente l'itération après une étape (progression durable). */
export async function recordIteration(
  runId: string,
  costDeltaUsd: number,
): Promise<void> {
  await db
    .update(autonomousRuns)
    .set({
      iterations: sql`${autonomousRuns.iterations} + 1`,
      spentUsd: sql`${autonomousRuns.spentUsd} + ${costDeltaUsd.toFixed(6)}`,
      lockedAt: sql`now()`,
    })
    .where(eq(autonomousRuns.id, runId));
}

/** Termine un run (succès ou arrêt par garde-fou). */
export async function finishRun(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  stopReason: string,
  error?: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(autonomousRuns)
    .set({ status, stopReason, error: error ?? null, finishedAt: now })
    .where(eq(autonomousRuns.id, runId));
}

// --- Contrôle utilisateur ------------------------------------------------

/** Kill switch : demande l'arrêt. Le worker le constate à l'itération suivante. */
export async function requestKill(
  userId: string,
  runId: string,
): Promise<void> {
  await db
    .update(autonomousRuns)
    .set({ killRequested: true })
    .where(
      and(eq(autonomousRuns.id, runId), eq(autonomousRuns.userId, userId)),
    );
}

export async function getRun(
  userId: string,
  runId: string,
): Promise<RunRow | null> {
  const [r] = await db
    .select()
    .from(autonomousRuns)
    .where(
      and(eq(autonomousRuns.id, runId), eq(autonomousRuns.userId, userId)),
    )
    .limit(1);
  return r ? mapRow(r) : null;
}

export async function listRunsForTask(
  userId: string,
  taskId: string,
): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(autonomousRuns)
    .where(
      and(
        eq(autonomousRuns.taskId, taskId),
        eq(autonomousRuns.userId, userId),
      ),
    )
    .orderBy(desc(autonomousRuns.createdAt));
  return rows.map(mapRow);
}
