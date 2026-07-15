/**
 * Bootstrap utilisateur — mono-compte (M1).
 *
 * L'authentification complète (Auth.js) arrivera à un jalon ultérieur. En
 * attendant, Orchestrato fonctionne en usage personnel mono-utilisateur : on
 * résout (ou crée) un unique "utilisateur local" auquel sont rattachés les
 * clés API et les exécutions. Ce point d'indirection isole tout le reste du
 * code (services, actions) de l'absence de session, de sorte que l'ajout de
 * l'auth ne touchera QUE ce fichier.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/drizzle/schema";

const LOCAL_USER_EMAIL = "local@orchestrato.dev";

/** Résout l'utilisateur local, en le créant à la première utilisation. */
export async function getCurrentUserId(): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, LOCAL_USER_EMAIL))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(users)
    .values({ email: LOCAL_USER_EMAIL, name: "Utilisateur local" })
    // Si deux requêtes concurrentes tentent la création, la contrainte unique
    // sur email fait qu'une seule gagne ; l'autre récupère la ligne existante.
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  if (inserted[0]) return inserted[0].id;

  const afterConflict = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, LOCAL_USER_EMAIL))
    .limit(1);

  if (!afterConflict[0]) {
    throw new Error("Impossible de résoudre l'utilisateur local.");
  }
  return afterConflict[0].id;
}
