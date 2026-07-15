/**
 * Persistance et édition des projets (Milestone 2).
 *
 * Transforme une `Architecture` générée en lignes `projects / phases / tasks`,
 * et expose les opérations d'édition manuelle de l'arborescence. Toutes les
 * opérations sont scopées à l'utilisateur (pas de fuite inter-compte).
 */
import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Architecture, ProjectType } from "@/lib/architect";
import { phases, projects, tasks } from "@/drizzle/schema";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskMode = "autonomous" | "cowork" | "manual";
export type PhaseStatus = "pending" | "in_progress" | "done";

// --- Création depuis l'architecte ---------------------------------------

/** Insère projet + phases + tâches de façon transactionnelle. Renvoie l'id projet. */
export async function createProjectFromArchitecture(
  userId: string,
  idea: string,
  type: ProjectType,
  arch: Architecture,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ userId, name: arch.projectName, idea, type })
      .returning({ id: projects.id });

    if (!project) throw new Error("Échec de création du projet.");

    for (let p = 0; p < arch.phases.length; p++) {
      const phase = arch.phases[p]!;
      const [phaseRow] = await tx
        .insert(phases)
        .values({
          projectId: project.id,
          name: phase.name,
          type: phase.type,
          order: p,
        })
        .returning({ id: phases.id });

      if (!phaseRow) throw new Error("Échec de création d'une phase.");

      if (phase.tasks.length > 0) {
        await tx.insert(tasks).values(
          phase.tasks.map((t) => ({
            phaseId: phaseRow.id,
            title: t.title,
            description: t.description,
            mode: t.mode,
            priority: t.priority,
          })),
        );
      }
    }

    return project.id;
  });
}

// --- Lecture -------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  type: string;
  idea: string | null;
  phaseCount: number;
  taskCount: number;
  createdAt: Date;
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      type: projects.type,
      idea: projects.idea,
      createdAt: projects.createdAt,
      phaseCount: sql<number>`count(distinct ${phases.id})::int`,
      taskCount: sql<number>`count(${tasks.id})::int`,
    })
    .from(projects)
    .leftJoin(phases, eq(phases.projectId, projects.id))
    .leftJoin(tasks, eq(tasks.phaseId, phases.id))
    .where(eq(projects.userId, userId))
    .groupBy(projects.id)
    .orderBy(sql`${projects.createdAt} desc`);

  return rows;
}

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  mode: TaskMode;
  priority: number;
}

export interface PhaseView {
  id: string;
  name: string;
  type: string | null;
  order: number;
  status: PhaseStatus;
  tasks: TaskView[];
}

export interface ProjectTree {
  id: string;
  name: string;
  type: string;
  idea: string | null;
  phases: PhaseView[];
}

/** Arborescence complète d'un projet (phases ordonnées + tâches). */
export async function getProjectTree(
  userId: string,
  projectId: string,
): Promise<ProjectTree | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return null;

  const phaseRows = await db
    .select()
    .from(phases)
    .where(eq(phases.projectId, projectId))
    .orderBy(asc(phases.order));

  const taskRows = await db
    .select()
    .from(tasks)
    .where(
      sql`${tasks.phaseId} in (select id from ${phases} where project_id = ${projectId})`,
    )
    .orderBy(asc(tasks.priority));

  const tasksByPhase = new Map<string, TaskView[]>();
  for (const t of taskRows) {
    const arr = tasksByPhase.get(t.phaseId) ?? [];
    arr.push({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status as TaskStatus,
      mode: t.mode as TaskMode,
      priority: t.priority,
    });
    tasksByPhase.set(t.phaseId, arr);
  }

  return {
    id: project.id,
    name: project.name,
    type: project.type,
    idea: project.idea,
    phases: phaseRows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      order: p.order,
      status: p.status as PhaseStatus,
      tasks: tasksByPhase.get(p.id) ?? [],
    })),
  };
}

// --- Garde-fou d'appartenance -------------------------------------------

/** Vérifie qu'un projet appartient à l'utilisateur (pour les mutations). */
async function assertOwnedProject(
  userId: string,
  projectId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Projet introuvable ou non autorisé.");
}

/** Résout l'id projet d'une phase, en vérifiant l'appartenance utilisateur. */
async function projectIdOfPhase(
  userId: string,
  phaseId: string,
): Promise<string> {
  const [row] = await db
    .select({ projectId: phases.projectId })
    .from(phases)
    .innerJoin(projects, eq(projects.id, phases.projectId))
    .where(and(eq(phases.id, phaseId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Phase introuvable ou non autorisée.");
  return row.projectId;
}

// --- Édition : projet ----------------------------------------------------

export async function deleteProject(
  userId: string,
  projectId: string,
): Promise<void> {
  await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
}

export async function renameProject(
  userId: string,
  projectId: string,
  name: string,
): Promise<void> {
  if (!name.trim()) throw new Error("Nom de projet vide.");
  await assertOwnedProject(userId, projectId);
  await db
    .update(projects)
    .set({ name: name.trim() })
    .where(eq(projects.id, projectId));
}

// --- Édition : phases ----------------------------------------------------

export async function addPhase(
  userId: string,
  projectId: string,
  name: string,
): Promise<void> {
  if (!name.trim()) throw new Error("Nom de phase vide.");
  await assertOwnedProject(userId, projectId);
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${phases.order}), -1)::int` })
    .from(phases)
    .where(eq(phases.projectId, projectId));
  await db
    .insert(phases)
    .values({ projectId, name: name.trim(), order: (row?.max ?? -1) + 1 });
}

export async function deletePhase(
  userId: string,
  phaseId: string,
): Promise<void> {
  await projectIdOfPhase(userId, phaseId); // vérifie l'appartenance
  await db.delete(phases).where(eq(phases.id, phaseId));
}

export async function updatePhase(
  userId: string,
  phaseId: string,
  patch: { name?: string; status?: PhaseStatus },
): Promise<void> {
  await projectIdOfPhase(userId, phaseId);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Nom de phase vide.");
    set.name = patch.name.trim();
  }
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) return;
  await db.update(phases).set(set).where(eq(phases.id, phaseId));
}

// --- Édition : tâches ----------------------------------------------------

/** Vérifie qu'une tâche appartient à l'utilisateur (via phase → projet). */
async function assertOwnedTask(userId: string, taskId: string): Promise<void> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(phases, eq(phases.id, tasks.phaseId))
    .innerJoin(projects, eq(projects.id, phases.projectId))
    .where(and(eq(tasks.id, taskId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Tâche introuvable ou non autorisée.");
}

export async function addTask(
  userId: string,
  phaseId: string,
  title: string,
): Promise<void> {
  if (!title.trim()) throw new Error("Titre de tâche vide.");
  await projectIdOfPhase(userId, phaseId);
  await db.insert(tasks).values({ phaseId, title: title.trim() });
}

export async function deleteTask(
  userId: string,
  taskId: string,
): Promise<void> {
  await assertOwnedTask(userId, taskId);
  await db.delete(tasks).where(eq(tasks.id, taskId));
}

export async function updateTask(
  userId: string,
  taskId: string,
  patch: {
    title?: string;
    description?: string;
    status?: TaskStatus;
    mode?: TaskMode;
    priority?: number;
  },
): Promise<void> {
  await assertOwnedTask(userId, taskId);
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error("Titre de tâche vide.");
    set.title = patch.title.trim();
  }
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (Object.keys(set).length === 0) return;
  await db.update(tasks).set(set).where(eq(tasks.id, taskId));
}
