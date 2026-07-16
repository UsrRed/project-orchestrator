/**
 * Régénère le snapshot embarqué du catalogue models.dev (`lib/models.dev.json`).
 *
 * Le snapshot garantit un fonctionnement hors-ligne / en CI ; le rafraîchissement
 * live ([lib/model-catalog.ts](../lib/model-catalog.ts)) suit le même filtrage —
 * les deux doivent rester alignés (`isRoutable` y est dupliqué volontairement :
 * ce script ne peut pas importer un module `server-only`).
 *
 * Usage : `npx tsx scripts/sync-models.ts`
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Providers embarqués dans le snapshot (doit rester aligné sur `Provider`). */
const SUPPORTED = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "openrouter",
  "opencode",
] as const;

interface RawModel {
  id?: string;
  name?: string;
  family?: string | null;
  status?: string | null;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean | null;
  release_date?: string | null;
}

interface RawProvider {
  id?: string;
  name?: string;
  npm?: string | null;
  api?: string | null;
  env?: string[];
  models?: Record<string, RawModel>;
}

/**
 * Le modèle est-il exploitable par ce produit ?
 *
 * Le catalogue mélange des modèles qui n'ont rien à faire dans un routeur de
 * texte : générateurs d'images/audio, embeddings, modèles retirés. Les laisser
 * passer n'est pas anodin — la sélection « le plus cher » d'un tier pouvait
 * élire un modèle d'image.
 */
function isRoutable(m: RawModel): boolean {
  if (m.status === "deprecated") return false;
  // Sortie strictement textuelle : « text+image » = générateur d'images.
  const out = m.modalities?.output ?? [];
  if (out.length !== 1 || out[0] !== "text") return false;
  // Coût inconnu → incomparable. Un coût à 0 est légitime (modèle gratuit).
  if (m.cost?.input == null) return false;
  if (!m.limit?.context) return false;
  // Un modèle qui ne peut émettre que quelques tokens est un embedding ou un
  // classifieur, pas un modèle de génération (ex: gemini-embedding-001 → 1).
  if ((m.limit.output ?? 0) < 256) return false;
  // Les embeddings d'OpenAI passent le seuil ci-dessus : models.dev range leur
  // **dimension** (1536, 3072…) dans `limit.output`, et leur déclare une sortie
  // « text ». Le nom reste le seul signal fiable.
  if (isEmbedding(m)) return false;
  return true;
}

function isEmbedding(m: RawModel): boolean {
  return /embed/i.test(m.id ?? "") || /embed/i.test(m.family ?? "");
}

const res = await fetch("https://models.dev/api.json");
if (!res.ok) throw new Error(`models.dev a répondu ${res.status}`);
const raw = (await res.json()) as Record<string, RawProvider>;

const snapshot: Record<string, unknown> = {};
let dropped = 0;

for (const pid of SUPPORTED) {
  const p = raw[pid];
  if (!p) throw new Error(`Provider « ${pid} » absent de models.dev.`);

  const models: Record<string, unknown> = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    if (!isRoutable(m)) {
      dropped++;
      continue;
    }
    models[mid] = {
      id: String(m.id ?? mid),
      name: String(m.name ?? mid),
      // `family` est le regroupement fourni par models.dev (« claude-opus »,
      // « gpt-nano »…) : c'est la clé de la table d'intelligence curée.
      family: m.family ?? null,
      input: m.cost!.input,
      output: m.cost!.output ?? 0,
      context: m.limit!.context,
      maxOutput: m.limit!.output ?? 0,
      reasoning: Boolean(m.reasoning),
      tool_call: Boolean(m.tool_call),
      // `null` = inconnu de models.dev, à distinguer d'un franc `false`.
      structured_output: m.structured_output ?? null,
      release_date: m.release_date ?? null,
    };
  }

  snapshot[pid] = {
    id: pid,
    name: p.name ?? pid,
    npm: p.npm ?? null,
    api: p.api ?? null,
    env: p.env ?? [],
    models,
  };
  const free = Object.values(models).filter(
    (m) =>
      (m as { input: number }).input === 0 &&
      (m as { output: number }).output === 0,
  ).length;
  console.log(`${pid}: ${Object.keys(models).length} modèles (${free} gratuits)`);
}

console.log(`(${dropped} modèles écartés : retirés, non-textuels, embeddings…)`);

const out = join(import.meta.dirname, "..", "lib", "models.dev.json");
await writeFile(out, JSON.stringify(snapshot));
console.log(`→ ${out}`);
