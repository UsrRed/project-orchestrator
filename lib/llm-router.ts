/**
 * Routeur d'Intelligence & Coût — cœur produit d'Orchestrato.AI.
 *
 * Rôle : à partir d'une requête (prompt + métadonnées de tâche) et de
 * l'ensemble des providers dont l'utilisateur a fourni une clé, choisir le
 * modèle le plus adapté (complexité × contexte × coût), exécuter l'appel via
 * le Vercel AI SDK, et renvoyer le résultat AVEC le coût réel calculé pour
 * journalisation dans `agent_executions`.
 *
 * M0 : classification heuristique simple + sélection déterministe. Les couches
 * plus riches (LangGraph, fallback/circuit-breaker) arriveront aux jalons
 * ultérieurs.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";

import {
  computeCostUsd,
  findModel,
  type ModelSpec,
  type Provider,
  type Tier,
} from "@/lib/models";

// --- Entrées / sorties ---------------------------------------------------

export type TaskKind =
  | "translate"
  | "format"
  | "validate"
  | "summarize"
  | "research"
  | "architecture"
  | "code"
  | "generic";

export interface RouteRequest {
  prompt: string;
  system?: string;
  /** Type de tâche déclaré (améliore la classification). */
  kind?: TaskKind;
  /** Estimation de la taille de contexte en tokens si connue. */
  contextTokens?: number;
  /** Forcer un tier (bypass de l'heuristique) — utile pour tests/overrides. */
  forceTier?: Tier;
}

/** Clés API disponibles (déchiffrées), indexées par provider. */
export type ProviderKeys = Partial<Record<Provider, string>>;

export interface RouteDecision {
  tier: Tier;
  complexity: "simple" | "complex";
  reason: string;
  spec: ModelSpec;
}

export interface RouteResult {
  decision: RouteDecision;
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// --- Classification heuristique -----------------------------------------

const COMPLEX_KINDS: ReadonlySet<TaskKind> = new Set([
  "research",
  "architecture",
  "code",
]);
const SIMPLE_KINDS: ReadonlySet<TaskKind> = new Set([
  "translate",
  "format",
  "validate",
]);

/** ~4 caractères par token (approximation rapide, sans tokenizer). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LONG_CONTEXT_THRESHOLD = 8_000; // tokens
const LONG_PROMPT_THRESHOLD = 2_000; // tokens

/**
 * Décide du tier (fast/frontier) selon le type de tâche, la taille du prompt
 * et du contexte. Règles volontairement simples et lisibles (M0).
 */
export interface Classification {
  complexity: "simple" | "complex";
  tier: Tier;
  reason: string;
}

export function classify(req: RouteRequest): Classification {
  if (req.forceTier) {
    return {
      complexity: req.forceTier === "frontier" ? "complex" : "simple",
      tier: req.forceTier,
      reason: `Tier forcé (${req.forceTier}).`,
    };
  }

  const kind = req.kind ?? "generic";
  const promptTokens = estimateTokens(req.prompt);
  const contextTokens = req.contextTokens ?? 0;
  const totalContext = promptTokens + contextTokens;

  if (COMPLEX_KINDS.has(kind)) {
    return {
      complexity: "complex",
      tier: "frontier",
      reason: `Type de tâche « ${kind} » intrinsèquement complexe.`,
    };
  }

  if (totalContext > LONG_CONTEXT_THRESHOLD || promptTokens > LONG_PROMPT_THRESHOLD) {
    return {
      complexity: "complex",
      tier: "frontier",
      reason: `Grand contexte (~${totalContext} tokens) → modèle haut de gamme.`,
    };
  }

  if (SIMPLE_KINDS.has(kind)) {
    return {
      complexity: "simple",
      tier: "fast",
      reason: `Type de tâche « ${kind} » simple, faible contexte.`,
    };
  }

  return {
    complexity: "simple",
    tier: "fast",
    reason: "Tâche générique de faible contexte → modèle rapide/économique.",
  };
}

// --- Sélection du provider/modèle ---------------------------------------

/** Ordre de préférence par tier (le moins cher / le plus adapté d'abord). */
const PREFERENCE: Record<Tier, readonly Provider[]> = {
  fast: ["groq", "google", "openai", "openrouter", "anthropic"],
  frontier: ["anthropic", "openai", "google", "openrouter", "groq"],
};

/**
 * Choisit le meilleur modèle disponible pour un tier, parmi les providers dont
 * une clé est fournie. Lève une erreur si aucun provider n'est disponible.
 */
export function selectModel(tier: Tier, keys: ProviderKeys): ModelSpec {
  for (const provider of PREFERENCE[tier]) {
    if (!keys[provider]) continue;
    const spec = findModel(provider, tier);
    if (spec) return spec;
  }
  throw new Error(
    `Aucun provider disponible pour le tier « ${tier} ». Ajoutez au moins une clé API.`,
  );
}

// --- Instanciation du modèle SDK ----------------------------------------

export function buildModel(spec: ModelSpec, apiKey: string): LanguageModel {
  switch (spec.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(spec.modelId);
    case "openai":
      return createOpenAI({ apiKey })(spec.modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(spec.modelId);
    case "groq":
      return createOpenAICompatible({
        name: "groq",
        apiKey,
        baseURL: "https://api.groq.com/openai/v1",
      })(spec.modelId);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      })(spec.modelId);
    default: {
      const _exhaustive: never = spec.provider;
      throw new Error(`Provider non géré : ${String(_exhaustive)}`);
    }
  }
}

// --- Point d'entrée principal -------------------------------------------

/**
 * Route puis exécute la requête. Renvoie le texte généré et le coût réel.
 * L'appelant est responsable de persister le résultat dans `agent_executions`.
 */
export async function routeAndRun(
  req: RouteRequest,
  keys: ProviderKeys,
): Promise<RouteResult> {
  const classification = classify(req);
  const spec = selectModel(classification.tier, keys);

  const apiKey = keys[spec.provider];
  if (!apiKey) {
    throw new Error(`Clé manquante pour le provider ${spec.provider}.`);
  }

  const model = buildModel(spec, apiKey);

  const { text, usage } = await generateText({
    model,
    system: req.system,
    prompt: req.prompt,
  });

  const promptTokens = usage?.promptTokens ?? estimateTokens(req.prompt);
  const completionTokens = usage?.completionTokens ?? estimateTokens(text);
  const costUsd = computeCostUsd(spec, promptTokens, completionTokens);

  return {
    decision: {
      tier: classification.tier,
      complexity: classification.complexity,
      reason: classification.reason,
      spec,
    },
    text,
    promptTokens,
    completionTokens,
    costUsd,
  };
}

/**
 * Variante "dry-run" : renvoie uniquement la décision de routage sans appeler
 * de LLM. Pratique pour l'UI (afficher le modèle choisi avant exécution) et
 * pour les tests sans clé réelle.
 */
export function routeOnly(req: RouteRequest, keys: ProviderKeys): RouteDecision {
  const classification = classify(req);
  const spec = selectModel(classification.tier, keys);
  return {
    tier: classification.tier,
    complexity: classification.complexity,
    reason: classification.reason,
    spec,
  };
}
