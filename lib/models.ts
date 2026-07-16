/**
 * Types de modèles + tarification. Le catalogue réel (tous les modèles de
 * chaque provider, avec coût/contexte) vient de **models.dev**
 * ([lib/model-catalog.ts](model-catalog.ts)) ; ici on ne garde que les types,
 * le calcul de coût, et la construction d'un `ModelSpec`.
 *
 * Les deux "tiers" restent l'API du routeur (les appelants demandent `fast` ou
 * `frontier`), mais ils ne décrivent plus un prix : ils se traduisent en
 * **niveau d'intelligence minimum requis** ([intelligence.ts](intelligence.ts)),
 * et la sélection prend le modèle le moins cher qui l'atteint.
 */
import {
  levelOf,
  type IntelligenceLevel,
} from "@/lib/intelligence";
import {
  getCatalogModel,
  pickFreeModelForLevel,
  pickModelForLevel,
  type PickOptions,
} from "@/lib/model-catalog";

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "opencode"
  | "groq"
  | "ollama";

export type Tier = "fast" | "frontier";

/**
 * Traduction d'un tier en **niveau d'intelligence minimum**.
 *
 * C'est ici que « fast » cesse de vouloir dire « le moins cher » pour vouloir
 * dire « assez capable pour une tâche courante, au meilleur prix ». Le plancher
 * de `fast` évite de router une conversation vers un modèle jouet sous prétexte
 * qu'il est gratuit.
 */
export const TIER_MIN_LEVEL: Record<Tier, IntelligenceLevel> = {
  fast: 2, // avancé
  frontier: 3, // expert
};

export interface ModelSpec {
  provider: Provider;
  /** Identifiant modèle passé au SDK provider. */
  modelId: string;
  tier: Tier;
  /** Niveau d'intelligence estimé du modèle retenu (cf. intelligence.ts). */
  level: IntelligenceLevel;
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

/**
 * Niveau supposé du modèle local (LM Studio / Ollama).
 *
 * Inconnaissable par nature : c'est le modèle que l'utilisateur a chargé, du
 * 1B jouet au 70B. On le suppose « expert » (3) — pas par optimisme, mais
 * parce que c'est le seul défaut qui ne casse rien : plus bas, le local
 * disparaîtrait silencieusement des tâches `frontier` alors qu'il est
 * gratuit et explicitement configuré par l'utilisateur. À corriger via
 * `LOCAL_AI_LEVEL` si le modèle chargé est faible (ou fort).
 */
export const LOCAL_MODEL_LEVEL = Number(
  process.env.LOCAL_AI_LEVEL ?? 3,
) as IntelligenceLevel;

/** Spec du modèle local (LM Studio / Ollama), coût nul. */
function localSpec(tier: Tier): ModelSpec {
  return {
    provider: "ollama",
    modelId: LOCAL_MODEL_ID,
    tier,
    level: LOCAL_MODEL_LEVEL,
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
 * ModelSpec du tier voulu pour un provider : le **moins cher qui atteint le
 * niveau requis** par le tier (ou le plus capable en `boost`). Le local est
 * gratuit et supposé de niveau `LOCAL_MODEL_LEVEL`.
 *
 * `undefined` si le provider n'a aucun modèle assez capable — l'appelant passe
 * au provider suivant plutôt que de dégrader la tâche en silence.
 */
export function findModel(
  provider: Provider,
  tier: Tier,
  opts: Omit<PickOptions, "free"> = {},
): ModelSpec | undefined {
  const minLevel = TIER_MIN_LEVEL[tier];
  if (provider === "ollama") {
    return LOCAL_MODEL_LEVEL >= minLevel ? localSpec(tier) : undefined;
  }
  const m = pickModelForLevel(provider, minLevel, opts);
  if (!m) return undefined;
  return {
    provider,
    modelId: m.id,
    tier,
    level: levelOf(m),
    inputPerMTok: m.input,
    outputPerMTok: m.output,
    contextWindow: m.context,
  };
}

/**
 * ModelSpec **gratuit** du tier voulu (coût nul) : modèle local, sinon meilleur
 * modèle à 0 $ du provider atteignant le niveau requis. `undefined` si aucun
 * gratuit n'est assez capable — mieux vaut alors payer que bâcler.
 */
export function findFreeModel(
  provider: Provider,
  tier: Tier,
  opts: Omit<PickOptions, "free"> = {},
): ModelSpec | undefined {
  const minLevel = TIER_MIN_LEVEL[tier];
  if (provider === "ollama") {
    return LOCAL_MODEL_LEVEL >= minLevel ? localSpec(tier) : undefined;
  }
  const m = pickFreeModelForLevel(provider, minLevel, opts);
  if (!m) return undefined;
  return {
    provider,
    modelId: m.id,
    tier,
    level: levelOf(m),
    inputPerMTok: 0,
    outputPerMTok: 0,
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
    level: levelOf(m),
    inputPerMTok: m.input,
    outputPerMTok: m.output,
    contextWindow: m.context,
  };
}
