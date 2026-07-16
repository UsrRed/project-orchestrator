/**
 * Configuration OAuth de l'application, stockée en base (Milestone 7.2b).
 *
 * Permet de saisir le `client_id` / `client_secret` de l'OAuth App GitHub
 * depuis l'UI (/setup) plutôt que via des variables d'environnement. Le secret
 * est chiffré (AES-256-GCM, lib/crypto). L'environnement reste un repli
 * (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET) pour la rétro-compatibilité.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { oauthConfig } from "@/drizzle/schema";

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
}

/** Creds GitHub effectifs : DB (prioritaire) puis repli env. Null si aucun. */
export async function getGitHubOAuthConfig(): Promise<OAuthCreds | null> {
  try {
    const [row] = await db
      .select()
      .from(oauthConfig)
      .where(eq(oauthConfig.provider, "github"))
      .limit(1);
    if (row) {
      return { clientId: row.clientId, clientSecret: decrypt(row.clientSecretEnc) };
    }
  } catch {
    // DB indisponible / secret indéchiffrable → on tente le repli env.
  }

  const envId = process.env.AUTH_GITHUB_ID ?? process.env.GITHUB_ID;
  const envSecret = process.env.AUTH_GITHUB_SECRET ?? process.env.GITHUB_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

  return null;
}

/** Enregistre (upsert) les creds GitHub, secret chiffré. */
export async function setGitHubOAuthConfig(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) throw new Error("Client ID et Client Secret requis.");

  await db
    .insert(oauthConfig)
    .values({
      provider: "github",
      clientId: id,
      clientSecretEnc: encrypt(secret),
    })
    .onConflictDoUpdate({
      target: oauthConfig.provider,
      set: { clientId: id, clientSecretEnc: encrypt(secret), updatedAt: new Date() },
    });
}

/** GitHub OAuth est-il configuré (DB ou env) ? */
export async function isGitHubConfigured(): Promise<boolean> {
  return (await getGitHubOAuthConfig()) !== null;
}

/** Le client_id configuré (pour affichage), sans exposer le secret. */
export async function getGitHubClientIdMasked(): Promise<string | null> {
  const creds = await getGitHubOAuthConfig();
  return creds?.clientId ?? null;
}
