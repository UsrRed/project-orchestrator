/**
 * Observabilité (Milestone 7.4) — logs structurés + capture d'erreurs.
 *
 * Émet des logs JSON structurés (level, event, contexte, horodatage) sur la
 * sortie standard — exploitables par n'importe quel agrégateur. Les erreurs
 * sont aussi remontées à **Sentry** SI `SENTRY_DSN` est défini (sinon no-op) :
 * l'intégration est donc opt-in, l'app fonctionne sans compte Sentry.
 *
 * La table `agent_executions` reste la table de vérité du coût et des statuts
 * (succeeded/failed) — l'écran /health s'appuie dessus.
 */
export type LogLevel = "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

function emit(level: LogLevel, event: string, context?: LogContext): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(event: string, context?: LogContext): void {
  emit("info", event, context);
}

export function logWarn(event: string, context?: LogContext): void {
  emit("warn", event, context);
}

/**
 * Journalise une erreur (log structuré) et la remonte à Sentry si configuré.
 * Ne lève jamais : l'observabilité ne doit pas casser le flux applicatif.
 */
export async function captureException(
  err: unknown,
  event: string,
  context?: LogContext,
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  emit("error", event, {
    ...context,
    error: error.message,
    stack: error.stack,
  });

  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(error, { tags: { event }, extra: context });
  } catch {
    // Sentry indisponible (non initialisé / hors runtime) → on se contente du log.
  }
}
