"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  generateArchitecture,
  refineArchitecture,
  type Architecture,
  type ProjectType,
} from "@/lib/architect";
import { assertWithinBudget } from "@/lib/budgets";
import { getProviderConnections } from "@/lib/keys";
import { recordExecution } from "@/lib/executions";
import {
  associateNorme,
  autoAssociateProjectNorms,
  dissociateNorme,
} from "@/lib/normes";
import { setBudget } from "@/lib/budgets";
import { captureException } from "@/lib/observability";
import { getProfile, profilePreamble } from "@/lib/profile";
import { getCurrentUserId } from "@/lib/users";
import {
  addPhase,
  addTask,
  createProjectFromArchitecture,
  deletePhase,
  deleteProject,
  deleteTask,
  getProjectTree,
  renameProject,
  replaceProjectTree,
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
  const keys = await getProviderConnections(userId);
  if (Object.keys(keys).length === 0) {
    return {
      ok: false,
      message:
        "Aucune clé API enregistrée. Ajoute une clé (Anthropic, OpenAI…) sur la page d'accueil pour générer.",
    };
  }

  const profile = await getProfile(userId);
  let projectId: string;
  const startedAt = new Date();
  try {
    const result = await generateArchitecture(
      idea,
      type,
      keys,
      profilePreamble(profile),
    );
    projectId = await createProjectFromArchitecture(
      userId,
      idea,
      type,
      result.architecture,
    );
    // Auto-association des normes dont la catégorie ↔ type de phase (M5).
    await autoAssociateProjectNorms(userId, projectId);
    // Budget par défaut du profil, si défini.
    if (profile.defaultBudgetUsd && profile.defaultBudgetUsd > 0) {
      await setBudget(userId, projectId, profile.defaultBudgetUsd);
    }
    await recordExecution({
      userId,
      taskLabel: `[architecture] ${result.architecture.projectName}`,
      projectId,
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
    await captureException(err, "architect.failed", { userId, type });
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

// --- Raffinement de l'arborescence ---------------------------------------

export async function refineProjectAction(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const projectId = String(formData.get("projectId") ?? "");
  const constraint = String(formData.get("constraint") ?? "").trim();
  if (!projectId) return { ok: false, message: "Projet manquant." };
  if (!constraint) return { ok: false, message: "Décris la contrainte / le changement." };

  const userId = await getCurrentUserId();
  const tree = await getProjectTree(userId, projectId);
  if (!tree) return { ok: false, message: "Projet introuvable." };

  const keys = await getProviderConnections(userId);
  if (Object.keys(keys).length === 0) {
    return { ok: false, message: "Aucune connexion LLM. Ajoute-en une sur l'accueil." };
  }
  try {
    await assertWithinBudget(projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  const current: Architecture = {
    projectName: tree.name,
    summary: tree.idea ?? "",
    phases: tree.phases.map((ph) => ({
      name: ph.name,
      type: ph.type ?? "",
      tasks: ph.tasks.map((t) => ({
        title: t.title,
        description: t.description ?? "",
        mode: t.mode,
        priority: t.priority,
      })),
    })),
  };

  const profile = await getProfile(userId);
  const startedAt = new Date();
  try {
    const result = await refineArchitecture(
      tree.idea ?? tree.name,
      tree.type as ProjectType,
      current,
      constraint,
      keys,
      profilePreamble(profile),
    );
    await replaceProjectTree(userId, projectId, result.architecture);
    await autoAssociateProjectNorms(userId, projectId);
    await recordExecution({
      userId,
      taskLabel: `[raffinement] ${result.architecture.projectName}`,
      projectId,
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
    await captureException(err, "architect.refine_failed", { userId, projectId });
    return {
      ok: false,
      message: err instanceof Error ? `Échec du raffinement : ${err.message}` : "Échec.",
    };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Arborescence révisée." };
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

// --- Budget projet (M7.3) ------------------------------------------------

export async function setBudgetAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const raw = String(formData.get("limitUsd") ?? "").trim();
  if (!projectId) return;
  const limitUsd = raw === "" ? 0 : Number(raw);
  const userId = await getCurrentUserId();
  await setBudget(userId, projectId, Number.isFinite(limitUsd) ? limitUsd : 0);
  revalidatePath(`/projects/${projectId}`);
}

// --- Association de normes aux phases (M5) -------------------------------

export async function associateNormeAction(formData: FormData): Promise<void> {
  const phaseId = String(formData.get("phaseId") ?? "");
  const normeId = String(formData.get("normeId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (!phaseId || !normeId) return;
  const userId = await getCurrentUserId();
  await associateNorme(userId, phaseId, normeId, false);
  revalidatePath(`/projects/${projectId}`);
}

export async function dissociateNormeAction(formData: FormData): Promise<void> {
  const phaseId = String(formData.get("phaseId") ?? "");
  const normeId = String(formData.get("normeId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  if (!phaseId || !normeId) return;
  const userId = await getCurrentUserId();
  await dissociateNorme(userId, phaseId, normeId);
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
