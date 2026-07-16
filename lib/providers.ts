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

/** Aide pour obtenir une credential : lien à ouvrir et/ou commande à copier. */
export interface CredentialHelp {
  label: string;
  url?: string;
  command?: string;
  note?: string;
}

export interface ProviderInfo {
  id: Provider;
  label: string;
  /** Méthodes de connexion supportées (la première est la valeur par défaut). */
  methods: ConnMethod[];
  note?: string;
  /** Page où créer une clé API. */
  apiKeyUrl?: string;
  /** Aide pour obtenir un jeton OAuth (Bearer). */
  oauth?: CredentialHelp;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "ollama",
    label: "Local (LM Studio / Ollama)",
    methods: ["none"],
    note: "Serveur local OpenAI-compatible (LOCAL_AI_BASE_URL) — aucune credential requise.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    methods: ["api_key", "oauth"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    oauth: {
      label: "OAuth Anthropic (expérimental)",
      note: "Pas de flux OAuth public tiers pour l'API. Voie « sans clé » officielle : Amazon Bedrock / Google Vertex. Colle ici un jeton Bearer si tu en as un.",
    },
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    methods: ["api_key", "oauth"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
    oauth: {
      label: "OAuth OpenAI (expérimental)",
      note: "L'API OpenAI s'utilise normalement par clé. Colle un jeton Bearer si ta configuration en fournit un.",
    },
  },
  {
    id: "google",
    label: "Google (Gemini)",
    methods: ["api_key", "oauth"],
    apiKeyUrl: "https://aistudio.google.com/apikey",
    oauth: {
      label: "Jeton d'accès Google",
      command: "gcloud auth print-access-token",
      url: "https://developers.google.com/oauthplayground",
      note: "Jeton Bearer avec le scope generative-language ou cloud-platform (compte/projet GCP).",
    },
  },
  {
    id: "groq",
    label: "Groq (Llama)",
    methods: ["api_key"],
    apiKeyUrl: "https://console.groq.com/keys",
  },
  {
    id: "opencode",
    label: "OpenCode Zen (modèles gratuits)",
    methods: ["api_key"],
    apiKeyUrl: "https://opencode.ai/auth",
    note: "Passerelle OpenAI-compatible avec des modèles à 0 $ (big-pickle, grok-code, glm-5-free…). Clé gratuite, mais le compte demande des informations de facturation ; pendant la gratuité, les échanges peuvent servir à entraîner les modèles.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    methods: ["api_key"],
    apiKeyUrl: "https://openrouter.ai/keys",
    note: "Beaucoup de modèles `:free` à 0 $ (quotas limités) en plus du catalogue payant.",
  },
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

/** Aide contextuelle « où obtenir la credential » selon provider + méthode. */
export function credentialHelp(
  id: Provider,
  method: ConnMethod,
): CredentialHelp | null {
  const info = providerInfo(id);
  if (!info) return null;
  if (method === "api_key" && info.apiKeyUrl) {
    return { label: "Obtenir une clé API", url: info.apiKeyUrl };
  }
  if (method === "oauth" && info.oauth) {
    return info.oauth;
  }
  return null;
}
