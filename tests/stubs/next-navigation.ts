/**
 * Bouchon de `next/navigation` pour les tests.
 *
 * `redirect()` **interrompt** l'exécution en levant : c'est ainsi que
 * `generateProjectAction` signale son succès (elle ne renvoie jamais). Le
 * bouchon garde cette sémantique — sans elle, un test croirait l'action tombée
 * en panne — mais expose l'URL proprement, au lieu du `digest` interne de Next.
 */
export class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT: ${url}`);
    this.name = "RedirectError";
  }
}

export class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export function redirect(url: string): never {
  throw new RedirectError(url);
}

export function notFound(): never {
  throw new NotFoundError();
}

/** URL de redirection si l'action a redirigé ; relance toute autre erreur. */
export function redirectUrlOf(err: unknown): string {
  if (err instanceof RedirectError) return err.url;
  throw err;
}
