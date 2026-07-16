"use server";

import { revalidatePath } from "next/cache";

import {
  routeAndRun,
  routeOnly,
  type RouteRequest,
  type TaskKind,
} from "@/lib/llm-router";
import {
  addConnection,
  deleteConnection,
  getProviderConnections,
  touchProviderKey,
} from "@/lib/keys";
import { recordExecution } from "@/lib/executions";
import { getCurrentUserId } from "@/lib/users";
import { TIER_MIN_LEVEL, type Provider } from "@/lib/models";
import {
  isMethodSupported,
  type ConnMethod,
} from "@/lib/providers";

// --- Routeur -------------------------------------------------------------

export interface RouteFormState {
  ok: boolean;
  message: string;
  model?: string;
  provider?: string;
  tier?: string;
  /** Niveau d'intelligence du modèle retenu, et niveau exigé par le tier. */
  level?: number;
  minLevel?: number;
  boost?: boolean;
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
  const boost = formData.get("boost") === "on";

  if (!prompt) {
    return { ok: false, message: "Le prompt est vide.", executed: false };
  }

  const userId = await getCurrentUserId();
  const keys = await getProviderConnections(userId);
  const req: RouteRequest = { prompt, kind, boost };

  // Aucune connexion configurée → décision de routage seule (dry-run), sans dépense.
  if (Object.keys(keys).length === 0) {
    try {
      const demo: ConnMethod = "api_key";
      const decision = routeOnly(req, {
        anthropic: { method: demo, secret: "demo" },
        openai: { method: demo, secret: "demo" },
        google: { method: demo, secret: "demo" },
        openrouter: { method: demo, secret: "demo" },
        opencode: { method: demo, secret: "demo" },
        groq: { method: demo, secret: "demo" },
      });
      return {
        ok: true,
        executed: false,
        message:
          "Aucune clé LLM enregistrée : décision de routage affichée sans appel réel. Ajoutez une clé ci-dessus pour exécuter.",
        provider: decision.spec.provider,
        model: decision.spec.modelId,
        tier: decision.tier,
        level: decision.spec.level,
        minLevel: TIER_MIN_LEVEL[decision.tier],
        boost,
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
      level: result.decision.spec.level,
      minLevel: TIER_MIN_LEVEL[result.decision.tier],
      boost,
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

// --- Connecteurs (clé API / OAuth / local) -------------------------------

export interface KeyFormState {
  ok: boolean;
  message: string;
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set<Provider>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "opencode",
  "groq",
  "ollama",
]);

const VALID_METHODS: ReadonlySet<string> = new Set<ConnMethod>([
  "api_key",
  "oauth",
  "none",
]);

export async function addConnectionAction(
  _prev: KeyFormState,
  formData: FormData,
): Promise<KeyFormState> {
  const rawProvider = String(formData.get("provider") ?? "");
  const rawMethod = String(formData.get("method") ?? "api_key");
  const secret = String(formData.get("key") ?? "");
  const labelRaw = String(formData.get("label") ?? "").trim();

  if (!VALID_PROVIDERS.has(rawProvider)) {
    return { ok: false, message: "Provider inconnu." };
  }
  if (!VALID_METHODS.has(rawMethod)) {
    return { ok: false, message: "Méthode de connexion inconnue." };
  }
  const provider = rawProvider as Provider;
  const method = rawMethod as ConnMethod;

  if (!isMethodSupported(provider, method)) {
    return {
      ok: false,
      message: `Méthode « ${method} » non supportée pour ${provider}.`,
    };
  }
  if (method !== "none" && !secret.trim()) {
    return {
      ok: false,
      message:
        method === "oauth"
          ? "Le jeton OAuth est vide."
          : "La clé API est vide.",
    };
  }

  try {
    const userId = await getCurrentUserId();
    await addConnection(
      userId,
      provider,
      method,
      method === "none" ? null : secret,
      labelRaw.length > 0 ? labelRaw : null,
    );
    revalidatePath("/");
    return {
      ok: true,
      message:
        method === "none"
          ? `Connexion locale ${provider} enregistrée.`
          : `Connexion ${provider} (${method}) enregistrée (chiffrée).`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur d'enregistrement.",
    };
  }
}

export async function deleteConnectionAction(
  formData: FormData,
): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const userId = await getCurrentUserId();
  await deleteConnection(userId, id);
  revalidatePath("/");
  // « Oublier » est aussi offert depuis /models : la joignabilité qui y est
  // affichée dépend directement des connexions.
  revalidatePath("/models");
}
