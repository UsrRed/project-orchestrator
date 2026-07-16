/**
 * Configuration Auth.js Edge-safe (Milestone 7.2).
 *
 * Ne contient QUE ce qui peut tourner dans le runtime Edge (middleware) :
 * pages, callbacks. Les providers sont injectés dynamiquement dans `auth.ts`
 * (Node) à partir des creds stockés en base — pas d'accès DB ici.
 */
import type { NextAuthConfig } from "next-auth";

/** L'auth est-elle contournée (dev/test) ? Sinon elle est appliquée. */
function devBypass(): boolean {
  return (
    process.env.ALLOW_DEV_USER === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

export const authConfig = {
  trustHost: true,
  pages: { signIn: "/signin" },
  // Providers injectés dynamiquement dans auth.ts (creds en base).
  providers: [],
  callbacks: {
    /** Gate d'accès du middleware : redirige les non-authentifiés (hors dev). */
    authorized({ auth, request }) {
      if (devBypass()) return true;
      const { pathname } = request.nextUrl;
      // Pages publiques : connexion et configuration OAuth initiale.
      if (pathname.startsWith("/signin") || pathname.startsWith("/setup")) {
        return true;
      }
      return !!auth?.user;
    },
    /** Propage l'id utilisateur dans le token (stratégie JWT). */
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    /** Expose l'id utilisateur côté session. */
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") {
        session.user.id = token.uid;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
