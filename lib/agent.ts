/**
 * Agent conversationnel par tâche (Milestone 3) — modes Manuel & Cowork.
 *
 * Fonctions pures (pas de DB) : elles reçoivent le contexte de tâche et
 * l'historique, appellent Claude Code CLI ([claude-cli.ts](claude-cli.ts)) sur
 * l'abonnement de la machine, et renvoient le résultat + la consommation réelle
 * ventilée par modèle. La persistance (messages, artefacts, journalisation) est
 * faite par la couche action.
 *
 * Depuis le passage en « Claude uniquement », plus de routeur ni de tiers : le
 * CLI choisit son modèle lui-même. Le chat reste réactif ; on pourrait forcer un
 * modèle rapide via `claudeText(..., { model })` si la latence gênait.
 */
import "server-only";

import { z } from "zod";

import { claudeJson, claudeText } from "@/lib/claude-cli";
import type { CliModelUsage } from "@/lib/cli-agents";
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

/**
 * Aplati l'historique en un seul prompt : `claude -p` prend un unique message,
 * là où l'ancien SDK recevait un tableau. Le dernier tour utilisateur reste en
 * bas, précédé du contexte de la conversation.
 */
function historyToPrompt(history: HistoryMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n\n");
}

// --- Résultat commun -----------------------------------------------------

/** Consommation réelle d'un appel Claude, à journaliser par la couche action. */
export interface ClaudeMeta {
  usage: CliModelUsage[];
  costUsd: number;
}

// --- Mode Manuel : réponse réactive -------------------------------------

export interface ManualResult extends ClaudeMeta {
  text: string;
}

export async function manualReply(
  ctx: TaskContext,
  history: HistoryMessage[],
  normsText?: string,
): Promise<ManualResult> {
  const call = await claudeText(historyToPrompt(history), {
    system: systemPrompt(ctx, normsText),
  });
  return { text: call.text, usage: call.usage, costUsd: call.costUsd };
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

export interface OptionsResult extends ClaudeMeta {
  data: CoworkOptionsData;
}

export async function proposeCoworkOptions(
  ctx: TaskContext,
  history: HistoryMessage[],
  normsText?: string,
): Promise<OptionsResult> {
  const call = await claudeJson(historyToPrompt(history), coworkOptionsSchema, {
    system:
      systemPrompt(ctx, normsText) +
      "\n\nMode COWORK : propose 3 options distinctes pour avancer, puis " +
      "attends le choix de l'utilisateur. Ne tranche pas à sa place.",
  });
  return { data: call.value, usage: call.usage, costUsd: call.costUsd };
}

// --- Mode Cowork : production d'artefact après choix ---------------------

const artifactSchema = z.object({
  title: z.string().describe("Titre de l'artefact produit."),
  content: z
    .string()
    .describe("Contenu de l'artefact en Markdown, prêt à l'emploi et détaillé."),
});

export interface ArtifactResult extends ClaudeMeta {
  title: string;
  content: string;
}

export async function produceCoworkArtifact(
  ctx: TaskContext,
  history: HistoryMessage[],
  chosenOption: { title: string; detail: string },
  normsText?: string,
): Promise<ArtifactResult> {
  const prompt =
    `${historyToPrompt(history)}\n\n` +
    `Option retenue : « ${chosenOption.title} » — ${chosenOption.detail}\n\n` +
    "Produis l'artefact final correspondant à ce choix.";
  const call = await claudeJson(prompt, artifactSchema, {
    system:
      systemPrompt(ctx, normsText) +
      "\n\nMode COWORK : l'utilisateur a choisi une option. Produis " +
      "l'artefact correspondant (document Markdown), concret et complet.",
  });
  return {
    title: call.value.title,
    content: call.value.content,
    usage: call.usage,
    costUsd: call.costUsd,
  };
}
