/**
 * Catalogue de modèles issu de models.dev (inspiration OpenCode).
 *
 * Un snapshot embarqué (`models.dev.json`, providers supportés + tous leurs
 * modèles avec coût/contexte) garantit un fonctionnement hors-ligne / en CI.
 * Un rafraîchissement live (models.dev/api.json) est possible et met à jour un
 * cache mémoire, sinon on retombe sur le snapshot.
 *
 * Ce module n'importe RIEN de lib/models (pas de cycle) : il travaille avec des
 * clés provider en `string`.
 */
import snapshot from "@/lib/models.dev.json";

export interface CatalogModel {
  id: string;
  name: string;
  /** USD / 1M tokens. */
  input: number;
  output: number;
  context: number;
  reasoning: boolean;
  tool_call: boolean;
}

interface CatalogProvider {
  id: string;
  name: string;
  npm: string | null;
  api: string | null;
  env: string[];
  models: Record<string, CatalogModel>;
}

type Catalog = Record<string, CatalogProvider>;

const SNAPSHOT = snapshot as unknown as Catalog;
let liveCatalog: Catalog | null = null;

function catalog(): Catalog {
  return liveCatalog ?? SNAPSHOT;
}

/** Rafraîchit le catalogue depuis models.dev (best-effort, met en cache). */
export async function refreshCatalog(): Promise<boolean> {
  try {
    const res = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const raw = (await res.json()) as Record<string, unknown>;
    const merged: Catalog = { ...SNAPSHOT };
    for (const pid of Object.keys(SNAPSHOT)) {
      const p = raw[pid] as
        | { models?: Record<string, Record<string, unknown>> }
        | undefined;
      if (!p?.models) continue;
      const models: Record<string, CatalogModel> = {};
      for (const [mid, m] of Object.entries(p.models)) {
        const cost = (m.cost ?? {}) as { input?: number; output?: number };
        if (cost.input == null) continue;
        const limit = (m.limit ?? {}) as { context?: number };
        models[mid] = {
          id: String(m.id ?? mid),
          name: String(m.name ?? mid),
          input: cost.input ?? 0,
          output: cost.output ?? 0,
          context: limit.context ?? 0,
          reasoning: Boolean(m.reasoning),
          tool_call: Boolean(m.tool_call),
        };
      }
      const base = SNAPSHOT[pid]!;
      merged[pid] = { ...base, models };
    }
    liveCatalog = merged;
    return true;
  } catch {
    return false;
  }
}

/** Tous les modèles d'un provider (triés par coût croissant). */
export function listCatalogModels(provider: string): CatalogModel[] {
  const models = Object.values(catalog()[provider]?.models ?? {});
  return models.sort((a, b) => a.input + a.output - (b.input + b.output));
}

export function getCatalogModel(
  provider: string,
  modelId: string,
): CatalogModel | undefined {
  return catalog()[provider]?.models[modelId];
}

export function catalogModelCount(provider: string): number {
  return Object.keys(catalog()[provider]?.models ?? {}).length;
}

/**
 * Choisit un modèle par tier : `fast` = le moins cher, `frontier` = le plus
 * haut de gamme (coût le plus élevé). Heuristique simple qui reste à jour avec
 * le catalogue (pas d'id de modèle codé en dur).
 */
export function pickModelForTier(
  provider: string,
  tier: "fast" | "frontier",
): CatalogModel | undefined {
  const models = listCatalogModels(provider).filter(
    (m) => m.input > 0 && m.context > 0,
  );
  if (models.length === 0) return undefined;
  return tier === "fast" ? models[0] : models[models.length - 1];
}

/**
 * Modèles réellement chargés par le serveur local (LM Studio / Ollama), via son
 * endpoint OpenAI-compatible `/v1/models`. Best-effort (renvoie [] si injoignable).
 */
export async function fetchLocalModels(
  baseUrl = process.env.LOCAL_AI_BASE_URL ?? "http://localhost:1234/v1",
): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}
