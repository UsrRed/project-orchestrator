/**
 * Worker du mode Autonome (Milestone 4).
 *
 * Processus de fond distinct du serveur Next (le mode Autonome dépasse les
 * limites d'exécution serverless — cf. plan). Il interroge la queue durable
 * (`autonomous_runs`), réclame les runs un par un et les exécute jusqu'au bout
 * avec leurs garde-fous. Plusieurs instances peuvent tourner en parallèle sans
 * double traitement (claim `FOR UPDATE SKIP LOCKED`).
 *
 * Lancement :  npm run worker
 */
import { readFileSync } from "node:fs";

// Chargement minimal du .env (le worker n'est pas lancé par Next).
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && !process.env[m[1]]) {
      let v = (m[2] ?? "").trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch {
  // pas de .env : on suppose les variables déjà présentes dans l'environnement.
}

const POLL_INTERVAL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Imports dynamiques APRÈS chargement du .env (db.ts lit process.env à l'import).
  const { claimNextRun, finishRun } = await import("@/lib/runs");
  const { processRun } = await import("@/lib/worker");
  const { makeAutonomousDeps } = await import("@/lib/autonomous-agent");
  const { getDecryptedProviderKeys } = await import("@/lib/keys");
  const { captureException } = await import("@/lib/observability");

  console.log("[worker] démarré — polling de la queue autonomous_runs…");

  for (;;) {
    let claimed;
    try {
      claimed = await claimNextRun(new Date());
    } catch (err) {
      console.error("[worker] erreur de claim :", err);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(`[worker] run ${claimed.id} réclamé (objectif: ${claimed.goal})`);
    const keys = await getDecryptedProviderKeys(claimed.userId);
    if (Object.keys(keys).length === 0) {
      await finishRun(
        claimed.id,
        "failed",
        "error",
        "Aucune clé API disponible pour exécuter ce run.",
      );
      console.log(`[worker] run ${claimed.id} → échec (aucune clé)`);
      continue;
    }

    try {
      const final = await processRun(
        claimed,
        makeAutonomousDeps(claimed.userId, keys),
      );
      console.log(
        `[worker] run ${claimed.id} → ${final.status} (${final.stopReason ?? "?"}) ` +
          `· ${final.iterations} itérations · $${final.spentUsd.toFixed(6)}`,
      );
    } catch (err) {
      await finishRun(
        claimed.id,
        "failed",
        "error",
        err instanceof Error ? err.message : String(err),
      );
      await captureException(err, "worker.run_error", { runId: claimed.id });
      console.error(`[worker] run ${claimed.id} → erreur :`, err);
    }
  }
}

main().catch((err) => {
  console.error("[worker] arrêt sur erreur fatale :", err);
  process.exit(1);
});
