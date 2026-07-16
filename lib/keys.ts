/**
 * Connecteurs LLM de l'utilisateur (Milestone 1 → connecteurs multi-méthodes).
 *
 * Une connexion associe un provider à une méthode :
 *  - 'api_key' / 'oauth' : un secret (clé API ou jeton OAuth) stocké CHIFFRÉ ;
 *  - 'none' : aucune credential (serveur local).
 *
 * Règles de sécurité : le secret n'entre en base que chiffré (AES-256-GCM), ne
 * ressort jamais vers le client (UI = aperçu masqué), et n'est déchiffré que
 * côté serveur au moment de router un appel.
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { decrypt, encrypt, maskSecret } from "@/lib/crypto";
import type { Provider } from "@/lib/models";
import type { ProviderKeys } from "@/lib/llm-router";
import type { ConnMethod } from "@/lib/providers";
import { apiKeys } from "@/drizzle/schema";

export interface ConnectionView {
  id: string;
  provider: Provider;
  method: ConnMethod;
  label: string | null;
  /** Aperçu masqué du secret (ou libellé pour 'none'). */
  masked: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function safeMask(method: ConnMethod, encryptedKey: string | null): string {
  if (method === "none") return "— (local, sans credential)";
  if (!encryptedKey) return "⚠️ secret manquant";
  try {
    return maskSecret(decrypt(encryptedKey));
  } catch {
    return "⚠️ indéchiffrable";
  }
}

/** Liste les connexions d'un utilisateur, secrets masqués, pour l'UI. */
export async function listConnections(
  userId: string,
): Promise<ConnectionView[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as Provider,
    method: r.method as ConnMethod,
    label: r.label,
    masked: safeMask(r.method as ConnMethod, r.encryptedKey),
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

/** Ajoute (ou remplace) une connexion pour un provider selon sa méthode. */
export async function addConnection(
  userId: string,
  provider: Provider,
  method: ConnMethod,
  secret: string | null,
  label: string | null,
): Promise<void> {
  let encryptedKey: string | null = null;
  if (method !== "none") {
    const trimmed = (secret ?? "").trim();
    if (!trimmed) {
      throw new Error("Un secret (clé API ou jeton) est requis pour cette méthode.");
    }
    encryptedKey = encrypt(trimmed);
  }

  await db
    .insert(apiKeys)
    .values({ userId, provider, method, label, encryptedKey })
    .onConflictDoUpdate({
      target: [apiKeys.userId, apiKeys.provider, apiKeys.label],
      set: { method, encryptedKey, updatedAt: new Date() },
    });
}

/** Supprime une connexion (scopée à l'utilisateur). */
export async function deleteConnection(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
}

/**
 * Connexions déchiffrées de l'utilisateur, indexées par provider (première
 * gagnante), pour alimenter le routeur. SERVEUR UNIQUEMENT.
 */
export async function getProviderConnections(
  userId: string,
): Promise<ProviderKeys> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));

  const conns: ProviderKeys = {};
  for (const r of rows) {
    const provider = r.provider as Provider;
    if (conns[provider]) continue; // première connexion par provider
    const method = r.method as ConnMethod;
    if (method === "none") {
      conns[provider] = { method };
      continue;
    }
    if (!r.encryptedKey) continue;
    try {
      conns[provider] = { method, secret: decrypt(r.encryptedKey) };
    } catch {
      // secret indéchiffrable → on ignore cette connexion
    }
  }
  return conns;
}

/** Marque une connexion comme utilisée (traçabilité). */
export async function touchProviderKey(
  userId: string,
  provider: Provider,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider)));
}
