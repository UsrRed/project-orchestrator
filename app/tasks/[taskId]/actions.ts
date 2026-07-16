"use server";

import { revalidatePath } from "next/cache";

import {
  manualReply,
  produceCoworkArtifact,
  proposeCoworkOptions,
  type HistoryMessage,
} from "@/lib/agent";
import {
  addArtifact,
  addMessage,
  getCoworkStatus,
  getTaskContext,
  listMessages,
  setTaskMode,
} from "@/lib/conversation";
import { isCliAgentId } from "@/lib/cli-agents";
import { cliAgentStatuses } from "@/lib/cli-availability";
import { recordExecution } from "@/lib/executions";
import { getProviderConnections } from "@/lib/keys";
import { assertWithinBudget } from "@/lib/budgets";
import { buildPhaseNormsContext } from "@/lib/normes";
import { enqueueRun, requestKill } from "@/lib/runs";
import { generateWidget } from "@/lib/widgets";
import { getCurrentUserId } from "@/lib/users";
import type { TaskMode } from "@/lib/projects";
import type { ModelSpec, Tier } from "@/lib/models";

export interface ChatState {
  ok: boolean;
  message: string;
}

/** Historique aplati pour le LLM (les options Cowork deviennent du texte). */
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
  meta: {
    spec: ModelSpec;
    tier: Tier;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  },
  status: "succeeded" | "failed",
  startedAt: Date,
  link: { projectId: string; taskId: string },
  error?: string,
): Promise<void> {
  await recordExecution({
    userId,
    taskLabel: label,
    projectId: link.projectId,
    taskId: link.taskId,
    provider: meta.spec.provider,
    model: meta.spec.modelId,
    tier: meta.tier,
    status,
    promptTokens: meta.promptTokens,
    completionTokens: meta.completionTokens,
    costUsd: meta.costUsd,
    error,
    startedAt,
    finishedAt: new Date(),
  });
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

  const keys = await getProviderConnections(userId);
  if (Object.keys(keys).length === 0) {
    return {
      ok: false,
      message: "Aucune clé API. Ajoute-en une sur l'accueil pour discuter.",
    };
  }

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
      const res = await proposeCoworkOptions(ctx, history, keys, norms.text);
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
      const res = await manualReply(ctx, history, keys, norms.text);
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

  const keys = await getProviderConnections(userId);
  if (Object.keys(keys).length === 0) {
    return { ok: false, message: "Aucune clé API. Ajoute-en une sur l'accueil." };
  }
  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  const startedAt = new Date();
  try {
    const res = await generateWidget(instruction, ctx, keys);
    await addArtifact(taskId, {
      type: "widget",
      title: res.widget.title,
      content: JSON.stringify(res.widget),
    });
    await record(
      userId,
      `[widget] ${res.widget.title}`,
      { spec: res.spec, tier: "frontier", promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd: res.costUsd },
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
 * L'action ne décide de rien qu'elle ne sache : sans « Modèle personnalisé » le
 * moteur reste `auto`, sans « Limites » les bornes restent `null`. Ce sont des
 * trous que la planification comblera, pas des défauts inventés ici.
 */
export async function startRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const taskId = String(formData.get("taskId") ?? "");
  const goal = String(formData.get("goal") ?? "").trim();

  // Cases « avancées » : tant qu'elles sont fermées, leurs champs ne comptent
  // pas — un champ resté monté dans le DOM ne doit pas forcer une valeur que
  // l'utilisateur ne voit plus.
  const customModel = formData.get("customModel") === "on";
  const customLimits = formData.get("customLimits") === "on";

  const engineChoice = customModel
    ? String(formData.get("engine") ?? "llm")
    : "auto";
  const isCli = engineChoice !== "llm" && engineChoice !== "auto";
  const boost = customModel && formData.get("boost") === "on";

  const rawIterations = customLimits
    ? optionalNumber(formData.get("maxIterations"))
    : null;
  const rawTimeout = customLimits
    ? optionalNumber(formData.get("timeoutMin"))
    : null;
  const maxIterations =
    rawIterations === null ? null : clamp(rawIterations, 1, 20);
  const timeoutMin = rawTimeout === null ? null : clamp(rawTimeout, 1, 120);

  // Le plafond est toujours lu : c'est le réglage principal, pas un avancé.
  // 0 (le défaut) = « gratuit / abonnement uniquement ».
  const maxCostUsd = clamp(optionalNumber(formData.get("maxCostUsd")) ?? 0, 0, 50);

  if (!taskId) return { ok: false, message: "Tâche manquante." };
  if (!goal) return { ok: false, message: "Décris l'objectif du run." };

  if (isCli && !isCliAgentId(engineChoice)) {
    return { ok: false, message: `Moteur inconnu : « ${engineChoice} ».` };
  }

  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) return { ok: false, message: "Tâche introuvable." };

  if (isCli) {
    const status = cliAgentStatuses().find((s) => s.id === engineChoice);
    if (!status?.available) {
      return {
        ok: false,
        message:
          status?.warning ?? `L'agent \`${engineChoice}\` n'est pas disponible.`,
      };
    }
  } else {
    // Un agent CLI s'authentifie avec son propre login : lui réclamer une clé
    // LLM n'aurait aucun sens. En `auto`, l'abonnement peut suffire — on ne
    // bloque donc que si RIEN n'est utilisable.
    const keys = await getProviderConnections(userId);
    const hasCli = cliAgentStatuses().some((s) => s.available);
    if (Object.keys(keys).length === 0 && !(engineChoice === "auto" && hasCli)) {
      return {
        ok: false,
        message:
          "Aucune clé API ni agent CLI disponible. Ajoute une connexion sur /models avant de lancer.",
      };
    }
  }

  try {
    await assertWithinBudget(ctx.projectId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Budget dépassé." };
  }

  await enqueueRun(userId, taskId, {
    goal,
    engine: isCli ? "cli" : engineChoice === "auto" ? "auto" : "llm",
    engineCli: isCli ? engineChoice : undefined,
    boost,
    maxIterations,
    maxCostUsd,
    timeoutMin,
  });
  revalidatePath(`/tasks/${taskId}`);
  return {
    ok: true,
    message:
      engineChoice === "auto"
        ? "Run lancé. L'IA évalue la tâche, choisit la source et démarre — suis la progression ci-dessous."
        : "Run lancé. Suis la progression ci-dessous.",
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

  const keys = await getProviderConnections(userId);
  if (Object.keys(keys).length === 0) {
    return { ok: false, message: "Aucune clé API disponible." };
  }
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
    const res = await produceCoworkArtifact(ctx, history, option, keys, norms.text);
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
