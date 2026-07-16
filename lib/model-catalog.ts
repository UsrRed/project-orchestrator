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
import { levelOf, type IntelligenceLevel } from "@/lib/intelligence";
import snapshot from "@/lib/models.dev.json";

export interface CatalogModel {
  id: string;
  name: string;
  /** Regroupement models.dev (« claude-opus », « gpt-nano »…), clé de la
   *  table d'intelligence. `null` pour quelques modèles OpenRouter. */
  family: string | null;
  /** USD / 1M tokens. */
  input: number;
  output: number;
  context: number;
  /** Tokens de sortie maximum (sert à écarter les embeddings). */
  maxOutput: number;
  reasoning: boolean;
  tool_call: boolean;
  /** `null` = models.dev ne sait pas, à distinguer d'un franc `false`. */
  structured_output: boolean | null;
  release_date: string | null;
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

/**
 * Le modèle est-il exploitable par ce produit ?
 *
 * Le catalogue mélange des modèles qui n'ont rien à faire dans un routeur de
 * texte : générateurs d'images/audio, embeddings, modèles retirés. Sans ce
 * filtre, la sélection par prix pouvait élire un modèle d'image comme « haut de
 * gamme » d'un provider.
 *
 * Doit rester aligné sur `isRoutable` de
 * [scripts/sync-models.ts](../scripts/sync-models.ts) (duplication assumée : un
 * script `tsx` ne peut pas importer ce module).
 */
function isRoutable(m: {
  id?: string;
  family?: string | null;
  status?: string | null;
  modalities?: { output?: string[] };
  cost?: { input?: number };
  limit?: { context?: number; output?: number };
}): boolean {
  if (m.status === "deprecated") return false;
  const out = m.modalities?.output ?? [];
  if (out.length !== 1 || out[0] !== "text") return false;
  if (m.cost?.input == null) return false;
  if (!m.limit?.context) return false;
  if ((m.limit.output ?? 0) < 256) return false;
  // Les embeddings d'OpenAI passent le seuil ci-dessus : models.dev range leur
  // **dimension** (1536, 3072…) dans `limit.output`, et leur déclare une sortie
  // « text ». Le nom reste le seul signal fiable.
  if (/embed/i.test(m.id ?? "") || /embed/i.test(m.family ?? "")) return false;
  return true;
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
        if (!isRoutable(m)) continue;
        const cost = (m.cost ?? {}) as { input?: number; output?: number };
        const limit = (m.limit ?? {}) as { context?: number; output?: number };
        models[mid] = {
          id: String(m.id ?? mid),
          name: String(m.name ?? mid),
          family: (m.family as string | null) ?? null,
          input: cost.input ?? 0,
          output: cost.output ?? 0,
          context: limit.context ?? 0,
          maxOutput: limit.output ?? 0,
          reasoning: Boolean(m.reasoning),
          tool_call: Boolean(m.tool_call),
          structured_output: (m.structured_output as boolean | null) ?? null,
          release_date: (m.release_date as string | null) ?? null,
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

/** Modèle à coût nul (OpenCode Zen « big-pickle », OpenRouter `:free`, …). */
export function isFreeModel(m: CatalogModel): boolean {
  return m.input === 0 && m.output === 0;
}

/**
 * Modèles gratuits exploitables par le routeur (tool-calling requis : l'agent
 * ne sait pas travailler sans), du plus grand contexte au plus petit.
 */
export function listFreeModels(provider: string): CatalogModel[] {
  return listCatalogModels(provider)
    .filter((m) => isFreeModel(m) && m.tool_call && m.context > 0)
    .sort((a, b) => b.context - a.context);
}

export function freeModelCount(provider: string): number {
  return listFreeModels(provider).length;
}

// --- Sélection par niveau d'intelligence ---------------------------------

export interface PickOptions {
  /** Ne considérer que les modèles gratuits. */
  free?: boolean;
  /**
   * Mode « boost » : prendre le **plus capable** disponible au lieu du moins
   * cher qui suffit. Pour les tâches où la qualité prime sur la dépense.
   */
  boost?: boolean;
  /**
   * Fenêtre de contexte minimale (tokens). Un modèle assez *intelligent* mais
   * trop *étroit* pour la tâche n'est pas un candidat : il tronquerait l'entrée
   * et raisonnerait sur autre chose que ce qu'on lui demande — un échec plus
   * insidieux qu'une erreur, puisqu'il rend une réponse plausible.
   */
  minContext?: number;
}

/**
 * Meilleur modèle d'un provider pour un niveau d'intelligence **minimum**.
 *
 * Politique par défaut : **le moins cher qui atteint le niveau requis**. C'est
 * la promesse du produit — ne pas payer un modèle frontière pour une tâche
 * qu'un modèle avancé traite. En `boost`, on prend le plus capable (et, à
 * niveau égal, le moins cher : au-delà du sommet, payer plus n'achète rien).
 *
 * Remplace l'ancienne heuristique « fast = le moins cher / frontier = le plus
 * cher », qui supposait prix ≈ capacité et pouvait élire n'importe quoi.
 *
 * `undefined` si le provider n'a aucun modèle atteignant ce niveau — l'appelant
 * passe alors au provider suivant plutôt que de dégrader silencieusement.
 */
export function pickModelForLevel(
  provider: string,
  minLevel: IntelligenceLevel,
  opts: PickOptions = {},
): CatalogModel | undefined {
  const pool = (opts.free ? listFreeModels(provider) : listCatalogModels(provider))
    .filter((m) => !opts.free || isFreeModel(m))
    .filter((m) => !opts.minContext || m.context >= opts.minContext)
    .map((m) => ({ m, level: levelOf(m) }))
    .filter((x) => x.level >= minLevel);

  if (pool.length === 0) return undefined;

  pool.sort((a, b) => {
    if (opts.boost && a.level !== b.level) return b.level - a.level;
    const costA = a.m.input + a.m.output / 3;
    const costB = b.m.input + b.m.output / 3;
    if (costA !== costB) return costA - costB;
    // À niveau et prix égaux, le plus récent : sans ça on élit arbitrairement
    // une vieille révision d'une famille (claude-opus-4-6 plutôt que 4-8).
    const dateA = a.m.release_date ?? "";
    const dateB = b.m.release_date ?? "";
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    // Départage stable : le plus grand contexte, puis l'id (déterminisme des
    // tests et des logs).
    if (a.m.context !== b.m.context) return b.m.context - a.m.context;
    return a.m.id.localeCompare(b.m.id);
  });

  return pool[0]!.m;
}

/**
 * Meilleur modèle **gratuit** atteignant le niveau, ou `undefined`.
 * Le routeur les essaie avant les payants : à niveau suffisant, dépenser n'a
 * pas de sens.
 */
export function pickFreeModelForLevel(
  provider: string,
  minLevel: IntelligenceLevel,
  opts: Omit<PickOptions, "free"> = {},
): CatalogModel | undefined {
  return pickModelForLevel(provider, minLevel, { ...opts, free: true });
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
