/**
 * Instrumentation Next.js (Milestone 7.4).
 *
 * Deux rôles :
 *  - Sentry côté serveur, UNIQUEMENT si `SENTRY_DSN` est défini — sinon no-op
 *    (l'app tourne sans compte Sentry). Capture aussi les erreurs de requête.
 *  - le **worker de la queue autonome**, démarré dans le process Next.
 */

/**
 * Démarre la boucle du worker avec le serveur.
 *
 * Un run « en file » qui attend qu'on lance un second processus à la main n'est
 * pas autonome : `npm run dev` et `npm start` vident donc la file d'eux-mêmes.
 *
 * Mettre à `0` pour un déploiement où le web est séparé du worker — serverless
 * (le mode Autonome dépasse les limites d'exécution d'une requête), ou worker
 * dédié lancé par `npm run worker`. Le claim étant atomique
 * (`FOR UPDATE SKIP LOCKED`), un worker inline et un worker dédié peuvent
 * coexister sans double traitement ; c'est une question de ressources, pas de
 * correction.
 */
function inlineWorkerEnabled(): boolean {
  return process.env.INLINE_WORKER !== "0";
}

export async function register(): Promise<void> {
  const runtime = process.env.NEXT_RUNTIME;

  if (process.env.SENTRY_DSN && (runtime === "nodejs" || runtime === "edge")) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  }

  // `nodejs` seulement : le runtime edge n'a ni `pg` ni processus long.
  if (runtime !== "nodejs" || !inlineWorkerEnabled()) return;
  // Import dynamique : ce module tire la base et les agents CLI, qui n'ont rien
  // à faire dans un bundle edge.
  const { startWorkerLoop } = await import("@/lib/worker-runtime");
  startWorkerLoop();
}

export async function onRequestError(
  ...args: Parameters<
    typeof import("@sentry/nextjs").captureRequestError
  >
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
}
