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

/**
 * Vérifie la forme d'un client_id GitHub. Renvoie un message d'erreur, ou null
 * si l'identifiant est plausible.
 *
 * Motivation : un identifiant fantaisiste n'échoue qu'au moment du login, où
 * GitHub répond un **404 opaque** sur /login/oauth/authorize — impossible à
 * diagnostiquer pour l'utilisateur. On refuse donc à la saisie.
 *
 * On reste volontairement permissif sur les formats (GitHub les a déjà fait
 * évoluer : 20 hexas historiques, puis `Ov23li…`) : on rejette surtout les
 * valeurs d'exemple et les GitHub Apps, qui ignorent le paramètre `scope` dont
 * dépend l'accès aux dépôts ([lib/github.ts](github.ts)).
 */
export function validateGitHubClientId(clientId: string): string | null {
  const id = clientId.trim();
  if (!id) return "Client ID requis.";

  if (/^(Iv1\.|Iv23)/.test(id)) {
    return "Cet identifiant est celui d'une GitHub App, pas d'une OAuth App. Crée une OAuth App (lien ci-dessus) : les GitHub Apps ignorent les scopes dont l'app a besoin.";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.length < 16) {
    return "Client ID invalide. Copie celui affiché sur la page de ton OAuth App GitHub (ex. « Ov23li… » ou 20 caractères hexadécimaux).";
  }
  // Valeurs d'exemple de la doc GitHub, recopiées telles quelles.
  if (/client_?id|your_?client|xxxx|example/i.test(id)) {
    return "Client ID invalide : c'est une valeur d'exemple. Copie celui de ton OAuth App GitHub.";
  }
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

  const invalid = validateGitHubClientId(id);
  if (invalid) throw new Error(invalid);

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
