/**
 * Middleware d'authentification (Edge) — Milestone 7.2.
 *
 * Utilise la config Edge-safe (sans adapter DB) : la callback `authorized`
 * redirige les requêtes non authentifiées vers la page de connexion (sauf en
 * mode dev, cf. `auth.config.ts`).
 */
import NextAuth from "next-auth";

import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Applique à tout sauf les assets statiques et les routes d'auth.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
