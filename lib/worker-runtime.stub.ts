/**
 * Doublure de [worker-runtime.ts](worker-runtime.ts) pour les builds **hors
 * runtime Node** (edge du middleware, navigateur).
 *
 * `instrumentation.ts` est compilé pour tous les runtimes, et le bundler suit
 * l'import du worker sans tenir compte du garde `NEXT_RUNTIME === "nodejs"` : il
 * y tire alors Postgres, `node:child_process`, `node:fs`… que ces cibles ne
 * savent pas résoudre. La build casse avant que le garde ne s'exécute.
 *
 * `next.config.ts` substitue donc ce module au vrai dans ces passes. Aucune de
 * ces fonctions n'est jamais appelée — le garde empêche l'exécution — mais elles
 * lèvent plutôt que de ne rien faire : une queue silencieusement inerte serait
 * bien plus difficile à diagnostiquer qu'une erreur explicite.
 */

const MESSAGE =
  "worker-runtime n'existe que dans le runtime Node (cf. next.config.ts).";

export interface WorkerLoopHandle {
  stop(): void;
}

export function startWorkerLoop(): WorkerLoopHandle {
  throw new Error(MESSAGE);
}

export function processNextQueuedRun(): Promise<boolean> {
  throw new Error(MESSAGE);
}
