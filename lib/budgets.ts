/**
 * Budgets par projet & alertes de dépassement (Milestone 7.3), **en tokens**.
 *
 * L'app tourne sur l'abonnement Claude, gratuit au token : le dollar n'a plus
 * de sens comme unité de budget. On compte donc en **tokens** (entrée + sortie).
 * La table `budgets` porte la LIMITE (`limitTokens`) ; le montant consommé est
 * calculé en direct depuis la table de vérité `agent_executions`
 * (`projectSpendTokens`), pour rester toujours exact et — point clé — non biaisé
 * par l'usage de l'abonnement fait hors de l'app. L'enforcement
 * (`assertWithinBudget`) est appelé avant un appel LLM rattaché au projet, et le
 * worker autonome vérifie le budget à chaque étape.
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { projectSpendTokens } from "@/lib/executions";
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

/** Fixe (ou met à jour) le plafond de tokens d'un projet. `limit <= 0` supprime. */
export async function setBudget(
  userId: string,
  projectId: string,
  limitTokens: number,
): Promise<void> {
  await assertOwnedProject(userId, projectId);
  const limit = Math.round(limitTokens);
  if (!Number.isFinite(limit) || limit <= 0) {
    await db.delete(budgets).where(eq(budgets.projectId, projectId));
    return;
  }
  await db
    .insert(budgets)
    .values({ projectId, limitTokens: limit })
    .onConflictDoUpdate({
      target: budgets.projectId,
      set: { limitTokens: limit, updatedAt: new Date() },
    });
}

/** Plafond de tokens d'un projet (null si aucun). */
export async function getBudgetLimit(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ limitTokens: budgets.limitTokens })
    .from(budgets)
    .where(eq(budgets.projectId, projectId))
    .limit(1);
  return row ? Number(row.limitTokens) : null;
}

export interface BudgetStatus {
  limitTokens: number | null;
  spentTokens: number;
  /** Ratio consommé/limite (0 si pas de limite). */
  ratio: number;
  /** Alerte : ≥ 80 % et pas encore dépassé. */
  alert: boolean;
  /** Dépassé : ≥ 100 %. */
  exceeded: boolean;
}

/** État budgétaire d'un projet (limite, consommé, ratio, alerte/dépassement). */
export async function getBudgetStatus(
  userId: string,
  projectId: string,
): Promise<BudgetStatus> {
  await assertOwnedProject(userId, projectId);
  const [limitTokens, spentTokens] = await Promise.all([
    getBudgetLimit(projectId),
    projectSpendTokens(projectId),
  ]);
  return computeStatus(limitTokens, spentTokens);
}

function computeStatus(
  limitTokens: number | null,
  spentTokens: number,
): BudgetStatus {
  if (limitTokens === null) {
    return {
      limitTokens: null,
      spentTokens,
      ratio: 0,
      alert: false,
      exceeded: false,
    };
  }
  const ratio = limitTokens > 0 ? spentTokens / limitTokens : 0;
  return {
    limitTokens,
    spentTokens,
    ratio,
    alert: ratio >= ALERT_RATIO && ratio < 1,
    exceeded: ratio >= 1,
  };
}

/** Vrai si le projet a un plafond et l'a atteint/dépassé (contexte worker). */
export async function projectBudgetExceeded(
  projectId: string,
): Promise<boolean> {
  const [limitTokens, spentTokens] = await Promise.all([
    getBudgetLimit(projectId),
    projectSpendTokens(projectId),
  ]);
  return limitTokens !== null && limitTokens > 0 && spentTokens >= limitTokens;
}

/** Lève si le budget projet est dépassé — à appeler avant un appel LLM. */
export async function assertWithinBudget(projectId: string): Promise<void> {
  if (await projectBudgetExceeded(projectId)) {
    const limit = await getBudgetLimit(projectId);
    throw new Error(
      `Budget du projet dépassé (plafond ${(limit ?? 0).toLocaleString("fr-FR")} tokens). ` +
        "Augmente le plafond pour continuer.",
    );
  }
}
