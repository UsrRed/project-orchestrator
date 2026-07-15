/**
 * Service CRUD des clés API utilisateur (Milestone 1).
 *
 * Règles de sécurité (cf. plan, section sécurité) :
 *  - la clé en clair n'entre en base QUE chiffrée (AES-256-GCM via lib/crypto) ;
 *  - la clé en clair ne ressort JAMAIS vers le client : l'UI ne reçoit qu'un
 *    aperçu masqué (`masked`) ;
 *  - le déchiffrement (`getDecryptedProviderKeys`) est réservé au serveur, au
 *    moment d'exécuter un appel via le routeur.
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { decrypt, encrypt, maskSecret } from "@/lib/crypto";
import type { Provider } from "@/lib/models";
import type { ProviderKeys } from "@/lib/llm-router";
import { apiKeys } from "@/drizzle/schema";

export interface ApiKeyView {
  id: string;
  provider: Provider;
  label: string | null;
  /** Aperçu masqué (jamais la clé en clair). */
  masked: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** Liste les clés d'un utilisateur, masquées, pour l'affichage UI. */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as Provider,
    label: r.label,
    masked: safeMask(r.encryptedKey),
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

function safeMask(encryptedKey: string): string {
  try {
    return maskSecret(decrypt(encryptedKey));
  } catch {
    // Clé indéchiffrable (mauvaise master key / donnée altérée) : on ne
    // divulgue rien, mais on signale le problème dans l'UI.
    return "⚠️ indéchiffrable";
  }
}

/** Ajoute (ou remplace) une clé chiffrée pour un provider. */
export async function addApiKey(
  userId: string,
  provider: Provider,
  plaintextKey: string,
  label: string | null,
): Promise<void> {
  const trimmed = plaintextKey.trim();
  if (!trimmed) throw new Error("La clé API est vide.");

  const encryptedKey = encrypt(trimmed);

  // La contrainte unique (userId, provider, label) permet un upsert propre :
  // ré-ajouter la même (provider,label) met à jour la clé plutôt que d'échouer.
  await db
    .insert(apiKeys)
    .values({ userId, provider, label, encryptedKey })
    .onConflictDoUpdate({
      target: [apiKeys.userId, apiKeys.provider, apiKeys.label],
      set: { encryptedKey, updatedAt: new Date() },
    });
}

/** Supprime une clé (scopée à l'utilisateur pour éviter toute fuite inter-compte). */
export async function deleteApiKey(userId: string, id: string): Promise<void> {
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
}

/**
 * Déchiffre l'ensemble des clés de l'utilisateur pour alimenter le routeur.
 * SERVEUR UNIQUEMENT — ne jamais renvoyer ce résultat au client.
 */
export async function getDecryptedProviderKeys(
  userId: string,
): Promise<ProviderKeys> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));

  const keys: ProviderKeys = {};
  for (const r of rows) {
    try {
      // La première clé rencontrée par provider gagne (une seule clé par
      // provider est nécessaire au routeur M1).
      if (!keys[r.provider as Provider]) {
        keys[r.provider as Provider] = decrypt(r.encryptedKey);
      }
    } catch {
      // On ignore les clés indéchiffrables plutôt que de faire planter le run.
    }
  }
  return keys;
}

/** Marque une clé comme utilisée (traçabilité `lastUsedAt`). */
export async function touchProviderKey(
  userId: string,
  provider: Provider,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)));
}
