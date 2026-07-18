"use server";

import { revalidatePath } from "next/cache";

import {
  manualReply,
  produceCoworkArtifact,
  proposeCoworkOptions,
  suggestPrompts,
  type ClaudeMeta,
  type HistoryMessage,
  type PromptSuggestion,
} from "@/lib/agent";
import {
  addArtifact,
  addMessage,
  getCoworkStatus,
  getTaskContext,
  listArtifacts,
  listMessages,
  setTaskMode,
} from "@/lib/conversation";
import { cliAgentStatuses } from "@/lib/cli-availability";
import { recordClaudeExecution } from "@/lib/executions";
import { assertWithinBudget } from "@/lib/budgets";
import { buildPhaseNormsContext } from "@/lib/normes";
import { enqueueRun, requestKill } from "@/lib/runs";
import { generateWidget, visualizeResults } from "@/lib/widgets";
import { getCurrentUserId } from "@/lib/users";
import type { TaskMode } from "@/lib/projects";

export interface ChatState {
  ok: boolean;
  message: string;
}

/** Historique aplati pour l'agent (les options Cowork deviennent du texte). */
async function buildHistory(
  userId: string,
  taskId: string,
): Promise<HistoryMessage[]> {
  const msgs = await listMessages(userId, taskId);
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

async function record(
  userId: string,
  label: string,
  meta: ClaudeMeta,
  status: "succeeded" | "failed",
  startedAt: Date,
  link: { projectId: string; taskId: string },
  error?: string,
): Promise<void> {
  await recordClaudeExecution(
    {
      userId,
      taskLabel: label,
      projectId: link.projectId,
      taskId: link.taskId,
      status,
      startedAt,
      finishedAt: new Date(),
      error,
    },
    meta.usage,
    meta.costUsd,
  );
}

const VALID_MODES: ReadonlySet<string> = new Set<TaskMode>([
  "manual",
  "cowork",
  "autonomous",
]);

/** Bascule le mode d'exécution de la tâche. */
export async function setModeAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get("taskId") ?? "");
  const mode = String(formData.get("mode") ?? "");
  if (!taskId || !VALID_MODES.has(mode)) return;
  const userId = await getCurrentUserId();
  await setTaskMode(userId, taskId, mode as TaskMode);
  revalidatePath(`/tasks/${taskId}`);
}

/**
 * Envoie un message. En mode Manuel : réponse directe. En mode Cowork :
 * l'agent propose des options et s'arrête (point d'arrêt).
 */
export async function sendMessageAction(
  _prev: ChatState,
  formData: FormData,
): Promise<ChatState> {
  const taskId = String(formData.get("taskId") ?? "");
  const text = String(formData.get("message") ?? "").trim();
  if (!taskId) return { ok: false, message: "Tâche manquante." };
  if (!text) return { ok: false, message: "Message vide." };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  await addMessage(taskId, { role: "user", content: text });
  const history = await buildHistory(userId, taskId);
  const norms = await buildPhaseNormsContext(userId, ctx.phaseId);
  const startedAt = new Date();

  try {
    if (ctx.taskMode === "cowork") {
      const res = await proposeCoworkOptions(ctx, history, norms.text);
      const rendered =
        res.data.intro +
        "\n\n" +
        res.data.options
          .map((o, i) => `${i + 1}. ${o.title} — ${o.detail}`)
          .join("\n");
      await addMessage(taskId, {
        role: "assistant",
        content: rendered,
        kind: "cowork_options",
        data: res.data,
      });
      await record(userId, `[cowork:options] ${ctx.taskTitle}`, res, "succeeded", startedAt, { projectId: ctx.projectId, taskId });
    } else {
      const res = await manualReply(ctx, history, norms.text);
      await addMessage(taskId, { role: "assistant", content: res.text });
      await record(userId, `[manuel] ${ctx.taskTitle}`, res, "succeeded", startedAt, { projectId: ctx.projectId, taskId });
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur de l'agent.",
    };
  }

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true, message: "" };
}

// --- Widgets « generative UI » (M6) --------------------------------------

export interface WidgetFormState {
  ok: boolean;
  message: string;
}

/** Génère un widget structuré (schéma Zod fixe) et le sauvegarde en Artifact. */
export async function generateWidgetAction(
  _prev: WidgetFormState,
  formData: FormData,
): Promise<WidgetFormState> {
  const taskId = String(formData.get("taskId") ?? "");
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (!taskId) return { ok: false, message: "Tâche manquante." };
  if (!instruction) return { ok: false, message: "Décris le widget voulu." };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  const startedAt = new Date();
  try {
    const res = await generateWidget(instruction, ctx);
    await addArtifact(taskId, {
      type: "widget",
      title: res.widget.title,
      content: JSON.stringify(res.widget),
    });
    await record(
      userId,
      `[widget] ${res.widget.title}`,
      { usage: res.usage, costUsd: res.costUsd },
      "succeeded",
      startedAt,
      { projectId: ctx.projectId, taskId },
    );
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Échec de génération.",
    };
  }

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true, message: "Widget généré et sauvegardé." };
}

// --- Suggestions de prompts (à la demande, éphémères) --------------------

export interface SuggestState {
  ok: boolean;
  message: string;
  suggestions: PromptSuggestion[];
}

/**
 * Génère des suggestions de prompts adaptées au mode + à l'étape. Éphémère :
 * renvoyées dans le state (rendues en puces cliquables), jamais persistées — ce
 * ne sont pas des messages. Pas de `revalidatePath` : rien n'a changé en base.
 */
export async function suggestPromptsAction(
  _prev: SuggestState,
  formData: FormData,
): Promise<SuggestState> {
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return { ok: false, message: "Tâche manquante.", suggestions: [] };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable.", suggestions: [] };

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Budget dépassé.",
      suggestions: [],
    };
  }

  const history = await buildHistory(userId, taskId);
  const norms = await buildPhaseNormsContext(userId, ctx.phaseId);
  const startedAt = new Date();
  try {
    const res = await suggestPrompts(
      ctx,
      ctx.taskMode as TaskMode,
      history,
      norms.text,
    );
    await record(
      userId,
      `[suggestions] ${ctx.taskTitle}`,
      res,
      "succeeded",
      startedAt,
      { projectId: ctx.projectId, taskId },
    );
    return { ok: true, message: "", suggestions: res.suggestions };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Échec des suggestions.",
      suggestions: [],
    };
  }
}

// --- Visualisation des résultats (à la demande) --------------------------

export interface VisualizeState {
  ok: boolean;
  message: string;
}

/** Rassemble le contenu récent (artefacts documents + réponses de l'agent). */
async function buildVisualizeSource(
  userId: string,
  taskId: string,
): Promise<string> {
  const [msgs, arts] = await Promise.all([
    listMessages(userId, taskId),
    listArtifacts(userId, taskId),
  ]);
  const artPart = arts
    .filter((a) => a.type !== "widget")
    .slice(0, 3)
    .map((a) => `${a.title ?? "Artefact"}\n${a.content}`)
    .join("\n\n");
  const msgPart = msgs
    .filter((m) => m.role === "assistant" && m.kind !== "cowork_options")
    .slice(-8)
    .map((m) => m.content)
    .join("\n\n");
  return [artPart, msgPart].filter(Boolean).join("\n\n");
}

/**
 * Met en forme les résultats déjà produits en 1 à 3 widgets, ajoutés aux
 * artefacts. C'est la « partie visualisation », déclenchée à la main en
 * Manuel/Cowork (en Autonome, le worker le fait tout seul).
 */
export async function visualizeResultsAction(
  _prev: VisualizeState,
  formData: FormData,
): Promise<VisualizeState> {
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return { ok: false, message: "Tâche manquante." };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  const sourceText = await buildVisualizeSource(userId, taskId);
  if (!sourceText.trim()) {
    return { ok: false, message: "Rien à visualiser pour l'instant." };
  }

  const norms = await buildPhaseNormsContext(userId, ctx.phaseId);
  const startedAt = new Date();
  let added = 0;
  try {
    const res = await visualizeResults(ctx, sourceText, norms.text);
    for (const w of res.widgets) {
      await addArtifact(taskId, {
        type: "widget",
        title: w.title,
        content: JSON.stringify(w),
      });
      added++;
    }
    await record(
      userId,
      `[visualisation] ${ctx.taskTitle}`,
      { usage: res.usage, costUsd: res.costUsd },
      "succeeded",
      startedAt,
      { projectId: ctx.projectId, taskId },
    );
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Échec de la visualisation.",
    };
  }

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true, message: `${added} widget(s) ajouté(s) au tableau de bord.` };
}

// --- Mode Autonome : lancement / arrêt d'un run --------------------------

export interface RunFormState {
  ok: boolean;
  message: string;
}

/**
 * Champ numérique optionnel : `null` quand l'utilisateur n'a rien imposé (le
 * planificateur décidera). Distinguer « vide » de « 0 » compte ici — 0 est une
 * valeur signifiante pour le plafond.
 */
function optionalNumber(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Met un run autonome en file. Le worker le prend en charge tout seul (cf.
 * [worker-runtime.ts](../../../lib/worker-runtime.ts)) : plus rien à lancer.
 *
 * Un seul moteur désormais : l'agent Claude Code, qui travaille dans le
 * workspace du projet sur l'abonnement de la machine. L'utilisateur ne donne que
 * l'objectif ; sans « Limites », les bornes restent `null` et le worker les
 * estime.
 */
export async function startRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const taskId = String(formData.get("taskId") ?? "");
  const goal = String(formData.get("goal") ?? "").trim();

  // Case « avancée » repliée par défaut : ses champs ne comptent que si ouverte.
  const customLimits = formData.get("customLimits") === "on";
  const rawIterations = customLimits
    ? optionalNumber(formData.get("maxIterations"))
    : null;
  const rawTimeout = customLimits
    ? optionalNumber(formData.get("timeoutMin"))
    : null;
  const maxIterations =
    rawIterations === null ? null : clamp(rawIterations, 1, 20);
  const timeoutMin = rawTimeout === null ? null : clamp(rawTimeout, 1, 120);

  // Plafond de tokens du run (réglage avancé). 0 (le défaut) = illimité :
  // l'abonnement Claude est gratuit au token, il n'y a rien à « ne pas dépenser ».
  const rawMaxTokens = customLimits
    ? optionalNumber(formData.get("maxTokens"))
    : null;
  const maxTokens =
    rawMaxTokens === null ? 0 : clamp(rawMaxTokens, 0, 100_000_000);

  if (!taskId) return { ok: false, message: "Décris l'objectif du run." };
  if (!goal) return { ok: false, message: "Décris l'objectif du run." };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  // Tout dépend de Claude Code, installé et authentifié sur la machine du worker.
  const claude = cliAgentStatuses().find((s) => s.id === "claude");
  if (!claude?.available) {
    return {
      ok: false,
      message:
        claude?.warning ??
        "Claude Code (`claude`) n'est pas disponible sur la machine du worker.",
    };
  }

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  await enqueueRun(userId, taskId, {
    goal,
    maxIterations,
    maxTokens,
    timeoutMin,
  });
  revalidatePath(`/tasks/${taskId}`);
  return {
    ok: true,
    message:
      "Run lancé. Claude Code exécute la tâche — suis la progression ci-dessous.",
  };
}

/** Kill switch : demande l'arrêt d'un run en cours. */
export async function killRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!runId) return;
  const userId = await getCurrentUserId();
  await requestKill(userId, runId);
  revalidatePath(`/tasks/${taskId}`);
}

/**
 * Reprise Cowork : l'utilisateur choisit une option → l'agent produit un
 * Artifact, sauvegardé et ajouté au fil.
 */
export async function chooseOptionAction(
  _prev: ChatState,
  formData: FormData,
): Promise<ChatState> {
  const taskId = String(formData.get("taskId") ?? "");
  const index = Number(formData.get("optionIndex") ?? -1);
  if (!taskId) return { ok: false, message: "Tâche manquante." };

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  const status = await getCoworkStatus(userId, taskId);
  if (!status.awaitingChoice || !status.pendingOptions) {
    return { ok: false, message: "Aucune option en attente." };
  }
  const option = status.pendingOptions.options[index];
  if (!option) return { ok: false, message: "Option invalide." };

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  await addMessage(taskId, {
    role: "user",
    content: `Choix : ${option.title}`,
    kind: "cowork_choice",
    data: { index },
  });
  const history = await buildHistory(userId, taskId);
  const norms = await buildPhaseNormsContext(userId, ctx.phaseId);
  const startedAt = new Date();

  try {
    const res = await produceCoworkArtifact(ctx, history, option, norms.text);
    const artifactId = await addArtifact(taskId, {
      type: "document",
      title: res.title,
      content: res.content,
    });
    await addMessage(taskId, {
      role: "assistant",
      content: `Artefact produit : « ${res.title} »`,
      kind: "artifact",
      data: { artifactId },
    });
    await record(userId, `[cowork:artefact] ${ctx.taskTitle}`, res, "succeeded", startedAt, { projectId: ctx.projectId, taskId });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Échec de production.",
    };
  }

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true, message: "" };
}
