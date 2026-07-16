/**
 * Résolution de l'utilisateur courant (M1 → M7.2).
 *
 * Ordre de résolution :
 *  1. **Session Auth.js** (GitHub OAuth) si une requête authentifiée est en
 *     cours — c'est le cas nominal en production.
 *  2. **Repli développement / worker** : un unique "utilisateur local" (créé à
 *     la volée) quand il n'y a pas de session — hors production, ou pour les
 *     scripts/worker qui tournent hors contexte requête. Contrôlé par
 *     `ALLOW_DEV_USER=true` ou `NODE_ENV !== 'production'`.
 *  3. Sinon (production, non authentifié) : erreur.
 *
 * Ce point d'indirection isole tout le reste du code (services, actions) : ils
 * prennent un `userId` et n'ont pas connaissance de l'auth.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/drizzle/schema";

const LOCAL_USER_EMAIL = "local@orchestrato.dev";

function devFallbackAllowed(): boolean {
  return (
    process.env.ALLOW_DEV_USER === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

export async function getCurrentUserId(): Promise<string> {
  // 1. Session Auth.js. Import dynamique : évite de charger next-auth hors
  //    contexte requête (scripts tsx, worker) où `auth()` n'est pas disponible.
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    const id = session?.user?.id;
    if (id) return id;
  } catch {
    // Hors contexte requête / auth non chargeable → repli ci-dessous.
  }

  // 2. Repli développement / worker.
  if (devFallbackAllowed()) return getOrCreateLocalUser();

  // 3. Production, non authentifié.
  throw new Error("Non authentifié.");
}

/** Résout (ou crée) l'utilisateur local de repli. */
async function getOrCreateLocalUser(): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, LOCAL_USER_EMAIL))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(users)
    .values({ email: LOCAL_USER_EMAIL, name: "Utilisateur local" })
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
