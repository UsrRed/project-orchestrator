/**
 * Bouchon de `next/cache` pour les tests.
 *
 * Les Server Actions invalident leur page (`revalidatePath`), ce qui exige le
 * contexte d'une requête Next : hors serveur, l'appel lève. Le neutraliser est
 * ce qui permet aux tests fonctionnels d'exercer les **vraies actions** — donc
 * la validation des formulaires et l'enchaînement réel — plutôt que de
 * réimplémenter leur logique à côté et de tester une copie.
 *
 * Les chemins invalidés sont enregistrés : c'est un effet observable de
 * l'action, qu'un test peut vouloir vérifier.
 */
export const revalidatedPaths: string[] = [];
export const revalidatedTags: string[] = [];

export function revalidatePath(path: string): void {
  revalidatedPaths.push(path);
}

export function revalidateTag(tag: string): void {
  revalidatedTags.push(tag);
}

/** Les actions ne s'en servent pas ; présent pour que l'alias soit complet. */
export function unstable_noStore(): void {}
