/**
 * Planification d'un run autonome : ce que l'utilisateur n'a plus à saisir.
 *
 * Avant, le formulaire demandait le moteur, le nombre d'itérations et le
 * timeout — trois questions auxquelles personne ne sait répondre avant d'avoir
 * lancé le run. Ici, une IA lit l'objectif et en déduit :
 *  - le **niveau d'intelligence** requis (0-4, cf. [intelligence.ts](intelligence.ts)) ;
 *  - le nombre d'**itérations** et le **timeout** plausibles.
 *
 * Puis `resolveSource` traduit ce niveau en source concrète (local, abonnement,
 * gratuit, payant) selon l'ordre de préférence de l'utilisateur.
 *
 * **L'évaluateur ne coûte rien** : il est lui-même choisi parmi les modèles
 * gratuits/locaux assez capables et assez larges pour le contexte évalué. Faire
 * payer un appel API pour décider qu'on ne veut pas payer serait absurde — et
 * un run à plafond 0 doit rester à 0, planification comprise.
 *
 * Tout échec (aucun modèle gratuit, JSON invalide, provider dans les choux)
 * retombe sur `heuristicPlan` : un run doit partir avec des garde-fous
 * approximatifs plutôt que ne pas partir.
 */
import "server-only";

import { generateObject } from "ai";
import { z } from "zod";

import { cliAgentStatuses, type CliAgentStatus } from "@/lib/cli-availability";
import {
  LEVEL_HINT,
  type IntelligenceLevel,
} from "@/lib/intelligence";
import {
  estimateTokens,
  runWithFallback,
  selectModelChain,
  type ProviderKeys,
} from "@/lib/llm-router";
import { computeCostUsd, findFreeModel, type ModelSpec } from "@/lib/models";
import { logInfo } from "@/lib/observability";
import {
  fullSourceOrder,
  type OrderedSourceKind,
  type SourceKind,
} from "@/lib/sources";

// --- Évaluation de la tâche ---------------------------------------------

/**
 * Niveau minimal de l'évaluateur lui-même.
 *
 * Juger de la difficulté d'une tâche est une tâche de niveau « avancé » : un
 * modèle en dessous ne fait que renvoyer un chiffre au hasard, et un mauvais
 * niveau se paie deux fois (mauvaise source, mauvaises limites).
 */
const EVALUATOR_MIN_LEVEL: IntelligenceLevel = 2;

/** Marge de contexte : l'évaluateur doit tenir l'énoncé *et* sa réponse. */
const CONTEXT_MARGIN = 1.5;

const planSchema = z.object({
  level: z
    .number()
    .int()
    .min(0)
    .max(4)
    .describe(
      "Niveau d'intelligence minimum requis pour mener l'objectif à bien.",
    ),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(20)
    .describe("Nombre d'étapes nécessaires pour atteindre l'objectif."),
  timeoutMin: z
    .number()
    .int()
    .min(1)
    .max(120)
    .describe("Durée totale plausible du run, en minutes."),
  reason: z
    .string()
    .describe("Pourquoi ce niveau et ces limites, en une phrase."),
});

export interface PlanInput {
  goal: string;
  taskTitle: string;
  projectName: string;
  projectType: string;
  /** true → le run tournera sur un agent CLI, qui boucle déjà en interne. */
  cliEngine: boolean;
}

/**
 * Consommation de l'appel de planification, à journaliser par l'appelant.
 *
 * Absent si le plan vient de l'heuristique (aucun appel). Remonté plutôt que
 * journalisé ici : ce module ne connaît ni le projet ni la tâche, et les lui
 * passer juste pour écrire une ligne le rendrait dépendant de la base.
 */
export interface PlannerUsage {
  spec: ModelSpec;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  startedAt: Date;
  finishedAt: Date;
}

export interface RunPlan {
  level: IntelligenceLevel;
  maxIterations: number;
  timeoutMin: number;
  reason: string;
  /** D'où vient le plan — affiché : une estimation n'est pas une mesure. */
  planner: "ai" | "heuristic";
  /** Modèle ayant produit le plan (`planner === "ai"`). */
  plannerModel?: string;
  /** Ce que l'évaluation a consommé. Un appel non journalisé est un trou dans
   *  le suivi des tokens (HUD, /health) — même gratuit. */
  usage?: PlannerUsage;
}

const BOUNDS = {
  maxIterations: { min: 1, max: 20 },
  timeoutMin: { min: 1, max: 120 },
} as const;

function clampInt(n: number, b: { min: number; max: number }): number {
  return Math.min(Math.max(Math.round(n), b.min), b.max);
}

/**
 * Limites d'un agent CLI, quelle que soit la tâche : il boucle déjà en interne,
 * une invocation suffit — mais elle dure des minutes, pas des secondes.
 */
const CLI_LIMITS = { maxIterations: 1, timeoutMin: 30 } as const;

/**
 * Repli sans IA. Volontairement grossier : son rôle est de laisser partir le
 * run, pas de deviner juste. Le niveau 2 est le plancher raisonnable — assez
 * pour une tâche courante, sans réclamer un expert qu'on n'a peut-être pas.
 */
export function heuristicPlan(input: PlanInput): RunPlan {
  const long = estimateTokens(input.goal) > 400;
  return {
    level: long ? 3 : 2,
    maxIterations: input.cliEngine ? CLI_LIMITS.maxIterations : long ? 8 : 5,
    timeoutMin: input.cliEngine ? CLI_LIMITS.timeoutMin : 10,
    reason: long
      ? "Objectif détaillé — limites larges par défaut (estimation sans IA)."
      : "Limites par défaut (estimation sans IA).",
    planner: "heuristic",
  };
}

/**
 * Fait estimer le niveau et les limites du run par une IA gratuite. Retombe sur
 * `heuristicPlan` à la moindre difficulté.
 */
export async function planRun(
  input: PlanInput,
  keys: ProviderKeys,
): Promise<RunPlan> {
  const prompt =
    `Projet : « ${input.projectName} » (${input.projectType})\n` +
    `Tâche : « ${input.taskTitle} »\n` +
    `Objectif du run autonome :\n${input.goal}\n\n` +
    "Estime ce qu'il faut pour l'atteindre.";

  // L'évaluateur doit tenir l'énoncé qu'on lui donne : un modèle trop étroit le
  // tronquerait et noterait une tâche amputée.
  const minContext = Math.ceil(estimateTokens(prompt) * CONTEXT_MARGIN);

  const levelGuide = Object.entries(LEVEL_HINT)
    .map(([lvl, hint]) => `  ${lvl} — ${hint}`)
    .join("\n");

  const startedAt = new Date();
  try {
    const { value: object, usage, spec } = await runWithFallback(
      "fast",
      keys,
      async (model, _spec, signal) => {
        const r = await generateObject({
          model,
          schema: planSchema,
          mode: "json",
          system:
            "Tu dimensionnes un run d'agent autonome. Tu ne réalises pas la " +
            "tâche : tu estimes seulement ce qu'elle exige.\n" +
            "Échelle des niveaux d'intelligence :\n" +
            levelGuide +
            "\nSois économe : ne demande pas un niveau expert pour une tâche " +
            "qu'un modèle courant traite, ni 20 itérations pour un texte court.",
          prompt,
          abortSignal: signal,
          maxRetries: 1,
        });
        return { value: r.object, usage: r.usage };
      },
      // Gratuit uniquement : la planification d'un run à plafond 0 ne doit rien
      // coûter, et un évaluateur payant contredirait le but du routage.
      { freeOnly: true, minLevel: EVALUATOR_MIN_LEVEL, minContext, timeoutMs: 30_000 },
    );

    const plan: RunPlan = {
      level: object.level as IntelligenceLevel,
      maxIterations: input.cliEngine
        ? CLI_LIMITS.maxIterations
        : clampInt(object.maxIterations, BOUNDS.maxIterations),
      // Un agent CLI travaille en minutes : le timeout estimé pour une boucle
      // `llm` le couperait en plein travail.
      timeoutMin: Math.max(
        clampInt(object.timeoutMin, BOUNDS.timeoutMin),
        input.cliEngine ? CLI_LIMITS.timeoutMin : 1,
      ),
      reason: object.reason,
      planner: "ai",
      plannerModel: `${spec.provider}/${spec.modelId}`,
      usage: {
        spec,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        costUsd: computeCostUsd(
          spec,
          usage?.promptTokens ?? 0,
          usage?.completionTokens ?? 0,
        ),
        startedAt,
        finishedAt: new Date(),
      },
    };
    logInfo("run.planned", { ...plan, usage: undefined, goal: input.goal.slice(0, 80) });
    return plan;
  } catch (err) {
    logInfo("run.plan_fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return heuristicPlan(input);
  }
}

// --- Résolution de la source --------------------------------------------

/** Ce que le routage dynamique a retenu pour exécuter le run. */
export interface ResolvedSource {
  kind: SourceKind;
  engine: "llm" | "cli";
  /** Renseigné si `engine === "cli"`. */
  engineCli?: string;
  /** Modèle retenu si `engine === "llm"` (pour affichage/traçabilité). */
  spec?: ModelSpec;
  label: string;
}

export interface ResolveInput {
  level: IntelligenceLevel;
  keys: ProviderKeys;
  order: readonly OrderedSourceKind[];
  /** Plafond du run. 0 → aucune source payante n'est envisagée. */
  maxCostUsd: number;
  minContext?: number;
  /** Injectable pour les tests (défaut : les CLI réellement sur le PATH). */
  cliAgents?: CliAgentStatus[];
}

/** Le meilleur agent CLI disponible atteignant le niveau : le moins capable qui
 *  suffit, pour ne pas mobiliser un frontière sur une tâche courante. */
function pickCliAgent(
  level: IntelligenceLevel,
  agents: CliAgentStatus[],
): CliAgentStatus | undefined {
  return agents
    .filter((a) => a.available && a.level >= level)
    .sort((a, b) => a.level - b.level)[0];
}

/**
 * Traduit un niveau requis en source concrète, en suivant l'ordre de préférence
 * de l'utilisateur et en ne retenant que les sources **capables** de la tâche.
 *
 * `null` si rien ne convient — l'appelant le dit plutôt que de dégrader en
 * silence vers un modèle trop faible.
 */
export function resolveSource(input: ResolveInput): ResolvedSource | null {
  const {
    level,
    keys,
    order,
    maxCostUsd,
    minContext,
    cliAgents = cliAgentStatuses(),
  } = input;
  const findOpts = { minLevel: level, minContext };

  for (const kind of fullSourceOrder(order, { allowPaid: maxCostUsd > 0 })) {
    switch (kind) {
      case "local": {
        if (!keys.ollama) break;
        const spec = findFreeModel("ollama", "fast", findOpts);
        if (spec) {
          return {
            kind,
            engine: "llm",
            spec,
            label: `Local — ${spec.modelId}`,
          };
        }
        break;
      }
      case "subscription": {
        const agent = pickCliAgent(level, cliAgents);
        if (agent) {
          return {
            kind,
            engine: "cli",
            engineCli: agent.id,
            label: `Abonnement — ${agent.label}`,
          };
        }
        break;
      }
      case "free": {
        // Le local est déjà couvert par sa propre source : l'exclure ici évite
        // de le réélire sous une étiquette qui ne le décrit pas.
        const spec = selectModelChain("fast", keys, {
          ...findOpts,
          freeOnly: true,
        }).find((s) => s.provider !== "ollama");
        if (spec) {
          return {
            kind,
            engine: "llm",
            spec,
            label: `Gratuit — ${spec.provider}/${spec.modelId}`,
          };
        }
        break;
      }
      case "paid": {
        const spec = selectModelChain("fast", keys, findOpts).find(
          (s) => s.inputPerMTok > 0 || s.outputPerMTok > 0,
        );
        if (spec) {
          return {
            kind,
            engine: "llm",
            spec,
            label: `Payant — ${spec.provider}/${spec.modelId}`,
          };
        }
        break;
      }
    }
  }
  return null;
}

/** Message d'échec de résolution, à afficher tel quel. */
export function noSourceMessage(
  level: IntelligenceLevel,
  maxCostUsd: number,
): string {
  const base = `Aucune source disponible n'atteint le niveau ${level} requis pour cette tâche`;
  return maxCostUsd > 0
    ? `${base}. Ajoute une clé API sur /models, ou connecte un agent CLI.`
    : `${base} sans dépenser. Relève le plafond du run, branche un modèle local, ou connecte un agent CLI (abonnement).`;
}
