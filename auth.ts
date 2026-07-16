/**
 * Auth.js (Node runtime) — Milestone 7.2.
 *
 * Reprend la config Edge-safe (`auth.config.ts`) et y ajoute l'adapter Drizzle
 * (persistance users/accounts en Postgres) et la stratégie de session JWT.
 * Exporte `auth`, `handlers`, `signIn`, `signOut`.
 */
import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/drizzle/schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
});
