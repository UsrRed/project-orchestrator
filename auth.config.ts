/**
 * Configuration Auth.js Edge-safe (Milestone 7.2).
 *
 * Ne contient QUE ce qui peut tourner dans le runtime Edge (middleware) :
 * providers, pages, callbacks. PAS d'adapter ni d'accès DB ici (postgres.js
 * n'est pas compatible Edge) — l'adapter est ajouté dans `auth.ts` (Node).
 */
import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

const githubId = process.env.AUTH_GITHUB_ID ?? process.env.GITHUB_ID;
const githubSecret =
  process.env.AUTH_GITHUB_SECRET ?? process.env.GITHUB_SECRET;

/** GitHub OAuth est-il configuré (id + secret présents) ? */
export function isGitHubConfigured(): boolean {
  return Boolean(githubId && githubSecret);
}

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
  // On n'enregistre le provider GitHub QUE s'il est configuré : sinon Auth.js
  // enverrait `client_id=undefined` à GitHub, qui répond 404.
  providers: isGitHubConfigured()
    ? [GitHub({ clientId: githubId, clientSecret: githubSecret })]
    : [],
  callbacks: {
    /** Gate d'accès du middleware : redirige les non-authentifiés (hors dev). */
    authorized({ auth, request }) {
      if (devBypass()) return true;
      const { pathname } = request.nextUrl;
      if (pathname.startsWith("/signin")) return true;
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
