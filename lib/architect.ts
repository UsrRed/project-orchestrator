/**
 * Agent Architecte (Milestone 2).
 *
 * À partir d'une idée en langage naturel et d'un type de projet (tech /
 * marketing), génère une arborescence structurée `Project → Phase → Task` via
 * sortie structurée (schéma Zod contraint) du Vercel AI SDK. Le modèle ne
 * produit JAMAIS de code exécutable — uniquement des données conformes au
 * schéma, validées avant persistance.
 *
 * La tâche « architecture » est intrinsèquement complexe → le routeur
 * sélectionne un modèle *frontier*.
 */
import { generateObject } from "ai";
import { z } from "zod";

import { runWithFallback, type ProviderKeys } from "@/lib/llm-router";
import { computeCostUsd, type ModelSpec } from "@/lib/models";

export type ProjectType = "tech" | "marketing";

// --- Schéma de sortie contraint -----------------------------------------

export const taskModeSchema = z.enum(["autonomous", "cowork", "manual"]);

export const architectTaskSchema = z.object({
  title: z.string().min(1).describe("Titre court et actionnable de la tâche."),
  description: z
    .string()
    .describe("Description en 1-2 phrases de ce que la tâche implique."),
  mode: taskModeSchema.describe(
    "Mode d'exécution suggéré : 'manual' (l'humain fait), 'cowork' (IA + " +
      "validation humaine), 'autonomous' (IA en autonomie).",
  ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("Priorité 0 (basse) à 3 (critique)."),
});

export const architectPhaseSchema = z.object({
  name: z.string().min(1).describe("Nom de la phase."),
  type: z
    .string()
    .describe(
      "Catégorie de phase en un mot-clé (ex: 'recherche', 'design', " +
        "'developpement', 'lancement', 'marketing').",
    ),
  tasks: z
    .array(architectTaskSchema)
    .min(1)
    .max(8)
    .describe("Tâches concrètes de la phase (2 à 6 idéalement)."),
});

export const architectureSchema = z.object({
  projectName: z.string().min(1).describe("Nom concis du projet."),
  summary: z
    .string()
    .describe("Résumé en 1-2 phrases de l'objectif du projet."),
  phases: z
    .array(architectPhaseSchema)
    .min(2)
    .max(8)
    .describe("Phases ordonnées, du démarrage à la finalisation."),
});

export type Architecture = z.infer<typeof architectureSchema>;

// --- Prompts -------------------------------------------------------------

const SYSTEM_BY_TYPE: Record<ProjectType, string> = {
  tech:
    "Tu es un architecte de projets logiciels. Découpe l'idée en phases " +
    "séquentielles réalistes (ex: cadrage, conception, développement, tests, " +
    "déploiement) avec des tâches concrètes. Sois pragmatique et orienté MVP.",
  marketing:
    "Tu es un stratège marketing. Découpe l'idée en phases séquentielles " +
    "(ex: recherche marché, positionnement, création de contenu, campagne, " +
    "analyse) avec des tâches concrètes et mesurables.",
};

export interface ArchitectResult {
  architecture: Architecture;
  spec: ModelSpec;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Génère l'arborescence via un modèle frontier. Lève si aucune clé frontier
 * n'est disponible ou si la sortie ne respecte pas le schéma.
 */
export async function generateArchitecture(
  idea: string,
  projectType: ProjectType,
  keys: ProviderKeys,
  /** Préambule optionnel (langue/ton) dérivé du profil utilisateur. */
  preamble?: string,
): Promise<ArchitectResult> {
  const trimmed = idea.trim();
  if (!trimmed) throw new Error("L'idée de projet est vide.");

  const system =
    (preamble ? preamble.trim() + "\n\n" : "") + SYSTEM_BY_TYPE[projectType];

  const { value: object, usage, spec } = await runWithFallback(
    "frontier",
    keys,
    async (model, _spec, signal) => {
      const r = await generateObject({
        model,
        schema: architectureSchema,
        // json-mode (response_format) plutôt que tool-mode : compatible avec
        // les serveurs OpenAI-compatible locaux (LM Studio) comme avec le cloud.
        mode: "json",
        system,
        prompt:
          `Idée de projet (${projectType}) :\n"""${trimmed}"""\n\n` +
          "Génère une arborescence de phases et de tâches cohérente, ordonnée " +
          "et actionnable pour mener ce projet à bien.",
        abortSignal: signal,
        maxRetries: 1,
      });
      return { value: r.object, usage: r.usage };
    },
  );

  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;

  return {
    architecture: object,
    spec,
    promptTokens,
    completionTokens,
    costUsd: computeCostUsd(spec, promptTokens, completionTokens),
  };
}

/** Résumé textuel compact d'une arborescence (pour le contexte de raffinement). */
function summarizeArchitecture(arch: Architecture): string {
  return arch.phases
    .map(
      (p, i) =>
        `${i + 1}. ${p.name} (${p.type}) : ` +
        p.tasks.map((t) => t.title).join(", "),
    )
    .join("\n");
}

/**
 * Révise une arborescence existante en tenant compte d'une CONTRAINTE / d'un
 * retour utilisateur (ex: « ajoute une phase sécurité », « on n'a que 2
 * semaines »). Renvoie une nouvelle arborescence complète.
 */
export async function refineArchitecture(
  idea: string,
  projectType: ProjectType,
  current: Architecture,
  constraint: string,
  keys: ProviderKeys,
  preamble?: string,
): Promise<ArchitectResult> {
  const c = constraint.trim();
  if (!c) throw new Error("La contrainte de raffinement est vide.");

  const system =
    (preamble ? preamble.trim() + "\n\n" : "") + SYSTEM_BY_TYPE[projectType];

  const { value: object, usage, spec } = await runWithFallback(
    "frontier",
    keys,
    async (model, _spec, signal) => {
      const r = await generateObject({
        model,
        schema: architectureSchema,
        mode: "json",
        system,
        prompt:
          `Idée du projet (${projectType}) :\n"""${idea.trim()}"""\n\n` +
          `Arborescence actuelle :\n${summarizeArchitecture(current)}\n\n` +
          `CONTRAINTE / retour à intégrer :\n"""${c}"""\n\n` +
          "Produis une arborescence RÉVISÉE complète, cohérente et ordonnée, " +
          "qui tient compte de la contrainte tout en conservant ce qui reste " +
          "pertinent.",
        abortSignal: signal,
        maxRetries: 1,
      });
      return { value: r.object, usage: r.usage };
    },
  );

  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return {
    architecture: object,
    spec,
    promptTokens,
    completionTokens,
    costUsd: computeCostUsd(spec, promptTokens, completionTokens),
  };
}
