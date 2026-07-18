/**
 * Widgets « generative UI » (Milestone 6, élargi).
 *
 * SÉCURITÉ (risque #5 du plan) : le LLM ne produit JAMAIS de JSX ni de code
 * exécutable — uniquement des DONNÉES conformes à un schéma Zod fixe
 * (discriminé par `type`). Le rendu est assuré par des composants React
 * whitelistés (voir components/widget-renderer.tsx), sans `dangerouslySetInnerHTML`
 * ni `eval`. Toute donnée non conforme est rejetée avant rendu.
 *
 * Cas particulier `sandboxed_html` : le modèle peut fournir du HTML « libre »,
 * mais il n'est JAMAIS injecté dans le DOM de l'app — il est rendu dans un
 * `<iframe srcdoc sandbox="">` strictement isolé (pas de scripts, pas d'accès à
 * l'origine). Le HTML n'est donc que de la donnée inerte pour l'iframe.
 */
import "server-only";

import { z } from "zod";

import { claudeJson } from "@/lib/claude-cli";
import type { CliModelUsage } from "@/lib/cli-agents";
import type { TaskContext } from "@/lib/conversation";
import { modelFor } from "@/lib/models";

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

/** Graphe en barres : valeurs comparées, rendues en barres CSS (largeur ∝ valeur). */
const barChart = z.object({
  type: z.literal("bar_chart"),
  title: z.string(),
  bars: z
    .array(
      z.object({
        label: z.string(),
        value: z.number(),
        hint: z.string().optional(),
      }),
    )
    .min(1)
    .max(12),
});

/** Jauges de progression 0–100 (ou value/target) — avancement, complétude. */
const progress = z.object({
  type: z.literal("progress"),
  title: z.string(),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.number(),
        target: z.number().optional(),
      }),
    )
    .min(1)
    .max(8),
});

/** Frise d'étapes ordonnées, chacune avec un statut. */
const timeline = z.object({
  type: z.literal("timeline"),
  title: z.string(),
  steps: z
    .array(
      z.object({
        label: z.string(),
        status: z.enum(["done", "current", "todo"]),
        detail: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Répartition (parts d'un tout) — barre empilée / donut, couleurs whitelistées. */
const distribution = z.object({
  type: z.literal("distribution"),
  title: z.string(),
  segments: z
    .array(z.object({ label: z.string(), value: z.number() }))
    .min(2)
    .max(8),
});

/** Un grand chiffre unique, avec tendance optionnelle. */
const metric = z.object({
  type: z.literal("metric"),
  title: z.string(),
  value: z.string(),
  unit: z.string().optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  delta: z.string().optional(),
});

/**
 * Widget « libre » : HTML fourni par le modèle, rendu dans un iframe
 * STRICTEMENT sandboxé (voir components/widget-renderer.tsx). Le HTML doit être
 * statique (texte, CSS, SVG) — aucun script ne s'exécutera.
 */
const sandboxedHtml = z.object({
  type: z.literal("sandboxed_html"),
  title: z.string(),
  html: z.string().max(20_000),
});

export const widgetSchema = z.discriminatedUnion("type", [
  comparisonTable,
  checklist,
  kpiGrid,
  callout,
  barChart,
  progress,
  timeline,
  distribution,
  metric,
  sandboxedHtml,
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
  "Choisis le type de widget le plus adapté : 'comparison_table' (comparer des " +
  "options sur des critères), 'checklist' (étapes/critères à cocher), 'kpi_grid' " +
  "(plusieurs indicateurs chiffrés), 'metric' (UN seul chiffre clé avec tendance), " +
  "'bar_chart' (comparer des grandeurs numériques), 'progress' (avancement/jauges " +
  "0–100), 'timeline' (étapes ordonnées avec statut), 'distribution' (parts d'un " +
  "tout, pourcentages), 'callout' (message clé), 'sandboxed_html' (mise en forme " +
  "libre : uniquement HTML/CSS/SVG STATIQUE, aucun script — rendu isolé). Renvoie " +
  "uniquement des données structurées conformes au schéma.";

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
    model: modelFor("widget"),
  });

  return { widget: call.value, usage: call.usage, costUsd: call.costUsd };
}

// --- Visualisation de résultats -----------------------------------------

/** Longueur max du texte source injecté : borne le prompt (et le coût). */
const SOURCE_MAX_CHARS = 8_000;

const visualizeSchema = z.object({
  widgets: z.array(widgetSchema).min(1).max(3),
});

export interface VisualizeResult {
  widgets: Widget[];
  usage: CliModelUsage[];
  costUsd: number;
}

/**
 * Met en forme des résultats DÉJÀ produits (messages récents, artefacts, résumé
 * d'un run) en 1 à 3 widgets. C'est la « partie visualisation » : elle ne fait
 * pas avancer le projet, elle donne un visuel sur ce que l'IA a produit.
 */
export async function visualizeResults(
  ctx: TaskContext,
  sourceText: string,
  normsText?: string,
): Promise<VisualizeResult> {
  const trimmed = sourceText.trim().slice(0, SOURCE_MAX_CHARS);
  if (!trimmed) throw new Error("Aucun contenu à visualiser.");

  const prompt = [
    normsText ? `${normsText}\n` : "",
    `Résultats produits pour la tâche « ${ctx.taskTitle} » :`,
    "",
    trimmed,
    "",
    "Mets ces résultats en forme sous forme de 1 à 3 widgets qui donnent un " +
      "aperçu visuel clair (chiffres clés, progression, répartition, étapes…). " +
      "Ne réécris pas le contenu : synthétise-le visuellement.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const call = await claudeJson(prompt, visualizeSchema, {
    system:
      `Tu es un assistant de dataviz pour la tâche « ${ctx.taskTitle} » ` +
      `(projet ${ctx.projectType}). ${WIDGET_HINT}`,
    model: modelFor("widget"),
  });

  return { widgets: call.value.widgets, usage: call.usage, costUsd: call.costUsd };
}
