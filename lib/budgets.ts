/**
 * Budgets par projet & alertes de dépassement (Milestone 7.3).
 *
 * La table `budgets` porte la LIMITE (`limitUsd`) ; le montant dépensé est
 * calculé en direct depuis la table de vérité `agent_executions` (somme des
 * coûts rattachés au projet), pour rester toujours exact. L'enforcement
 * (`assertWithinBudget`) est appelé avant un appel LLM rattaché au projet, et
 * le worker autonome vérifie le budget à chaque étape.
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { projectSpendUsd } from "@/lib/executions";
import { budgets, projects } from "@/drizzle/schema";

const ALERT_RATIO = 0.8;

async function assertOwnedProject(
  userId: string,
  projectId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw new Error("Projet introuvable ou non autorisé.");
}

/** Fixe (ou met à jour) la limite de budget d'un projet. limitUsd <= 0 supprime. */
export async function setBudget(
  userId: string,
  projectId: string,
  limitUsd: number,
): Promise<void> {
  await assertOwnedProject(userId, projectId);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    await db.delete(budgets).where(eq(budgets.projectId, projectId));
    return;
  }
  await db
    .insert(budgets)
    .values({ projectId, limitUsd: limitUsd.toFixed(4) })
    .onConflictDoUpdate({
      target: budgets.projectId,
      set: { limitUsd: limitUsd.toFixed(4), updatedAt: new Date() },
    });
}

/** Limite de budget d'un projet (null si aucune). */
export async function getBudgetLimit(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ limitUsd: budgets.limitUsd })
    .from(budgets)
    .where(eq(budgets.projectId, projectId))
    .limit(1);
  return row ? Number(row.limitUsd) : null;
}

export interface BudgetStatus {
  limitUsd: number | null;
  spentUsd: number;
  /** Ratio dépensé/limite (0 si pas de limite). */
  ratio: number;
  /** Alerte : ≥ 80 % et pas encore dépassé. */
  alert: boolean;
  /** Dépassé : ≥ 100 %. */
  exceeded: boolean;
}

/** État budgétaire d'un projet (limite, dépensé, ratio, alerte/dépassement). */
export async function getBudgetStatus(
  userId: string,
  projectId: string,
): Promise<BudgetStatus> {
  await assertOwnedProject(userId, projectId);
  const [limitUsd, spentUsd] = await Promise.all([
    getBudgetLimit(projectId),
    projectSpendUsd(projectId),
  ]);
  return computeStatus(limitUsd, spentUsd);
}

function computeStatus(
  limitUsd: number | null,
  spentUsd: number,
): BudgetStatus {
  if (limitUsd === null) {
    return { limitUsd: null, spentUsd, ratio: 0, alert: false, exceeded: false };
  }
  const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
  return {
    limitUsd,
    spentUsd,
    ratio,
    alert: ratio >= ALERT_RATIO && ratio < 1,
    exceeded: ratio >= 1,
  };
}

/** Vrai si le projet a une limite et l'a atteinte/dépassée (contexte worker). */
export async function projectBudgetExceeded(
  projectId: string,
): Promise<boolean> {
  const [limitUsd, spentUsd] = await Promise.all([
    getBudgetLimit(projectId),
    projectSpendUsd(projectId),
  ]);
  return limitUsd !== null && limitUsd > 0 && spentUsd >= limitUsd;
}

/** Lève si le budget projet est dépassé — à appeler avant un appel LLM. */
export async function assertWithinBudget(projectId: string): Promise<void> {
  if (await projectBudgetExceeded(projectId)) {
    const limit = await getBudgetLimit(projectId);
    throw new Error(
      `Budget du projet dépassé (limite $${(limit ?? 0).toFixed(2)}). ` +
        "Augmente la limite pour continuer.",
    );
  }
}
