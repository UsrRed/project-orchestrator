/**
 * Catalogue de modèles et tarification (USD par million de tokens).
 *
 * Deux "tiers" alimentent le routeur :
 *  - "fast"   : modèles économiques/rapides pour tâches simples & faible contexte ;
 *  - "frontier": modèles haut de gamme pour tâches complexes & grand contexte.
 *
 * Les prix sont indicatifs (ordres de grandeur 2025-2026) et servent au calcul
 * du coût réel journalisé dans `agent_executions`. À ajuster/synchroniser
 * régulièrement — ne pas les considérer comme contractuels.
 */
export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq";

export type Tier = "fast" | "frontier";

export interface ModelSpec {
  provider: Provider;
  /** Identifiant modèle passé au SDK provider. */
  modelId: string;
  tier: Tier;
  /** USD / 1M tokens d'entrée. */
  inputPerMTok: number;
  /** USD / 1M tokens de sortie. */
  outputPerMTok: number;
  /** Fenêtre de contexte approximative (tokens). */
  contextWindow: number;
}

export const MODEL_CATALOG: readonly ModelSpec[] = [
  // --- Anthropic ---
  {
    provider: "anthropic",
    modelId: "claude-3-5-haiku-latest",
    tier: "fast",
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    contextWindow: 200_000,
  },
  {
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-latest",
    tier: "frontier",
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 200_000,
  },
  // --- OpenAI ---
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    tier: "fast",
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    tier: "frontier",
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  // --- Google Gemini ---
  {
    provider: "google",
    modelId: "gemini-1.5-flash",
    tier: "fast",
    inputPerMTok: 0.075,
    outputPerMTok: 0.3,
    contextWindow: 1_000_000,
  },
  {
    provider: "google",
    modelId: "gemini-1.5-pro",
    tier: "frontier",
    inputPerMTok: 1.25,
    outputPerMTok: 5,
    contextWindow: 2_000_000,
  },
  // --- Groq (open-weights, ultra-rapide) ---
  {
    provider: "groq",
    modelId: "llama-3.1-8b-instant",
    tier: "fast",
    inputPerMTok: 0.05,
    outputPerMTok: 0.08,
    contextWindow: 128_000,
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    tier: "frontier",
    inputPerMTok: 0.59,
    outputPerMTok: 0.79,
    contextWindow: 128_000,
  },
  // --- OpenRouter (agrégateur ; modelId = slug OpenRouter) ---
  {
    provider: "openrouter",
    modelId: "meta-llama/llama-3.1-8b-instruct",
    tier: "fast",
    inputPerMTok: 0.02,
    outputPerMTok: 0.03,
    contextWindow: 128_000,
  },
  {
    provider: "openrouter",
    modelId: "anthropic/claude-3.5-sonnet",
    tier: "frontier",
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 200_000,
  },
] as const;

/** Coût USD pour un nombre de tokens d'entrée/sortie donné. */
export function computeCostUsd(
  spec: ModelSpec,
  promptTokens: number,
  completionTokens: number,
): number {
  const input = (promptTokens / 1_000_000) * spec.inputPerMTok;
  const output = (completionTokens / 1_000_000) * spec.outputPerMTok;
  return input + output;
}

/** Retourne le premier modèle du tier voulu pour un provider donné. */
export function findModel(
  provider: Provider,
  tier: Tier,
): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.tier === tier);
}
