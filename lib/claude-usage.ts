/**
 * Relevé de l'usage d'abonnement de Claude Code (`claude -p "/usage"`).
 *
 * **Pourquoi c'est sondable en boucle** : cette invocation ne fait aucun appel
 * API (`num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0` — vérifié sur
 * le binaire installé). Elle ne consomme donc rien de ce qu'elle mesure. Un
 * relevé qui ferait monter le compteur serait pire qu'inutile.
 *
 * **Ce que le quota mesure** : le login `claude` de la MACHINE, pas un compte
 * de l'app. Il inclut la consommation faite hors de l'app (sessions Claude Code
 * personnelles). Les deltas ne sont donc pas imputables aux seuls runs de
 * l'app — l'interface doit le dire, pas le masquer.
 */
import "server-only";

import { tmpdir } from "node:os";

import { desc, gte } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildEnv, runProcess } from "@/lib/process";
import { logWarn } from "@/lib/observability";
import { claudeUsageSamples } from "@/drizzle/schema";

/** Un relevé au plus par minute : au-delà, on rend le dernier connu. */
export const SAMPLE_THROTTLE_MS = 60_000;
/** La sonde répond en ~400 ms ; au-delà de 20 s, quelque chose est cassé. */
const PROBE_TIMEOUT_MS = 20_000;

export interface ClaudeLimit {
  /** Clé stable dérivée du libellé : permet de comparer deux relevés. */
  key: string;
  /** Libellé tel que rendu par le CLI (`Current week (all models)`). */
  label: string;
  percentUsed: number;
  /**
   * Échéance de remise à zéro, **texte brut du CLI** (`Jul 19, 11pm
   * (Europe/Paris)`). Non parsé en `Date` volontairement : la chaîne n'a pas
   * d'année et dépend de la locale — la reconstruire inventerait une précision
   * qu'on n'a pas.
   */
  resetsAt: string | null;
}

export interface ClaudeUsageSample {
  capturedAt: Date;
  limits: ClaudeLimit[];
  activeRuns: number;
}

/**
 * `Current week (all models)` → `week_all_models`. Le libellé est de
 * l'affichage ; la clé sert à apparier deux relevés.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/^current\s+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Extrait les limites du texte de `/usage`. Format attendu (sonde du
 * 2026-07-16) :
 *
 *     Current session: 6% used · resets Jul 17, 12:50am (Europe/Paris)
 *     Current week (all models): 8% used · resets Jul 19, 11pm (Europe/Paris)
 *
 * Le reste du texte (« What's contributing… ») est ignoré : ce sont des
 * statistiques locales approximatives, pas le quota.
 *
 * Ne jette jamais : un format qui change doit dégrader en « pas de donnée »,
 * pas casser le HUD.
 */
export function parseUsageText(text: string): ClaudeLimit[] {
  const re = /^(.+?):\s*([\d.,]+)\s*%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/;
  const out: ClaudeLimit[] = [];

  for (const line of text.split("\n")) {
    const m = re.exec(line.trim());
    if (!m) continue;

    const label = m[1]!.trim();
    const percentUsed = Number(m[2]!.replace(",", "."));
    if (!Number.isFinite(percentUsed)) continue;

    out.push({
      key: slugify(label),
      label,
      percentUsed,
      resetsAt: m[3]?.trim() || null,
    });
  }
  return out;
}

/** Dernier relevé connu, ou null si aucun n'a jamais été pris. */
export async function latestSample(): Promise<ClaudeUsageSample | null> {
  const [row] = await db
    .select()
    .from(claudeUsageSamples)
    .orderBy(desc(claudeUsageSamples.capturedAt))
    .limit(1);
  return row ? mapSample(row) : null;
}

/** Relevé le plus ancien de la fenêtre : le point de comparaison « avant ». */
export async function earliestSampleSince(
  since: Date,
): Promise<ClaudeUsageSample | null> {
  const [row] = await db
    .select()
    .from(claudeUsageSamples)
    .where(gte(claudeUsageSamples.capturedAt, since))
    .orderBy(claudeUsageSamples.capturedAt)
    .limit(1);
  return row ? mapSample(row) : null;
}

function mapSample(
  row: typeof claudeUsageSamples.$inferSelect,
): ClaudeUsageSample {
  return {
    capturedAt: row.capturedAt,
    limits: Array.isArray(row.limits) ? (row.limits as ClaudeLimit[]) : [],
    activeRuns: row.activeRuns,
  };
}

/**
 * Une seule sonde à la fois : deux requêtes HUD simultanées ne doivent pas
 * lancer deux processus. Les appels concurrents partagent la même promesse.
 */
let inFlight: Promise<ClaudeUsageSample | null> | null = null;

/**
 * Relève l'usage si le dernier relevé date de plus d'une minute, sinon rend
 * le dernier connu. Ne jette jamais : le HUD doit survivre à un `claude`
 * absent, non authentifié ou en erreur.
 */
export async function sampleClaudeUsage(
  activeRuns: number,
  now: Date = new Date(),
): Promise<ClaudeUsageSample | null> {
  const last = await latestSample();
  if (last && now.getTime() - last.capturedAt.getTime() < SAMPLE_THROTTLE_MS) {
    return last;
  }
  if (inFlight) return inFlight;

  inFlight = probeAndStore(activeRuns).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function probeAndStore(
  activeRuns: number,
): Promise<ClaudeUsageSample | null> {
  let limits: ClaudeLimit[];
  try {
    limits = await probe();
  } catch (err) {
    // `claude` absent du PATH, non authentifié, format changé… : on garde le
    // dernier relevé connu plutôt que d'afficher un faux zéro.
    logWarn("claude_usage.probe_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return latestSample();
  }

  // Rien de reconnu (compte sur clé API, format modifié) : ne pas écrire un
  // relevé vide, qui écraserait un historique exploitable par du bruit.
  if (limits.length === 0) return latestSample();

  const [row] = await db
    .insert(claudeUsageSamples)
    .values({ limits, activeRuns })
    .returning();
  return row ? mapSample(row) : null;
}

async function probe(): Promise<ClaudeLimit[]> {
  const r = await runProcess({
    bin: "claude",
    args: ["-p", "/usage", "--output-format", "json"],
    // Hors de tout projet : la sonde n'a aucune raison de voir un dépôt, et un
    // workspace non « trusted » ferait échouer le démarrage du CLI.
    cwd: tmpdir(),
    timeoutMs: PROBE_TIMEOUT_MS,
    // `buildEnv` retire les clés API du `.env` : sans ça, `claude` basculerait
    // sur la facturation à la clé et ne rapporterait plus l'abonnement.
    env: buildEnv(),
  });

  if (r.timedOut) throw new Error("La sonde `claude /usage` a expiré.");
  if (r.code !== 0) {
    throw new Error(
      `\`claude /usage\` a échoué (code ${r.code}) : ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
    );
  }

  const parsed = JSON.parse(r.stdout.trim()) as { result?: unknown };
  return parseUsageText(
    typeof parsed.result === "string" ? parsed.result : "",
  );
}
