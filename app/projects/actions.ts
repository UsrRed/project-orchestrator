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
import {
  canManageRepos,
  createUserRepo,
  getGitHubAccess,
  getRepo,
  parseRepoInput,
  repoUrlFor,
  slugifyRepoName,
} from "@/lib/github";
import { recordClaudeExecution } from "@/lib/executions";
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
  LOCAL_REPO,
  type PhaseStatus,
  type ProjectRepo,
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

// --- Rattachement Git du projet ------------------------------------------

/** Choix offert à la création : lier un dépôt, en créer un, ou rester local. */
type RepoChoice = "link" | "create" | "local";

const VALID_REPO_CHOICES: ReadonlySet<string> = new Set<RepoChoice>([
  "link",
  "create",
  "local",
]);

/**
 * Résout le rattachement Git demandé dans le formulaire : valide le dépôt à
 * lier, ou **crée** le dépôt (privé sauf demande explicite) sur le compte
 * GitHub de l'utilisateur. Appelé AVANT la génération pour échouer tôt, sans
 * dépenser de tokens. Lève une erreur au message affichable.
 */
async function resolveRepoChoice(
  userId: string,
  formData: FormData,
  idea: string,
): Promise<ProjectRepo> {
  const raw = String(formData.get("repoChoice") ?? "local");
  const choice = (VALID_REPO_CHOICES.has(raw) ? raw : "local") as RepoChoice;
  if (choice === "local") return LOCAL_REPO;

  const access = await getGitHubAccess(userId);

  if (choice === "link") {
    const fullName = parseRepoInput(String(formData.get("repoInput") ?? ""));
    if (!fullName) {
      throw new Error(
        "Dépôt invalide. Attendu : une URL GitHub ou « proprietaire/depot ».",
      );
    }
    // Avec le scope `repo` on vérifie l'existence et la visibilité réelle ;
    // sinon on enregistre le lien tel quel, en supposant le dépôt privé (on ne
    // prétend pas public ce qu'on n'a pas pu vérifier).
    if (access && canManageRepos(access)) {
      const repo = await getRepo(access.token, fullName);
      return { mode: "github", fullName: repo.fullName, url: repo.url, private: repo.private };
    }
    return {
      mode: "github",
      fullName,
      url: repoUrlFor(fullName),
      private: true,
    };
  }

  // choice === "create"
  if (!access) {
    throw new Error(
      "Aucun compte GitHub lié. Connecte-toi via GitHub pour créer un dépôt.",
    );
  }
  if (!canManageRepos(access)) {
    throw new Error(
      "Ton accès GitHub ne couvre pas la gestion des dépôts. Déconnecte-toi puis reconnecte-toi pour accorder l'accès, ou lie un dépôt existant par son URL.",
    );
  }

  const name = slugifyRepoName(
    String(formData.get("repoName") ?? "").trim() || idea,
  );
  const isPrivate = String(formData.get("repoVisibility") ?? "private") !== "public";
  const repo = await createUserRepo(access.token, name, {
    private: isPrivate,
    description: idea,
  });
  return {
    mode: "github",
    fullName: repo.fullName,
    url: repo.url,
    private: repo.private,
  };
}

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

  // Dépôt d'abord : une erreur ici (URL invalide, accès manquant) doit revenir
  // dans le formulaire sans avoir dépensé un seul token.
  let repo: ProjectRepo;
  try {
    repo = await resolveRepoChoice(userId, formData, idea);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Rattachement Git impossible.",
    };
  }

  const profile = await getProfile(userId);
  let projectId: string;
  const startedAt = new Date();
  try {
    const result = await generateArchitecture(
      idea,
      type,
      profilePreamble(profile),
    );
    projectId = await createProjectFromArchitecture(
      userId,
      idea,
      type,
      result.architecture,
      repo,
    );
    // Auto-association des normes dont la catégorie ↔ type de phase (M5).
    await autoAssociateProjectNorms(userId, projectId);
    // Plafond de tokens par défaut du profil, si défini.
    if (profile.defaultBudgetTokens && profile.defaultBudgetTokens > 0) {
      await setBudget(userId, projectId, profile.defaultBudgetTokens);
    }
    await recordClaudeExecution(
      {
        userId,
        taskLabel: `[architecture] ${result.architecture.projectName}`,
        projectId,
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
      },
      result.usage,
      result.costUsd,
    );
  } catch (err) {
    await captureException(err, "architect.failed", { userId, type });
    const base =
      err instanceof Error
        ? `Échec de génération : ${err.message}`
        : "Échec de génération.";
    // Le dépôt a pu être créé juste avant : le dire plutôt que laisser
    // l'utilisateur découvrir un dépôt orphelin sur son compte.
    const created = repo.mode === "github" && repo.fullName;
    return {
      ok: false,
      message: created
        ? `${base} (Le dépôt ${repo.fullName} est en place — relance la génération, il sera réutilisé en le liant.)`
        : base,
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
      profilePreamble(profile),
    );
    await replaceProjectTree(userId, projectId, result.architecture);
    await autoAssociateProjectNorms(userId, projectId);
    await recordClaudeExecution(
      {
        userId,
        taskLabel: `[raffinement] ${result.architecture.projectName}`,
        projectId,
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
      },
      result.usage,
      result.costUsd,
    );
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
  const raw = String(formData.get("limitTokens") ?? "").trim();
  if (!projectId) return;
  const limitTokens = raw === "" ? 0 : Number(raw);
  const userId = await getCurrentUserId();
  await setBudget(userId, projectId, Number.isFinite(limitTokens) ? limitTokens : 0);
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
