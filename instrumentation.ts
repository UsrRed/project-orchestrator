/**
 * Instrumentation Next.js (Milestone 7.4).
 *
 * Initialise Sentry côté serveur UNIQUEMENT si `SENTRY_DSN` est défini — sinon
 * no-op (l'app tourne sans compte Sentry). Capture aussi les erreurs de requête.
 */
export async function register(): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  const runtime = process.env.NEXT_RUNTIME;
  if (runtime === "nodejs" || runtime === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  }
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
