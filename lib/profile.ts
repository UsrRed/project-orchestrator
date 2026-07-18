/**
 * Profil / préférences utilisateur (une ligne par compte).
 *
 * Personnalise le comportement de l'IA (langue, ton, type de projet par défaut)
 * et fournit une valeur par défaut de budget. `getProfile` renvoie des valeurs
 * par défaut si aucun profil n'est encore enregistré.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import type { ProjectType } from "@/lib/architect";
import { profiles } from "@/drizzle/schema";

export interface Profile {
  displayName: string | null;
  language: string;
  tone: string;
  defaultProjectType: ProjectType;
  defaultBudgetUsd: number | null;
}

const DEFAULT_PROFILE: Profile = {
  displayName: null,
  language: "fr",
  tone: "neutre et professionnel",
  defaultProjectType: "tech",
  defaultBudgetUsd: null,
};

export async function getProfile(userId: string): Promise<Profile> {
  const [row] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    displayName: row.displayName,
    language: row.language,
    tone: row.tone,
    defaultProjectType: row.defaultProjectType as ProjectType,
    defaultBudgetUsd:
      row.defaultBudgetUsd != null ? Number(row.defaultBudgetUsd) : null,
  };
}

export interface ProfilePatch {
  displayName?: string | null;
  language?: string;
  tone?: string;
  defaultProjectType?: ProjectType;
  defaultBudgetUsd?: number | null;
}

export async function upsertProfile(
  userId: string,
  patch: ProfilePatch,
): Promise<void> {
  const values = {
    userId,
    displayName: patch.displayName ?? null,
    language: patch.language ?? DEFAULT_PROFILE.language,
    tone: (patch.tone ?? DEFAULT_PROFILE.tone).trim() || DEFAULT_PROFILE.tone,
    defaultProjectType: patch.defaultProjectType ?? "tech",
    defaultBudgetUsd:
      patch.defaultBudgetUsd != null && patch.defaultBudgetUsd > 0
        ? patch.defaultBudgetUsd.toFixed(4)
        : null,
  };
  await db
    .insert(profiles)
    .values(values)
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { ...values, updatedAt: new Date() },
    });
}

/** Consigne de préprompt dérivée du profil (langue + ton). */
export function profilePreamble(profile: Profile): string {
  const lang = profile.language === "en" ? "anglais" : "français";
  return `Réponds en ${lang}, sur un ton ${profile.tone}.`;
}
