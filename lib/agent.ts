/**
 * Agent conversationnel par tâche (Milestone 3) — modes Manuel & Cowork.
 *
 * Fonctions pures (pas de DB) : elles reçoivent le contexte de tâche et
 * l'historique, appellent Claude Code CLI ([claude-cli.ts](claude-cli.ts)) sur
 * l'abonnement de la machine, et renvoient le résultat + la consommation réelle
 * ventilée par modèle. La persistance (messages, artefacts, journalisation) est
 * faite par la couche action.
 *
 * Depuis le passage en « Claude uniquement », plus de routeur multi-provider :
 * chaque rôle impose simplement un modèle proportionné via `modelFor()`
 * ([models.ts](models.ts)) — Sonnet ici (chat, options, artefact), Haiku pour
 * les suggestions — plutôt que de laisser le CLI prendre « auto » (max) partout.
 */
import "server-only";

import { z } from "zod";

import { claudeJson, claudeText } from "@/lib/claude-cli";
import type { CliModelUsage } from "@/lib/cli-agents";
import { modelFor } from "@/lib/models";
import type { CoworkOptionsData, TaskContext } from "@/lib/conversation";
import { panelKeyFor } from "@/lib/phase-panel";
import type { TaskMode } from "@/lib/projects";

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
    model: modelFor("chat"),
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
    model: modelFor("cowork-options"),
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
    model: modelFor("cowork-artifact"),
  });
  return {
    title: call.value.title,
    content: call.value.content,
    usage: call.usage,
    costUsd: call.costUsd,
  };
}

// --- Suggestions de prompts (à la demande, éphémères) --------------------

const promptSuggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        label: z.string().describe("Texte court de la puce (≈ 3–6 mots)."),
        prompt: z.string().describe("Le prompt complet, prêt à être envoyé."),
      }),
    )
    .min(3)
    .max(6)
    .describe("Suggestions de prompts distinctes, adaptées au mode et à l'étape."),
});

export interface PromptSuggestion {
  label: string;
  prompt: string;
}

export interface SuggestionsResult extends ClaudeMeta {
  suggestions: PromptSuggestion[];
}

/** Ce que l'utilisateur *fait* dans chaque mode, pour orienter les suggestions. */
const MODE_GUIDANCE: Record<TaskMode, string> = {
  manual:
    "Mode MANUEL (simple conversation) : propose des amorces de discussion ou " +
    "des questions utiles à poser à l'agent pour avancer sur la tâche.",
  cowork:
    "Mode COWORK : propose des besoins/sujets sur lesquels l'utilisateur " +
    "demanderait des options à l'agent (l'agent proposera puis produira un artefact).",
  autonomous:
    "Mode AUTONOME : propose des OBJECTIFS de run concrets, réalisables seul par " +
    "l'agent directement dans le dépôt du projet.",
};

/** Repère méthodologique par type d'étape (aligné sur `panelKeyFor`). */
const STAGE_SEED: Record<string, string> = {
  recherche:
    "recherche & cadrage (hypothèses, entretiens, analyse concurrentielle, personas, TAM/SAM/SOM)",
  design: "design (parcours utilisateur, wireframes, système visuel, accessibilité)",
  developpement: "développement (découpage technique, implémentation, tests, revue de code)",
  marketing: "marketing (positionnement, cibles, canaux, contenu, KPIs de campagne)",
  lancement: "lancement (checklist de mise en ligne, communication, suivi post-lancement)",
  default: "les livrables attendus de cette phase",
};

/**
 * Génère à la demande des suggestions de prompts adaptées au mode courant ET au
 * type d'étape. Éphémère : la couche action renvoie ça dans son state, sans
 * persister — ce ne sont pas des messages, juste des amorces cliquables.
 */
export async function suggestPrompts(
  ctx: TaskContext,
  mode: TaskMode,
  history: HistoryMessage[],
  normsText?: string,
): Promise<SuggestionsResult> {
  const stage = STAGE_SEED[panelKeyFor(ctx.phaseType)] ?? STAGE_SEED.default;
  const recent = history.slice(-6);
  const prompt = [
    recent.length ? `Conversation en cours :\n${historyToPrompt(recent)}\n` : "",
    `Propose 3 à 6 prompts que l'utilisateur pourrait envoyer maintenant, ` +
      `adaptés à l'étape : ${stage}.`,
    "Chaque suggestion : un `label` court pour la puce, et un `prompt` complet " +
      "prêt à envoyer.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const call = await claudeJson(prompt, promptSuggestionsSchema, {
    system:
      systemPrompt(ctx, normsText) +
      "\n\n" +
      MODE_GUIDANCE[mode] +
      " Ne réponds PAS à la tâche : génère UNIQUEMENT des suggestions de prompts.",
    model: modelFor("suggestions"),
  });
  return {
    suggestions: call.value.suggestions,
    usage: call.usage,
    costUsd: call.costUsd,
  };
}
