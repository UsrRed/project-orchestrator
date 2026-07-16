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
import type { IntelligenceLevel } from "@/lib/intelligence";
import type { SourceKind } from "@/lib/sources";
import { autonomousRuns } from "@/drizzle/schema";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * Moteur d'exécution d'un run.
 *
 * `auto` est le défaut et n'est pas un moteur : c'est l'absence de choix, que le
 * worker résout en `llm` ou `cli` à la planification, d'après le niveau estimé
 * de la tâche et l'ordre de sources du profil. Il ne subsiste jamais sur un run
 * démarré.
 */
export type RunEngine = "auto" | "llm" | "cli";

/** Moteur réellement exécutable (ce que `auto` devient une fois résolu). */
export type ResolvedRunEngine = Exclude<RunEngine, "auto">;

export interface RunRow {
  id: string;
  userId: string;
  taskId: string;
  goal: string;
  status: RunStatus;
  engine: RunEngine;
  /** Renseigné si et seulement si `engine === "cli"`. */
  engineCli: CliAgentId | null;
  /** Router vers le plus capable plutôt que le moins cher (moteur `llm`). */
  boost: boolean;
  /** Niveau requis estimé (0-4). Null tant que le run n'est pas planifié. */
  plannedLevel: IntelligenceLevel | null;
  planReason: string | null;
  planner: "ai" | "heuristic" | null;
  sourceKind: SourceKind | null;
  sourceLabel: string | null;
  /** Null = à estimer par l'IA ; une valeur = imposée par l'utilisateur. */
  maxIterations: number | null;
  /** 0 = gratuit/abonnement uniquement (défaut), pas « plafond atteint ». */
  maxCostUsd: number;
  timeoutMin: number | null;
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

function mapEngine(v: string): RunEngine {
  return v === "cli" || v === "auto" ? v : "llm";
}

function mapRow(r: typeof autonomousRuns.$inferSelect): RunRow {
  return {
    id: r.id,
    userId: r.userId,
    taskId: r.taskId,
    goal: r.goal,
    status: r.status as RunStatus,
    engine: mapEngine(r.engine),
    engineCli:
      r.engineCli && isCliAgentId(r.engineCli) ? r.engineCli : null,
    boost: r.boost,
    plannedLevel:
      r.plannedLevel === null ? null : (r.plannedLevel as IntelligenceLevel),
    planReason: r.planReason,
    planner:
      r.planner === "ai" || r.planner === "heuristic" ? r.planner : null,
    sourceKind: (r.sourceKind as SourceKind) ?? null,
    sourceLabel: r.sourceLabel,
    maxIterations: r.maxIterations,
    maxCostUsd: Number(r.maxCostUsd),
    timeoutMin: r.timeoutMin,
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
  /** Défaut `auto` : le worker choisira la source d'après le niveau estimé. */
  engine?: RunEngine;
  engineCli?: string;
  boost?: boolean;
  /** `undefined`/`null` → estimé par l'IA à la planification. */
  maxIterations?: number | null;
  /** Défaut 0 : gratuit/abonnement uniquement. */
  maxCostUsd?: number;
  /** `undefined`/`null` → estimé par l'IA. `timeoutAt` en découle au démarrage. */
  timeoutMin?: number | null;
}

/**
 * Place un run en file (statut `queued`). L'appartenance de la tâche doit être
 * vérifiée par l'appelant (action).
 *
 * Ne décide plus ni du moteur ni des limites : un run part avec ce que
 * l'utilisateur a **explicitement** imposé, le reste reste `null` et sera
 * planifié par le worker ([run-planner.ts](run-planner.ts)). C'est ce qui rend
 * la mise en file instantanée — aucun appel LLM ne bloque le formulaire.
 */
export async function enqueueRun(
  userId: string,
  taskId: string,
  input: EnqueueInput,
): Promise<string> {
  const goal = input.goal.trim();
  if (!goal) throw new Error("Objectif du run vide.");

  const engine: RunEngine = input.engine ?? "auto";
  // Un run `cli` sans CLI valide n'est pas exécutable : on refuse ici plutôt
  // que de laisser le worker échouer après coup.
  if (engine === "cli" && !(input.engineCli && isCliAgentId(input.engineCli))) {
    throw new Error(
      `Moteur CLI invalide : « ${input.engineCli ?? "(aucun)"} ».`,
    );
  }

  const [row] = await db
    .insert(autonomousRuns)
    .values({
      userId,
      taskId,
      goal,
      engine,
      engineCli: engine === "cli" ? (input.engineCli as CliAgentId) : null,
      // Sans objet pour un agent CLI, qui choisit son modèle lui-même.
      boost: engine === "llm" && Boolean(input.boost),
      maxIterations: input.maxIterations ?? null,
      maxCostUsd: Math.max(input.maxCostUsd ?? 0, 0).toFixed(6),
      timeoutMin: input.timeoutMin ?? null,
    })
    .returning({ id: autonomousRuns.id });
  if (!row) throw new Error("Échec de mise en file du run.");
  return row.id;
}

/** Ce que la planification a décidé, à écrire sur le run avant sa 1re étape. */
export interface RunPlanPatch {
  engine: ResolvedRunEngine;
  engineCli?: string | null;
  plannedLevel: IntelligenceLevel;
  planReason: string;
  planner: "ai" | "heuristic";
  /** `null` quand l'utilisateur a imposé le moteur : rien n'a été « routé ». */
  sourceKind?: SourceKind | null;
  sourceLabel: string;
  maxIterations: number;
  timeoutMin: number;
}

/**
 * Fige le plan sur le run et arme le timeout.
 *
 * `timeoutAt` est calculé **ici**, au démarrage réel, et non à la mise en file :
 * un run peut attendre des heures dans la queue, et un timeout qui court pendant
 * l'attente tuerait le run avant sa première étape.
 */
export async function applyPlan(
  runId: string,
  patch: RunPlanPatch,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(autonomousRuns)
    .set({
      engine: patch.engine,
      engineCli: patch.engineCli ?? null,
      plannedLevel: patch.plannedLevel,
      planReason: patch.planReason,
      planner: patch.planner,
      sourceKind: patch.sourceKind ?? null,
      sourceLabel: patch.sourceLabel,
      maxIterations: patch.maxIterations,
      timeoutMin: patch.timeoutMin,
      timeoutAt: new Date(now.getTime() + patch.timeoutMin * 60_000),
    })
    .where(eq(autonomousRuns.id, runId));
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

/**
 * Rafraîchit le verrou d'un run en cours (heartbeat).
 *
 * `claimNextRun` considère un run `running` dont le verrou dépasse `staleLockMs`
 * comme abandonné par un worker mort, et le reprend. Or `recordIteration` ne
 * repousse le verrou qu'entre deux étapes : une étape longue — un agent CLI
 * travaille en minutes — laisserait le verrou pourrir et un second worker
 * relancerait le même run **en parallèle**, écrivant deux fois dans le même
 * workspace. D'où ce battement pendant l'étape elle-même.
 */
export async function touchRun(runId: string): Promise<void> {
  await db
    .update(autonomousRuns)
    .set({ lockedAt: sql`now()` })
    .where(eq(autonomousRuns.id, runId));
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

/**
 * Runs en cours ou en file — ce qui « tourne » du point de vue de
 * l'utilisateur. Les plus récemment lancés d'abord.
 */
export async function listActiveRuns(userId: string): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(autonomousRuns)
    .where(
      and(
        eq(autonomousRuns.userId, userId),
        or(
          eq(autonomousRuns.status, "queued"),
          eq(autonomousRuns.status, "running"),
        ),
      ),
    )
    .orderBy(desc(autonomousRuns.createdAt));
  return rows.map(mapRow);
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
