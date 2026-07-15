"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  generateArchitecture,
  type ProjectType,
} from "@/lib/architect";
import { getDecryptedProviderKeys } from "@/lib/keys";
import { recordExecution } from "@/lib/executions";
import { getCurrentUserId } from "@/lib/users";
import {
  addPhase,
  addTask,
  createProjectFromArchitecture,
  deletePhase,
  deleteProject,
  deleteTask,
  renameProject,
  updatePhase,
  updateTask,
  type PhaseStatus,
  type TaskMode,
  type TaskStatus,
} from "@/lib/projects";

// --- Génération ----------------------------------------------------------

export interface GenerateState {
  ok: boolean;
  message: string;
}

const VALID_TYPES: ReadonlySet<string> = new Set<ProjectType>([
  "tech",
  "marketing",
]);

/**
 * Génère une arborescence à partir d'une idée, la persiste, journalise le coût,
 * puis redirige vers la page du projet. Nécessite au moins une clé frontier.
 */
export async function generateProjectAction(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const idea = String(formData.get("idea") ?? "").trim();
  const rawType = String(formData.get("type") ?? "tech");
  const type = (VALID_TYPES.has(rawType) ? rawType : "tech") as ProjectType;

  if (!idea) return { ok: false, message: "Décris ton idée de projet." };

  const userId = await getCurrentUserId();
  const keys = await getDecryptedProviderKeys(userId);
  if (Object.keys(keys).length === 0) {
    return {
      ok: false,
      message:
        "Aucune clé API enregistrée. Ajoute une clé (Anthropic, OpenAI…) sur la page d'accueil pour générer.",
    };
  }

  let projectId: string;
  const startedAt = new Date();
  try {
    const result = await generateArchitecture(idea, type, keys);
    projectId = await createProjectFromArchitecture(
      userId,
      idea,
      type,
      result.architecture,
    );
    await recordExecution({
      userId,
      taskLabel: `[architecture] ${result.architecture.projectName}`,
      provider: result.spec.provider,
      model: result.spec.modelId,
      tier: "frontier",
      status: "succeeded",
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      startedAt,
      finishedAt: new Date(),
    });
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? `Échec de génération : ${err.message}`
          : "Échec de génération.",
    };
  }

  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}

// --- Édition (form actions simples) -------------------------------------

export async function renameProjectAction(formData: FormData): Promise<void> {
  const id = String(formData.get("projectId") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!id) return;
  const userId = await getCurrentUserId();
  await renameProject(userId, id, name);
  revalidatePath(`/projects/${id}`);
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  const id = String(formData.get("projectId") ?? "");
  if (!id) return;
  const userId = await getCurrentUserId();
  await deleteProject(userId, id);
  revalidatePath("/projects");
  redirect("/projects");
}

export async function addPhaseAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!projectId || !name.trim()) return;
  const userId = await getCurrentUserId();
  await addPhase(userId, projectId, name);
  revalidatePath(`/projects/${projectId}`);
}

export async function deletePhaseAction(formData: FormData): Promise<void> {
  const phaseId = String(formData.get("phaseId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (!phaseId) return;
  const userId = await getCurrentUserId();
  await deletePhase(userId, phaseId);
  revalidatePath(`/projects/${projectId}`);
}

export async function updatePhaseAction(formData: FormData): Promise<void> {
  const phaseId = String(formData.get("phaseId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const name = formData.get("name");
  const status = formData.get("status");
  if (!phaseId) return;
  const userId = await getCurrentUserId();
  await updatePhase(userId, phaseId, {
    name: name !== null ? String(name) : undefined,
    status: status !== null ? (String(status) as PhaseStatus) : undefined,
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function addTaskAction(formData: FormData): Promise<void> {
  const phaseId = String(formData.get("phaseId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "");
  if (!phaseId || !title.trim()) return;
  const userId = await getCurrentUserId();
  await addTask(userId, phaseId, title);
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteTaskAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (!taskId) return;
  const userId = await getCurrentUserId();
  await deleteTask(userId, taskId);
  revalidatePath(`/projects/${projectId}`);
}

export async function updateTaskAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (!taskId) return;
  const title = formData.get("title");
  const status = formData.get("status");
  const mode = formData.get("mode");
  const priority = formData.get("priority");
  const userId = await getCurrentUserId();
  await updateTask(userId, taskId, {
    title: title !== null ? String(title) : undefined,
    status: status !== null ? (String(status) as TaskStatus) : undefined,
    mode: mode !== null ? (String(mode) as TaskMode) : undefined,
    priority: priority !== null ? Number(priority) : undefined,
  });
  revalidatePath(`/projects/${projectId}`);
}
