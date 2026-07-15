/**
 * Agent conversationnel par tâche (Milestone 3) — modes Manuel & Cowork.
 *
 * Fonctions LLM pures (pas de DB) : elles reçoivent le contexte de tâche,
 * l'historique et les clés, appellent le modèle via le routeur (tier adapté au
 * coût), et renvoient le résultat + le coût réel. La persistance (messages,
 * artefacts, journalisation) est faite par la couche action.
 *
 * Répartition des tiers (démonstration du routeur d'intelligence) :
 *  - Manuel  → 'fast'     (conversation réactive, économique) ;
 *  - Cowork  → 'frontier' (proposition d'options & production d'artefact,
 *    tâches à plus forte valeur de raisonnement).
 */
import { generateObject, generateText, type CoreMessage } from "ai";
import { z } from "zod";

import {
  buildModel,
  selectModel,
  type ProviderKeys,
} from "@/lib/llm-router";
import { computeCostUsd, type ModelSpec, type Tier } from "@/lib/models";
import type { CoworkOptionsData, TaskContext } from "@/lib/conversation";

// --- Contexte système ----------------------------------------------------

function systemPrompt(ctx: TaskContext, normsText?: string): string {
  const lines = [
    `Tu assistes sur une tâche d'un projet ${ctx.projectType}.`,
    `Projet : « ${ctx.projectName} »${ctx.projectIdea ? ` — ${ctx.projectIdea}` : ""}.`,
    `Phase : « ${ctx.phaseName} »${ctx.phaseType ? ` (${ctx.phaseType})` : ""}.`,
    `Tâche : « ${ctx.taskTitle} »${ctx.taskDescription ? ` — ${ctx.taskDescription}` : ""}.`,
    "Sois concret, concis et actionnable. Réponds en français.",
  ];
  // Injection des Normes/Skills de la phase (M5), en tête pour priorité.
  if (normsText && normsText.trim()) lines.unshift(normsText.trim(), "");
  return lines.join("\n");
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function toCoreMessages(history: HistoryMessage[]): CoreMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

// --- Résultat commun -----------------------------------------------------

interface LlmMeta {
  spec: ModelSpec;
  tier: Tier;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

function metaFrom(
  spec: ModelSpec,
  tier: Tier,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): LlmMeta {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return {
    spec,
    tier,
    promptTokens,
    completionTokens,
    costUsd: computeCostUsd(spec, promptTokens, completionTokens),
  };
}

function modelFor(tier: Tier, keys: ProviderKeys): { spec: ModelSpec; model: ReturnType<typeof buildModel> } {
  const spec = selectModel(tier, keys);
  const apiKey = keys[spec.provider];
  if (!apiKey) throw new Error(`Clé manquante pour ${spec.provider}.`);
  return { spec, model: buildModel(spec, apiKey) };
}

// --- Mode Manuel : réponse réactive -------------------------------------

export interface ManualResult extends LlmMeta {
  text: string;
}

export async function manualReply(
  ctx: TaskContext,
  history: HistoryMessage[],
  keys: ProviderKeys,
  normsText?: string,
): Promise<ManualResult> {
  const { spec, model } = modelFor("fast", keys);
  const { text, usage } = await generateText({
    model,
    system: systemPrompt(ctx, normsText),
    messages: toCoreMessages(history),
  });
  return { text, ...metaFrom(spec, "fast", usage) };
}

// --- Mode Cowork : proposition d'options (point d'arrêt) -----------------

const coworkOptionsSchema = z.object({
  intro: z
    .string()
    .describe("Courte introduction expliquant la décision à prendre."),
  options: z
    .array(
      z.object({
        title: z.string().describe("Titre court de l'option."),
        detail: z
          .string()
          .describe("2-3 phrases : approche, avantages, compromis."),
      }),
    )
    .min(2)
    .max(4)
    .describe("Options distinctes proposées à l'utilisateur."),
});

export interface OptionsResult extends LlmMeta {
  data: CoworkOptionsData;
}

export async function proposeCoworkOptions(
  ctx: TaskContext,
  history: HistoryMessage[],
  keys: ProviderKeys,
  normsText?: string,
): Promise<OptionsResult> {
  const { spec, model } = modelFor("frontier", keys);
  const { object, usage } = await generateObject({
    model,
    schema: coworkOptionsSchema,
    mode: "json",
    system:
      systemPrompt(ctx, normsText) +
      "\n\nMode COWORK : propose 3 options distinctes pour avancer, puis " +
      "attends le choix de l'utilisateur. Ne tranche pas à sa place.",
    messages: toCoreMessages(history),
  });
  return { data: object, ...metaFrom(spec, "frontier", usage) };
}

// --- Mode Cowork : production d'artefact après choix ---------------------

const artifactSchema = z.object({
  title: z.string().describe("Titre de l'artefact produit."),
  content: z
    .string()
    .describe(
      "Contenu de l'artefact en Markdown, prêt à l'emploi et détaillé.",
    ),
});

export interface ArtifactResult extends LlmMeta {
  title: string;
  content: string;
}

export async function produceCoworkArtifact(
  ctx: TaskContext,
  history: HistoryMessage[],
  chosenOption: { title: string; detail: string },
  keys: ProviderKeys,
  normsText?: string,
): Promise<ArtifactResult> {
  const { spec, model } = modelFor("frontier", keys);
  const { object, usage } = await generateObject({
    model,
    schema: artifactSchema,
    mode: "json",
    system:
      systemPrompt(ctx, normsText) +
      "\n\nMode COWORK : l'utilisateur a choisi une option. Produis " +
      "l'artefact correspondant (document Markdown), concret et complet.",
    prompt:
      `Option retenue : « ${chosenOption.title} » — ${chosenOption.detail}\n\n` +
      "Produis l'artefact final correspondant à ce choix.",
  });
  return { title: object.title, content: object.content, ...metaFrom(spec, "frontier", usage) };
}
