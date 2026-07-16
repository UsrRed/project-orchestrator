/**
 * Auth.js (Node runtime) — Milestone 7.2 / 7.2b.
 *
 * Config DYNAMIQUE (forme fonction) : à chaque requête, on charge les creds de
 * l'OAuth App GitHub depuis la base (saisis via /setup, secret chiffré) et on
 * enregistre le provider en conséquence — aucun redémarrage nécessaire quand
 * l'utilisateur configure l'OAuth. Ajoute l'adapter Drizzle et la session JWT.
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/drizzle/schema";
import { getGitHubOAuthConfig } from "@/lib/oauth-config";

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const gh = await getGitHubOAuthConfig();
  return {
    ...authConfig,
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    session: { strategy: "jwt" },
    providers: gh
      ? [GitHub({ clientId: gh.clientId, clientSecret: gh.clientSecret })]
      : [],
  };
});
