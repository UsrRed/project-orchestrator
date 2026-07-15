/**
 * Fil de discussion par tâche + artefacts (Milestone 3).
 *
 * Couche DB pure : messages, artefacts, contexte de tâche, bascule de mode, et
 * dérivation de l'état de la machine Cowork (point d'arrêt « en attente de
 * choix »). Le checkpoint Cowork est persisté ici, en base — la conversation
 * étant déjà durable, on n'introduit pas LangGraph.js tant qu'un vrai graphe
 * multi-nœuds n'est pas nécessaire (cf. risque #4 du plan).
 */
import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import type { TaskMode } from "@/lib/projects";
import {
  artifacts,
  messages,
  phases,
  projects,
  tasks,
} from "@/drizzle/schema";

// --- Contexte de tâche ---------------------------------------------------

export interface TaskContext {
  taskId: string;
  projectId: string;
  taskTitle: string;
  taskDescription: string | null;
  taskStatus: string;
  taskMode: TaskMode;
  phaseName: string;
  phaseType: string | null;
  projectName: string;
  projectType: string;
  projectIdea: string | null;
}

/** Récupère le contexte complet d'une tâche (scopé utilisateur), ou null. */
export async function getTaskContext(
  userId: string,
  taskId: string,
): Promise<TaskContext | null> {
  const [row] = await db
    .select({
      taskId: tasks.id,
      projectId: projects.id,
      taskTitle: tasks.title,
      taskDescription: tasks.description,
      taskStatus: tasks.status,
      taskMode: tasks.mode,
      phaseName: phases.name,
      phaseType: phases.type,
      projectName: projects.name,
      projectType: projects.type,
      projectIdea: projects.idea,
    })
    .from(tasks)
    .innerJoin(phases, eq(phases.id, tasks.phaseId))
    .innerJoin(projects, eq(projects.id, phases.projectId))
    .where(and(eq(tasks.id, taskId), eq(projects.userId, userId)))
    .limit(1);

  if (!row) return null;
  return { ...row, taskMode: row.taskMode as TaskMode };
}

/** Vérifie l'appartenance d'une tâche (lève sinon). */
export async function assertOwnedTask(
  userId: string,
  taskId: string,
): Promise<void> {
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) throw new Error("Tâche introuvable ou non autorisée.");
}

export async function setTaskMode(
  userId: string,
  taskId: string,
  mode: TaskMode,
): Promise<void> {
  await assertOwnedTask(userId, taskId);
  await db.update(tasks).set({ mode }).where(eq(tasks.id, taskId));
}

// --- Messages ------------------------------------------------------------

export type MessageKind =
  | "text"
  | "cowork_options"
  | "cowork_choice"
  | "artifact"
  | "auto_step";

export interface CoworkOption {
  title: string;
  detail: string;
}
export interface CoworkOptionsData {
  intro: string;
  options: CoworkOption[];
}

export interface MessageView {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  kind: MessageKind;
  data: unknown;
  createdAt: Date;
}

/** Insère un message (l'appelant a déjà vérifié l'appartenance). */
export async function addMessage(
  taskId: string,
  msg: {
    role: MessageView["role"];
    content: string;
    kind?: MessageKind;
    data?: unknown;
  },
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      taskId,
      role: msg.role,
      content: msg.content,
      kind: msg.kind ?? "text",
      data: msg.data ?? null,
    })
    .returning({ id: messages.id });
  if (!row) throw new Error("Échec d'enregistrement du message.");
  return row.id;
}

export async function listMessages(
  userId: string,
  taskId: string,
): Promise<MessageView[]> {
  await assertOwnedTask(userId, taskId);
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({
    id: r.id,
    role: r.role as MessageView["role"],
    content: r.content,
    kind: r.kind as MessageKind,
    data: r.data,
    createdAt: r.createdAt,
  }));
}

// --- Artefacts -----------------------------------------------------------

export type ArtifactType = "document" | "widget" | "diagram";

export interface ArtifactView {
  id: string;
  type: ArtifactType;
  title: string | null;
  content: string | null;
  url: string | null;
  createdAt: Date;
}

export async function addArtifact(
  taskId: string,
  a: { type: ArtifactType; title: string; content: string; url?: string },
): Promise<string> {
  const [row] = await db
    .insert(artifacts)
    .values({
      taskId,
      type: a.type,
      title: a.title,
      content: a.content,
      url: a.url ?? null,
    })
    .returning({ id: artifacts.id });
  if (!row) throw new Error("Échec d'enregistrement de l'artefact.");
  return row.id;
}

export async function listArtifacts(
  userId: string,
  taskId: string,
): Promise<ArtifactView[]> {
  await assertOwnedTask(userId, taskId);
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt));
  return rows.map((r) => ({
    id: r.id,
    type: r.type as ArtifactType,
    title: r.title,
    content: r.content,
    url: r.url,
    createdAt: r.createdAt,
  }));
}

// --- État de la machine Cowork ------------------------------------------

export interface CoworkStatus {
  awaitingChoice: boolean;
  pendingOptions: CoworkOptionsData | null;
  /** Id du message d'options en attente (pour référencer le choix). */
  pendingMessageId: string | null;
}

/**
 * Dérive l'état Cowork depuis le fil : « en attente de choix » si le dernier
 * message de type cowork_options/cowork_choice est une proposition d'options.
 */
export async function getCoworkStatus(
  userId: string,
  taskId: string,
): Promise<CoworkStatus> {
  await assertOwnedTask(userId, taskId);
  // Dernier message pertinent pour la machine Cowork (options ou choix).
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(desc(messages.createdAt));

  const lastRelevant = rows.find(
    (r) => r.kind === "cowork_options" || r.kind === "cowork_choice",
  );

  if (lastRelevant && lastRelevant.kind === "cowork_options") {
    return {
      awaitingChoice: true,
      pendingOptions: lastRelevant.data as CoworkOptionsData,
      pendingMessageId: lastRelevant.id,
    };
  }
  return { awaitingChoice: false, pendingOptions: null, pendingMessageId: null };
}
