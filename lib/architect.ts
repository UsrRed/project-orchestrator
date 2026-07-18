/**
 * Agent Architecte (Milestone 2).
 *
 * À partir d'une idée en langage naturel et d'un type de projet (tech /
 * marketing), génère une arborescence structurée `Project → Phase → Task` via
 * Claude Code CLI ([claude-cli.ts](claude-cli.ts)), validée contre un schéma Zod
 * avant persistance. Le modèle ne produit JAMAIS de code exécutable — uniquement
 * des données conformes au schéma.
 */
import "server-only";

import { z } from "zod";

import { claudeJson } from "@/lib/claude-cli";
import type { CliModelUsage } from "@/lib/cli-agents";
import { modelFor } from "@/lib/models";

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
  usage: CliModelUsage[];
  costUsd: number;
}

/**
 * Génère l'arborescence via Claude Code CLI. Lève si la sortie ne respecte pas
 * le schéma après réparation, ou si le CLI n'est pas joignable.
 */
export async function generateArchitecture(
  idea: string,
  projectType: ProjectType,
  /** Préambule optionnel (langue/ton) dérivé du profil utilisateur. */
  preamble?: string,
): Promise<ArchitectResult> {
  const trimmed = idea.trim();
  if (!trimmed) throw new Error("L'idée de projet est vide.");

  const system =
    (preamble ? preamble.trim() + "\n\n" : "") + SYSTEM_BY_TYPE[projectType];

  const call = await claudeJson(
    `Idée de projet (${projectType}) :\n"""${trimmed}"""\n\n` +
      "Génère une arborescence de phases et de tâches cohérente, ordonnée " +
      "et actionnable pour mener ce projet à bien.",
    architectureSchema,
    { system, model: modelFor("architect") },
  );

  return {
    architecture: call.value,
    usage: call.usage,
    costUsd: call.costUsd,
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
  preamble?: string,
): Promise<ArchitectResult> {
  const c = constraint.trim();
  if (!c) throw new Error("La contrainte de raffinement est vide.");

  const system =
    (preamble ? preamble.trim() + "\n\n" : "") + SYSTEM_BY_TYPE[projectType];

  const call = await claudeJson(
    `Idée du projet (${projectType}) :\n"""${idea.trim()}"""\n\n` +
      `Arborescence actuelle :\n${summarizeArchitecture(current)}\n\n` +
      `CONTRAINTE / retour à intégrer :\n"""${c}"""\n\n` +
      "Produis une arborescence RÉVISÉE complète, cohérente et ordonnée, " +
      "qui tient compte de la contrainte tout en conservant ce qui reste " +
      "pertinent.",
    architectureSchema,
    { system, model: modelFor("architect") },
  );

  return {
    architecture: call.value,
    usage: call.usage,
    costUsd: call.costUsd,
  };
}
