/**
 * Types de modèles + tarification. Le catalogue réel (tous les modèles de
 * chaque provider, avec coût/contexte) vient de **models.dev**
 * ([lib/model-catalog.ts](model-catalog.ts)) ; ici on ne garde que les types,
 * le calcul de coût, et la construction d'un `ModelSpec` par tier.
 *
 * Deux "tiers" alimentent le routeur :
 *  - "fast"    : le modèle le moins cher du provider (tâches simples) ;
 *  - "frontier": le modèle haut de gamme du provider (tâches complexes).
 */
import {
  getCatalogModel,
  pickModelForTier,
} from "@/lib/model-catalog";

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "ollama";

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

/**
 * Modèle local (serveur OpenAI-compatible : LM Studio / Ollama), configurable
 * via `LOCAL_AI_MODEL`. Coût nul (inférence locale) → candidat idéal du routeur
 * pour les tâches à optimiser financièrement.
 */
export const LOCAL_MODEL_ID = process.env.LOCAL_AI_MODEL ?? "qwen-active";

/** Spec du modèle local (LM Studio / Ollama), coût nul. */
function localSpec(tier: Tier): ModelSpec {
  return {
    provider: "ollama",
    modelId: LOCAL_MODEL_ID,
    tier,
    inputPerMTok: 0,
    outputPerMTok: 0,
    contextWindow: 32_768,
  };
}

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

/**
 * ModelSpec du tier voulu pour un provider, à partir du catalogue models.dev
 * (le local a un coût nul). `undefined` si le provider n'a aucun modèle éligible.
 */
export function findModel(
  provider: Provider,
  tier: Tier,
): ModelSpec | undefined {
  if (provider === "ollama") return localSpec(tier);
  const m = pickModelForTier(provider, tier);
  if (!m) return undefined;
  return {
    provider,
    modelId: m.id,
    tier,
    inputPerMTok: m.input,
    outputPerMTok: m.output,
    contextWindow: m.context,
  };
}

/** ModelSpec pour un modèle précis choisi dans le catalogue (sélection UI). */
export function specForModel(
  provider: Provider,
  modelId: string,
  tier: Tier,
): ModelSpec | undefined {
  if (provider === "ollama") {
    return { ...localSpec(tier), modelId };
  }
  const m = getCatalogModel(provider, modelId);
  if (!m) return undefined;
  return {
    provider,
    modelId: m.id,
    tier,
    inputPerMTok: m.input,
    outputPerMTok: m.output,
    contextWindow: m.context,
  };
}
