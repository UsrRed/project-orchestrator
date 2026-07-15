/**
 * Bibliothèque de Normes / Skills (Milestone 5).
 *
 * Une `Norme` est une consigne réutilisable (charte, guide méthodo, style) que
 * l'on associe à des phases et qu'on injecte en préprompt au démarrage d'une
 * phase. L'injection est TRAÇABLE : `buildPhaseNormsContext` renvoie à la fois
 * le texte injecté et la liste des normes appliquées.
 *
 * Portée (`scope`) : `global` (réutilisable inter-projets) ou `project`
 * (spécifique). L'association peut être automatique (par catégorie ↔ type de
 * phase) ou manuelle.
 */
import "server-only";

import { and, desc, eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  normes,
  phaseNormeAssociations,
  phases,
  projects,
} from "@/drizzle/schema";

export type NormeScope = "global" | "project";

export interface NormeView {
  id: string;
  name: string;
  category: string | null;
  promptContent: string;
  scope: NormeScope;
  projectId: string | null;
  createdAt: Date;
}

function mapNorme(r: typeof normes.$inferSelect): NormeView {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    promptContent: r.promptContent,
    scope: r.scope as NormeScope,
    projectId: r.projectId,
    createdAt: r.createdAt,
  };
}

// --- CRUD ----------------------------------------------------------------

export async function createNorme(
  userId: string,
  input: {
    name: string;
    category: string | null;
    promptContent: string;
    scope: NormeScope;
    projectId?: string | null;
  },
): Promise<string> {
  const name = input.name.trim();
  const content = input.promptContent.trim();
  if (!name) throw new Error("Nom de la norme vide.");
  if (!content) throw new Error("Contenu de la norme vide.");
  if (input.scope === "project" && !input.projectId) {
    throw new Error("Une norme de portée 'project' requiert un projet.");
  }

  const [row] = await db
    .insert(normes)
    .values({
      userId,
      name,
      category: input.category?.trim() || null,
      promptContent: content,
      scope: input.scope,
      projectId: input.scope === "project" ? (input.projectId ?? null) : null,
    })
    .returning({ id: normes.id });
  if (!row) throw new Error("Échec de création de la norme.");
  return row.id;
}

export async function listNormes(userId: string): Promise<NormeView[]> {
  const rows = await db
    .select()
    .from(normes)
    .where(eq(normes.userId, userId))
    .orderBy(desc(normes.createdAt));
  return rows.map(mapNorme);
}

/** Normes candidates pour un projet : globales + spécifiques à ce projet. */
export async function listNormesForProject(
  userId: string,
  projectId: string,
): Promise<NormeView[]> {
  const rows = await db
    .select()
    .from(normes)
    .where(
      and(
        eq(normes.userId, userId),
        or(eq(normes.scope, "global"), eq(normes.projectId, projectId)),
      ),
    )
    .orderBy(desc(normes.createdAt));
  return rows.map(mapNorme);
}

export async function updateNorme(
  userId: string,
  normeId: string,
  patch: { name?: string; category?: string | null; promptContent?: string },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Nom de la norme vide.");
    set.name = patch.name.trim();
  }
  if (patch.category !== undefined) set.category = patch.category?.trim() || null;
  if (patch.promptContent !== undefined) {
    if (!patch.promptContent.trim()) throw new Error("Contenu vide.");
    set.promptContent = patch.promptContent.trim();
  }
  if (Object.keys(set).length === 0) return;
  await db
    .update(normes)
    .set(set)
    .where(and(eq(normes.id, normeId), eq(normes.userId, userId)));
}

export async function deleteNorme(
  userId: string,
  normeId: string,
): Promise<void> {
  await db
    .delete(normes)
    .where(and(eq(normes.id, normeId), eq(normes.userId, userId)));
}

// --- Appartenance (phase → projet → user) -------------------------------

async function assertOwnedPhase(
  userId: string,
  phaseId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: phases.id })
    .from(phases)
    .innerJoin(projects, eq(projects.id, phases.projectId))
    .where(and(eq(phases.id, phaseId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Phase introuvable ou non autorisée.");
}

async function assertOwnedNorme(
  userId: string,
  normeId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: normes.id })
    .from(normes)
    .where(and(eq(normes.id, normeId), eq(normes.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Norme introuvable ou non autorisée.");
}

// --- Association ---------------------------------------------------------

export async function associateNorme(
  userId: string,
  phaseId: string,
  normeId: string,
  autoApplied = false,
): Promise<void> {
  await assertOwnedPhase(userId, phaseId);
  await assertOwnedNorme(userId, normeId);
  await db
    .insert(phaseNormeAssociations)
    .values({ phaseId, normeId, autoApplied })
    .onConflictDoNothing({
      target: [phaseNormeAssociations.phaseId, phaseNormeAssociations.normeId],
    });
}

export async function dissociateNorme(
  userId: string,
  phaseId: string,
  normeId: string,
): Promise<void> {
  await assertOwnedPhase(userId, phaseId);
  await db
    .delete(phaseNormeAssociations)
    .where(
      and(
        eq(phaseNormeAssociations.phaseId, phaseId),
        eq(phaseNormeAssociations.normeId, normeId),
      ),
    );
}

/**
 * Auto-associe les normes correspondantes à TOUTES les phases d'un projet
 * (appelé à la création du projet). Renvoie le total d'associations créées.
 */
export async function autoAssociateProjectNorms(
  userId: string,
  projectId: string,
): Promise<number> {
  const projectPhases = await db
    .select({ id: phases.id, type: phases.type })
    .from(phases)
    .innerJoin(projects, eq(projects.id, phases.projectId))
    .where(and(eq(phases.projectId, projectId), eq(projects.userId, userId)));

  let total = 0;
  for (const p of projectPhases) {
    total += await autoAssociateByPhaseType(userId, p.id, p.type);
  }
  return total;
}

/**
 * Association automatique par type de phase : associe les normes de
 * l'utilisateur dont la `category` (insensible à la casse) correspond au type
 * de la phase, en les marquant `autoApplied`. Renvoie le nombre associé.
 */
export async function autoAssociateByPhaseType(
  userId: string,
  phaseId: string,
  phaseType: string | null,
): Promise<number> {
  if (!phaseType) return 0;
  await assertOwnedPhase(userId, phaseId);

  const candidates = await db
    .select()
    .from(normes)
    .where(eq(normes.userId, userId));

  const matching = candidates.filter(
    (n) => n.category && n.category.toLowerCase() === phaseType.toLowerCase(),
  );
  if (matching.length === 0) return 0;

  await db
    .insert(phaseNormeAssociations)
    .values(
      matching.map((n) => ({ phaseId, normeId: n.id, autoApplied: true })),
    )
    .onConflictDoNothing({
      target: [phaseNormeAssociations.phaseId, phaseNormeAssociations.normeId],
    });
  return matching.length;
}

// --- Lecture des associations + injection préprompt ----------------------

export interface AppliedNorme {
  id: string;
  name: string;
  category: string | null;
  promptContent: string;
  autoApplied: boolean;
}

/** Normes associées à une phase (avec le flag auto/manuel). */
export async function listPhaseNormes(
  userId: string,
  phaseId: string,
): Promise<AppliedNorme[]> {
  await assertOwnedPhase(userId, phaseId);
  const rows = await db
    .select({
      id: normes.id,
      name: normes.name,
      category: normes.category,
      promptContent: normes.promptContent,
      autoApplied: phaseNormeAssociations.autoApplied,
    })
    .from(phaseNormeAssociations)
    .innerJoin(normes, eq(normes.id, phaseNormeAssociations.normeId))
    .where(eq(phaseNormeAssociations.phaseId, phaseId));
  return rows;
}

export interface NormsContext {
  /** Bloc de préprompt à injecter (vide si aucune norme). */
  text: string;
  /** Normes appliquées (traçabilité). */
  applied: Array<{ id: string; name: string }>;
}

/**
 * Construit le contexte de normes à injecter au démarrage d'une phase.
 * Traçable : renvoie le texte ET la liste nommée des normes appliquées.
 */
export async function buildPhaseNormsContext(
  userId: string,
  phaseId: string,
): Promise<NormsContext> {
  const applied = await listPhaseNormes(userId, phaseId);
  if (applied.length === 0) return { text: "", applied: [] };

  const text = [
    "NORMES APPLIQUÉES (à respecter) :",
    ...applied.map((n, i) => `${i + 1}. [${n.name}] ${n.promptContent}`),
  ].join("\n");

  return { text, applied: applied.map((n) => ({ id: n.id, name: n.name })) };
}
