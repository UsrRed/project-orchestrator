"use server";

import { revalidatePath } from "next/cache";

import {
  routeAndRun,
  routeOnly,
  type RouteRequest,
  type TaskKind,
} from "@/lib/llm-router";
import {
  addApiKey,
  deleteApiKey,
  getDecryptedProviderKeys,
  touchProviderKey,
} from "@/lib/keys";
import { recordExecution } from "@/lib/executions";
import { getCurrentUserId } from "@/lib/users";
import type { Provider } from "@/lib/models";

// --- Routeur -------------------------------------------------------------

export interface RouteFormState {
  ok: boolean;
  message: string;
  model?: string;
  provider?: string;
  tier?: string;
  reason?: string;
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  text?: string;
  executed: boolean;
}

const VALID_KINDS: ReadonlySet<string> = new Set<TaskKind>([
  "translate",
  "format",
  "validate",
  "summarize",
  "research",
  "architecture",
  "code",
  "generic",
]);

/** Aperçu lisible du prompt pour l'historique des exécutions. */
function labelFor(prompt: string, kind: TaskKind): string {
  const snippet = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  return `[${kind}] ${snippet}`;
}

export async function routeAction(
  _prev: RouteFormState,
  formData: FormData,
): Promise<RouteFormState> {
  const prompt = String(formData.get("prompt") ?? "").trim();
  const rawKind = String(formData.get("kind") ?? "generic");
  const kind = (VALID_KINDS.has(rawKind) ? rawKind : "generic") as TaskKind;

  if (!prompt) {
    return { ok: false, message: "Le prompt est vide.", executed: false };
  }

  const userId = await getCurrentUserId();
  const keys = await getDecryptedProviderKeys(userId);
  const req: RouteRequest = { prompt, kind };

  // Aucune clé configurée → décision de routage seule (dry-run), sans dépense.
  if (Object.keys(keys).length === 0) {
    try {
      const decision = routeOnly(req, {
        anthropic: "demo",
        openai: "demo",
        google: "demo",
        openrouter: "demo",
        groq: "demo",
      });
      return {
        ok: true,
        executed: false,
        message:
          "Aucune clé LLM enregistrée : décision de routage affichée sans appel réel. Ajoutez une clé ci-dessus pour exécuter.",
        provider: decision.spec.provider,
        model: decision.spec.modelId,
        tier: decision.tier,
        reason: decision.reason,
      };
    } catch (err) {
      return {
        ok: false,
        executed: false,
        message: err instanceof Error ? err.message : "Erreur de routage.",
      };
    }
  }

  const startedAt = new Date();
  try {
    const result = await routeAndRun(req, keys);
    const finishedAt = new Date();

    await touchProviderKey(userId, result.decision.spec.provider);
    await recordExecution({
      userId,
      taskLabel: labelFor(prompt, kind),
      provider: result.decision.spec.provider,
      model: result.decision.spec.modelId,
      tier: result.decision.tier,
      status: "succeeded",
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      startedAt,
      finishedAt,
    });
    revalidatePath("/");

    return {
      ok: true,
      executed: true,
      message: "Appel LLM réel exécuté et journalisé.",
      provider: result.decision.spec.provider,
      model: result.decision.spec.modelId,
      tier: result.decision.tier,
      reason: result.decision.reason,
      costUsd: result.costUsd,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      text: result.text,
    };
  } catch (err) {
    // On journalise aussi les échecs (une décision de routage a bien eu lieu).
    const finishedAt = new Date();
    try {
      const decision = routeOnly(req, keys);
      await recordExecution({
        userId,
        taskLabel: labelFor(prompt, kind),
        provider: decision.spec.provider,
        model: decision.spec.modelId,
        tier: decision.tier,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt,
      });
      revalidatePath("/");
    } catch {
      // Si même le routage échoue, on remonte simplement l'erreur d'appel.
    }
    return {
      ok: false,
      executed: false,
      message: err instanceof Error ? err.message : "Erreur lors de l'appel LLM.",
    };
  }
}

// --- Gestion des clés API ------------------------------------------------

export interface KeyFormState {
  ok: boolean;
  message: string;
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set<Provider>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
]);

export async function addKeyAction(
  _prev: KeyFormState,
  formData: FormData,
): Promise<KeyFormState> {
  const rawProvider = String(formData.get("provider") ?? "");
  const key = String(formData.get("key") ?? "");
  const labelRaw = String(formData.get("label") ?? "").trim();

  if (!VALID_PROVIDERS.has(rawProvider)) {
    return { ok: false, message: "Provider inconnu." };
  }
  if (!key.trim()) {
    return { ok: false, message: "La clé API est vide." };
  }

  try {
    const userId = await getCurrentUserId();
    await addApiKey(
      userId,
      rawProvider as Provider,
      key,
      labelRaw.length > 0 ? labelRaw : null,
    );
    revalidatePath("/");
    return { ok: true, message: `Clé ${rawProvider} enregistrée (chiffrée).` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur d'enregistrement.",
    };
  }
}

export async function deleteKeyAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const userId = await getCurrentUserId();
  await deleteApiKey(userId, id);
  revalidatePath("/");
}
