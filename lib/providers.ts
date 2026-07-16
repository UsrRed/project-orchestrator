/**
 * Registre des providers LLM et de leurs méthodes de connexion (connecteurs).
 *
 * Un provider peut se connecter de plusieurs façons :
 *  - `api_key` : clé API classique ;
 *  - `oauth`   : jeton d'accès OAuth (Bearer) obtenu hors-app (ex: gcloud, un
 *    CLI, un flux OAuth de ton app) — le routeur l'envoie en `Authorization:
 *    Bearer`. Fiable pour les endpoints OpenAI-compatibles ; best-effort pour
 *    Anthropic/Google (leur voie « sans clé » officielle est Vertex/Bedrock) ;
 *  - `none`    : aucune credential (serveur local type LM Studio / Ollama).
 */
import type { Provider } from "@/lib/models";

export type ConnMethod = "api_key" | "oauth" | "none";

export interface ProviderInfo {
  id: Provider;
  label: string;
  /** Méthodes de connexion supportées (la première est la valeur par défaut). */
  methods: ConnMethod[];
  note?: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "ollama",
    label: "Local (LM Studio / Ollama)",
    methods: ["none"],
    note: "Serveur local OpenAI-compatible — aucune credential requise.",
  },
  { id: "anthropic", label: "Anthropic (Claude)", methods: ["api_key", "oauth"] },
  { id: "openai", label: "OpenAI (GPT)", methods: ["api_key", "oauth"] },
  { id: "google", label: "Google (Gemini)", methods: ["api_key", "oauth"] },
  { id: "groq", label: "Groq (Llama)", methods: ["api_key"] },
  { id: "openrouter", label: "OpenRouter", methods: ["api_key"] },
] as const;

export const METHOD_LABEL: Record<ConnMethod, string> = {
  api_key: "Clé API",
  oauth: "Jeton OAuth (Bearer)",
  none: "Local (sans credential)",
};

export function providerInfo(id: Provider): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isMethodSupported(id: Provider, method: ConnMethod): boolean {
  return providerInfo(id)?.methods.includes(method) ?? false;
}

/** Méthode par défaut d'un provider (la première déclarée). */
export function defaultMethod(id: Provider): ConnMethod {
  return providerInfo(id)?.methods[0] ?? "api_key";
}
