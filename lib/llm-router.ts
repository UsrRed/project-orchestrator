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
import { tryAcquire } from "@/lib/rate-limit";
import type { ConnMethod } from "@/lib/providers";

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

/** Connexion déchiffrée à un provider (méthode + secret éventuel). */
export interface ProviderConnection {
  method: ConnMethod;
  /** Clé API ou jeton OAuth. Absent pour la méthode 'none' (local). */
  secret?: string;
}

/**
 * Connexions disponibles (déchiffrées), indexées par provider. Nom conservé
 * pour rétro-compatibilité — la valeur est désormais une `ProviderConnection`.
 */
export type ProviderKeys = Partial<Record<Provider, ProviderConnection>>;

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
  // Le local (ollama/LM Studio) est gratuit → préféré quand disponible.
  fast: ["ollama", "groq", "google", "openai", "openrouter", "anthropic"],
  frontier: ["ollama", "anthropic", "openai", "google", "openrouter", "groq"],
};

/**
 * Choisit le meilleur modèle disponible pour un tier, parmi les providers dont
 * une clé est fournie. Lève une erreur si aucun provider n'est disponible.
 */
export function selectModel(tier: Tier, keys: ProviderKeys): ModelSpec {
  const first = selectModelChain(tier, keys)[0];
  if (!first) {
    throw new Error(
      `Aucun provider disponible pour le tier « ${tier} ». Ajoutez au moins une clé API.`,
    );
  }
  return first;
}

/**
 * Chaîne de fallback : tous les modèles disponibles pour un tier, dans l'ordre
 * de préférence. Le routeur les essaie successivement jusqu'au premier succès.
 */
export function selectModelChain(tier: Tier, keys: ProviderKeys): ModelSpec[] {
  const chain: ModelSpec[] = [];
  for (const provider of PREFERENCE[tier]) {
    if (!keys[provider]) continue;
    const spec = findModel(provider, tier);
    if (spec) chain.push(spec);
  }
  return chain;
}

// --- Instanciation du modèle SDK ----------------------------------------

export function buildModel(
  spec: ModelSpec,
  conn: ProviderConnection,
): LanguageModel {
  const secret = conn.secret ?? "";
  // En OAuth, on ajoute un en-tête Authorization: Bearer. Pour OpenAI et les
  // providers OpenAI-compatibles, la clé/le jeton est DÉJÀ envoyé en Bearer par
  // le SDK → passer le jeton comme apiKey suffit. Pour Anthropic/Google (qui
  // utilisent des en-têtes propres), on force l'en-tête Bearer (best-effort ;
  // leur voie « sans clé » officielle reste Vertex/Bedrock).
  const oauthHeaders =
    conn.method === "oauth" ? { Authorization: `Bearer ${secret}` } : undefined;

  switch (spec.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: secret, headers: oauthHeaders })(
        spec.modelId,
      );
    case "openai":
      return createOpenAI({ apiKey: secret })(spec.modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: secret, headers: oauthHeaders })(
        spec.modelId,
      );
    case "groq":
      return createOpenAICompatible({
        name: "groq",
        apiKey: secret,
        baseURL: "https://api.groq.com/openai/v1",
      })(spec.modelId);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        apiKey: secret,
        baseURL: "https://openrouter.ai/api/v1",
      })(spec.modelId);
    case "ollama": {
      // Serveur local OpenAI-compatible (LM Studio / Ollama). La clé n'est pas
      // requise par le serveur local ; base URL configurable. On active les
      // structured outputs (response_format json_schema) — LM Studio n'accepte
      // pas le tool-mode ni json_object, seulement json_schema.
      const local = createOpenAICompatible({
        name: "local",
        apiKey: secret || "local",
        baseURL: process.env.LOCAL_AI_BASE_URL ?? "http://localhost:1234/v1",
      });
      return local.chatModel(
        spec.modelId,
        {},
        { supportsStructuredOutputs: true, defaultObjectGenerationMode: "json" },
      );
    }
    default: {
      const _exhaustive: never = spec.provider;
      throw new Error(`Provider non géré : ${String(_exhaustive)}`);
    }
  }
}

// --- Fiabilité : circuit-breaker + fallback multi-provider ---------------

interface BreakerState {
  failures: number;
  openUntil: number;
}
const breakers = new Map<Provider, BreakerState>();
const CB_THRESHOLD = 3; // échecs consécutifs avant ouverture
const CB_COOLDOWN_MS = 30_000; // durée d'ouverture (provider sauté)

function breakerOpen(provider: Provider, now: number): boolean {
  const b = breakers.get(provider);
  return b ? now < b.openUntil : false;
}
function recordFailure(provider: Provider, now: number): void {
  const b = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= CB_THRESHOLD) b.openUntil = now + CB_COOLDOWN_MS;
  breakers.set(provider, b);
}
function recordSuccess(provider: Provider): void {
  breakers.delete(provider);
}
/** Réinitialise l'état du circuit-breaker (tests). */
export function resetBreakers(): void {
  breakers.clear();
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface FallbackOptions {
  /** Délai avant abandon d'un provider (ms). Défaut 60s. */
  timeoutMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

export interface FallbackResult<T> {
  value: T;
  usage?: LlmUsage;
  spec: ModelSpec;
}

/**
 * Exécute un appel LLM avec fiabilité : parcourt la chaîne de fallback du tier
 * (providers disponibles, non ouverts au circuit-breaker, sous la limite de
 * rate), applique un timeout par tentative, et bascule au provider suivant en
 * cas d'échec (le retry par tentative est géré par le SDK via `maxRetries`
 * côté `exec`). Renvoie le résultat du premier succès + le `spec` retenu, ou
 * lève une erreur agrégée si tous échouent.
 */
export async function runWithFallback<T>(
  tier: Tier,
  keys: ProviderKeys,
  exec: (
    model: LanguageModel,
    spec: ModelSpec,
    signal: AbortSignal,
  ) => Promise<{ value: T; usage?: LlmUsage }>,
  opts: FallbackOptions = {},
): Promise<FallbackResult<T>> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const chain = selectModelChain(tier, keys);
  if (chain.length === 0) {
    throw new Error(
      `Aucun provider disponible pour le tier « ${tier} ». Ajoutez au moins une clé API.`,
    );
  }

  const errors: string[] = [];
  for (const spec of chain) {
    const provider = spec.provider;
    if (breakerOpen(provider, now())) {
      errors.push(`${provider}: circuit ouvert`);
      continue;
    }
    if (!tryAcquire(provider, now())) {
      errors.push(`${provider}: limite de débit atteinte`);
      continue;
    }
    const conn = keys[provider];
    if (!conn) {
      errors.push(`${provider}: connexion manquante`);
      continue;
    }

    const model = buildModel(spec, conn);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await exec(model, spec, ac.signal);
      recordSuccess(provider);
      return { value: res.value, usage: res.usage, spec };
    } catch (err) {
      recordFailure(provider, now());
      errors.push(
        `${provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Tous les providers ont échoué pour le tier « ${tier} » : ${errors.join(" | ")}`,
  );
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

  const { value: text, usage, spec } = await runWithFallback(
    classification.tier,
    keys,
    async (model, _spec, signal) => {
      const r = await generateText({
        model,
        system: req.system,
        prompt: req.prompt,
        abortSignal: signal,
        maxRetries: 1,
      });
      return { value: r.text, usage: r.usage };
    },
  );

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
