/**
 * Worker autonome **dédié** (Milestone 4).
 *
 * Depuis que `instrumentation.ts` démarre la même boucle dans le process Next,
 * ce script n'est plus nécessaire au quotidien : `npm run dev` / `npm start`
 * vident déjà la file. Il reste utile pour déporter l'exécution — serveur web
 * serverless, ou machine séparée qui porte les agents CLI — auquel cas on pose
 * `INLINE_WORKER=0` côté web.
 *
 * La boucle elle-même vit dans [lib/worker-runtime.ts](../lib/worker-runtime.ts) :
 * ici on ne fait que charger le `.env` (Next ne le fait pas pour nous) et la
 * démarrer. Deux workers en parallèle ne se marchent pas dessus : le claim est
 * atomique (`FOR UPDATE SKIP LOCKED`) et le verrou bat pendant tout le
 * traitement — c'est ce battement, et non le claim seul, qui empêche un run long
 * (agent CLI) d'être repris alors qu'il tourne encore.
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

async function main(): Promise<void> {
  // Import dynamique APRÈS chargement du .env (db.ts lit process.env à l'import).
  const { startWorkerLoop } = await import("@/lib/worker-runtime");

  console.log("[worker] démarré — polling de la queue autonomous_runs…");
  const handle = startWorkerLoop();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[worker] ${sig} reçu — arrêt après le run en cours.`);
      handle.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[worker] arrêt sur erreur fatale :", err);
  process.exit(1);
});
