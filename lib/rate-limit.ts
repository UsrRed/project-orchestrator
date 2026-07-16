/**
 * Rate-limiting par provider (Milestone 7.1).
 *
 * Fenêtre glissante en mémoire, par provider : on borne le nombre d'appels par
 * minute pour ne pas heurter les limites des providers. Le routeur consulte
 * `tryAcquire` avant chaque appel et, en cas de refus, bascule sur le provider
 * suivant de la chaîne de fallback.
 *
 * NOTE : l'état est EN MÉMOIRE (par instance de process). Pour un déploiement
 * multi-instance (serverless), remplacer par un store partagé (Upstash Redis).
 * Le provider local `ollama` (LM Studio) est exempté (illimité).
 */
import type { Provider } from "@/lib/models";

const WINDOW_MS = 60_000;

/** Limites indicatives (requêtes/minute) — ajustables via l'env plus tard. */
const RPM: Record<Provider, number> = {
  ollama: Number.POSITIVE_INFINITY, // local, gratuit → illimité
  groq: 30,
  google: 15,
  openai: 60,
  openrouter: 60,
  opencode: 60,
  anthropic: 50,
};

const windows = new Map<Provider, number[]>();

/**
 * Tente de consommer un jeton pour ce provider. Renvoie true si l'appel est
 * autorisé (et enregistre l'horodatage), false si la limite est atteinte.
 */
export function tryAcquire(provider: Provider, now: number = Date.now()): boolean {
  const limit = RPM[provider] ?? 60;
  if (!Number.isFinite(limit)) return true;

  const recent = (windows.get(provider) ?? []).filter(
    (t) => now - t < WINDOW_MS,
  );
  if (recent.length >= limit) {
    windows.set(provider, recent);
    return false;
  }
  recent.push(now);
  windows.set(provider, recent);
  return true;
}

/** Nombre d'appels dans la fenêtre courante (observabilité/tests). */
export function currentUsage(provider: Provider, now: number = Date.now()): number {
  return (windows.get(provider) ?? []).filter((t) => now - t < WINDOW_MS).length;
}

/** Réinitialise l'état (tests). */
export function resetRateLimits(): void {
  windows.clear();
}
