/**
 * Widgets « generative UI » (Milestone 6).
 *
 * SÉCURITÉ (risque #5 du plan) : le LLM ne produit JAMAIS de JSX ni de code
 * exécutable — uniquement des DONNÉES conformes à un schéma Zod fixe
 * (discriminé par `type`). Le rendu est assuré par des composants React
 * whitelistés (voir components/widget-renderer.tsx), sans `dangerouslySetInnerHTML`
 * ni `eval`. Toute donnée non conforme est rejetée avant rendu.
 */
import "server-only";

import { z } from "zod";

import { claudeJson } from "@/lib/claude-cli";
import type { CliModelUsage } from "@/lib/cli-agents";
import type { TaskContext } from "@/lib/conversation";

// --- Schéma fixe des widgets --------------------------------------------

const comparisonTable = z.object({
  type: z.literal("comparison_table"),
  title: z.string(),
  columns: z.array(z.string()).min(2).max(6),
  rows: z
    .array(z.object({ cells: z.array(z.string()).min(2).max(6) }))
    .min(1)
    .max(20),
});

const checklist = z.object({
  type: z.literal("checklist"),
  title: z.string(),
  items: z
    .array(z.object({ label: z.string(), checked: z.boolean() }))
    .min(1)
    .max(30),
});

const kpiGrid = z.object({
  type: z.literal("kpi_grid"),
  title: z.string(),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        hint: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

const callout = z.object({
  type: z.literal("callout"),
  level: z.enum(["info", "warn", "success"]),
  title: z.string(),
  body: z.string(),
});

export const widgetSchema = z.discriminatedUnion("type", [
  comparisonTable,
  checklist,
  kpiGrid,
  callout,
]);

export type Widget = z.infer<typeof widgetSchema>;

/**
 * Valide/normalise un widget venant d'une source non fiable (contenu d'artefact
 * stocké). Renvoie null si non conforme au schéma — jamais de rendu de données
 * arbitraires.
 */
export function parseWidget(raw: unknown): Widget | null {
  let candidate = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const result = widgetSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

// --- Génération ----------------------------------------------------------

export interface WidgetResult {
  widget: Widget;
  usage: CliModelUsage[];
  costUsd: number;
}

const WIDGET_HINT =
  "Choisis le type de widget le plus adapté : 'comparison_table' (comparer " +
  "des options sur des critères), 'checklist' (étapes/critères à cocher), " +
  "'kpi_grid' (indicateurs chiffrés), 'callout' (message clé). Renvoie " +
  "uniquement des données structurées.";

export async function generateWidget(
  instruction: string,
  ctx: TaskContext,
): Promise<WidgetResult> {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error("Décris le widget à générer.");

  const call = await claudeJson(trimmed, widgetSchema, {
    system:
      `Tu génères un widget d'aide à la décision pour la tâche « ${ctx.taskTitle} » ` +
      `(projet ${ctx.projectType}). ${WIDGET_HINT}`,
  });

  return { widget: call.value, usage: call.usage, costUsd: call.costUsd };
}
