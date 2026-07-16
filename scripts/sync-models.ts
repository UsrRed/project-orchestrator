/**
 * Régénère le snapshot embarqué du catalogue models.dev (`lib/models.dev.json`).
 *
 * Le snapshot garantit un fonctionnement hors-ligne / en CI ; le rafraîchissement
 * live ([lib/model-catalog.ts](../lib/model-catalog.ts)) suit le même filtrage.
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
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  reasoning?: boolean;
  tool_call?: boolean;
}

interface RawProvider {
  id?: string;
  name?: string;
  npm?: string | null;
  api?: string | null;
  env?: string[];
  models?: Record<string, RawModel>;
}

const res = await fetch("https://models.dev/api.json");
if (!res.ok) throw new Error(`models.dev a répondu ${res.status}`);
const raw = (await res.json()) as Record<string, RawProvider>;

const snapshot: Record<string, unknown> = {};
for (const pid of SUPPORTED) {
  const p = raw[pid];
  if (!p) throw new Error(`Provider « ${pid} » absent de models.dev.`);

  const models: Record<string, unknown> = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    // Coût inconnu → modèle inexploitable par le routeur (pas de comparaison
    // possible). Un coût à 0 est en revanche légitime : modèle gratuit.
    if (m.cost?.input == null) continue;
    if (!m.limit?.context) continue;
    models[mid] = {
      id: String(m.id ?? mid),
      name: String(m.name ?? mid),
      input: m.cost.input,
      output: m.cost.output ?? 0,
      context: m.limit.context,
      reasoning: Boolean(m.reasoning),
      tool_call: Boolean(m.tool_call),
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
    (m) => (m as { input: number; output: number }).input === 0 &&
      (m as { output: number }).output === 0,
  ).length;
  console.log(`${pid}: ${Object.keys(models).length} modèles (${free} gratuits)`);
}

const out = join(import.meta.dirname, "..", "lib", "models.dev.json");
await writeFile(out, JSON.stringify(snapshot));
console.log(`→ ${out}`);
