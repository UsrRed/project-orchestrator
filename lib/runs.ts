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
import { isCliAgentId, type CliAgentId } from "@/lib/cli-agents";
import { autonomousRuns } from "@/drizzle/schema";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Moteur d'exécution d'un run : routeur LLM, ou agent CLI dans un workspace. */
export type RunEngine = "llm" | "cli";

export interface RunRow {
  id: string;
  userId: string;
  taskId: string;
  goal: string;
  status: RunStatus;
  engine: RunEngine;
  /** Renseigné si et seulement si `engine === "cli"`. */
  engineCli: CliAgentId | null;
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
    engine: r.engine === "cli" ? "cli" : "llm",
    engineCli:
      r.engineCli && isCliAgentId(r.engineCli) ? r.engineCli : null,
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
  engine?: RunEngine;
  engineCli?: string;
  maxIterations?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
}

/**
 * Itérations par défaut selon le moteur.
 *
 * Un agent CLI boucle déjà en interne : une invocation suffit à mener
 * l'objectif au bout. Le moteur `llm`, lui, avance par petites étapes et a
 * besoin de plusieurs passes.
 */
const DEFAULT_MAX_ITERATIONS: Record<RunEngine, number> = { llm: 5, cli: 1 };

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

  const engine: RunEngine = input.engine === "cli" ? "cli" : "llm";
  // Un run `cli` sans CLI valide n'est pas exécutable : on refuse ici plutôt
  // que de laisser le worker échouer après coup.
  if (engine === "cli" && !(input.engineCli && isCliAgentId(input.engineCli))) {
    throw new Error(
      `Moteur CLI invalide : « ${input.engineCli ?? "(aucun)"} ».`,
    );
  }

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
      engine,
      engineCli: engine === "cli" ? (input.engineCli as CliAgentId) : null,
      maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS[engine],
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

export type RunHealth = Record<RunStatus, number> & { total: number };

/** Répartition des runs par statut (observabilité). */
export async function runHealth(userId: string): Promise<RunHealth> {
  const rows = await db
    .select({
      status: autonomousRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(autonomousRuns)
    .where(eq(autonomousRuns.userId, userId))
    .groupBy(autonomousRuns.status);

  const health: RunHealth = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  };
  for (const r of rows) {
    health[r.status as RunStatus] = r.count;
    health.total += r.count;
  }
  return health;
}

/** Derniers runs de l'utilisateur (tous statuts confondus). */
export async function listRecentRuns(
  userId: string,
  limit = 10,
): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(autonomousRuns)
    .where(eq(autonomousRuns.userId, userId))
    .orderBy(desc(autonomousRuns.createdAt))
    .limit(limit);
  return rows.map(mapRow);
}
