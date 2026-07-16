/**
 * Câblage de production du mode Autonome (Milestone 4).
 *
 * Fournit un `WorkerDeps` réel : la fonction d'étape appelle le LLM (tier
 * `fast` — les runs autonomes multiplient les itérations, on privilégie le
 * coût, le plafond servant de garde-fou dur), et les callbacks persistent les
 * notes dans le fil de la tâche, les artefacts en base, et le coût dans
 * `agent_executions`.
 */
import "server-only";

import { generateObject } from "ai";
import { z } from "zod";

import { runWithFallback, type ProviderKeys } from "@/lib/llm-router";
import type { IntelligenceLevel } from "@/lib/intelligence";
import { computeCostUsd, type Provider } from "@/lib/models";
import {
  addArtifact,
  addMessage,
  getTaskContext,
  listMessages,
  runNotes,
} from "@/lib/conversation";
import { recordExecution } from "@/lib/executions";
import { projectBudgetExceeded } from "@/lib/budgets";
import { buildPhaseNormsContext } from "@/lib/normes";
import type { StepFn, WorkerDeps } from "@/lib/worker";

/**
 * Une étape = **le livrable entier**, réécrit.
 *
 * L'ancien schéma n'offrait que `note` (1-2 phrases) et un `artifact` réservé à
 * `done=true` : le modèle n'avait aucun support pour travailler d'une étape à
 * l'autre, et se contentait donc d'annoncer ce qu'il allait faire (« Lancement
 * de l'itération 3… ») jusqu'à épuisement des itérations — tout étant jeté à la
 * fin. `draft` est ce support : on le lui rend à chaque tour, il le remplace.
 *
 * Le document complet plutôt qu'un diff : coûteux en tokens, mais un petit
 * modèle local produit un patch faux bien plus souvent qu'un texte réécrit.
 */
const stepSchema = z.object({
  draft: z
    .object({
      title: z.string().describe("Titre du livrable."),
      content: z
        .string()
        .describe(
          "Le livrable COMPLET en Markdown, dans son état actuel — pas un " +
            "résumé, pas une description de ce que tu comptes faire, pas un " +
            "diff : le document entier, prêt à être lu tel quel.",
        ),
    })
    .describe("Le livrable après cette étape. Reprends et améliore le précédent."),
  note: z
    .string()
    .describe(
      "Ce que tu viens de changer dans le livrable, en 1-2 phrases, au passé. " +
        "C'est un journal pour l'utilisateur, pas une annonce d'intention.",
    ),
  done: z
    .boolean()
    .describe(
      "true si le livrable ci-dessus répond entièrement à l'objectif et " +
        "n'a plus besoin d'être retouché.",
    ),
});

export interface AutonomousOptions {
  /**
   * Mode « boost » du run : router vers le modèle le plus capable plutôt que le
   * moins cher atteignant le niveau requis (cf. [llm-router.ts](llm-router.ts)).
   */
  boost?: boolean;
  /**
   * Niveau requis, estimé à la planification. Remplace l'ancien tier `fast`
   * codé en dur, qui appliquait le même plancher (2) à une reformulation comme
   * à une architecture.
   */
  minLevel?: IntelligenceLevel;
  /** Plafond du run à 0 → aucun modèle facturé ne doit être élu. */
  freeOnly?: boolean;
  /** Ne router que vers ces providers (source `local` résolue en amont). */
  restrictTo?: readonly Provider[];
}

/**
 * Construit un `WorkerDeps` réel pour un utilisateur et un jeu de clés donnés.
 * `keys` doit contenir au moins un provider (vérifié par l'appelant).
 */
export function makeAutonomousDeps(
  userId: string,
  keys: ProviderKeys,
  opts: AutonomousOptions = {},
): WorkerDeps {
  const stepFn: StepFn = async (ctx, run) => {
    const taskCtx = await getTaskContext(userId, ctx.taskId);
    if (!taskCtx) throw new Error("Tâche introuvable pour le run.");

    const priorNotes = runNotes(await listMessages(userId, ctx.taskId), ctx.runId)
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join("\n");

    const norms = await buildPhaseNormsContext(userId, taskCtx.phaseId);

    const startedAt = new Date();
    const { value: object, usage, spec } = await runWithFallback(
      "fast",
      keys,
      async (model, _spec, signal) => {
        const r = await generateObject({
          model,
          schema: stepSchema,
          mode: "json",
          system:
            (norms.text ? norms.text + "\n\n" : "") +
            `Tu es un agent autonome travaillant sur la tâche « ${taskCtx.taskTitle} » ` +
            `du projet « ${taskCtx.projectName} » (${taskCtx.projectType}).\n` +
            "Tu produis un livrable et tu l'améliores à chaque étape. Tu ne " +
            "disposes d'AUCUN outil : ni fichiers, ni logiciel de maquettage, ni " +
            "navigateur. Ton seul moyen d'agir est d'écrire le livrable dans " +
            "`draft.content` — décrire ce que tu ferais ne produit rien.\n" +
            "À chaque étape : renvoie le livrable ENTIER, amélioré. Jamais un " +
            "plan de ce que tu vas faire, jamais un résumé de tes intentions.\n" +
            "Mets done=true dès que le livrable répond à l'objectif — inutile " +
            "d'épuiser les itérations disponibles.",
          prompt:
            `Objectif du run : ${ctx.goal}\n` +
            `Itération ${ctx.iteration + 1} sur ${run.maxIterations ?? "?"}.\n` +
            (priorNotes ? `\nTes étapes précédentes :\n${priorNotes}\n` : "") +
            (run.draft
              ? `\nLivrable actuel — « ${run.draft.title} » :\n` +
                "```markdown\n" +
                run.draft.content +
                "\n```\n" +
                "\nAméliore-le et renvoie-le en entier (complète ce qui manque, " +
                "corrige ce qui cloche). Si plus rien d'utile ne peut y être " +
                "ajouté, renvoie-le tel quel avec done=true."
              : "\nAucun livrable n'existe encore : écris-en une première " +
                "version complète maintenant, même imparfaite."),
          abortSignal: signal,
          maxRetries: 1,
        });
        return { value: r.object, usage: r.usage };
      },
      {
        boost: opts.boost,
        minLevel: opts.minLevel,
        freeOnly: opts.freeOnly,
        restrictTo: opts.restrictTo,
      },
    );

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const costUsd = computeCostUsd(spec, promptTokens, completionTokens);

    await recordExecution({
      userId,
      taskLabel: `[auto] ${taskCtx.taskTitle} — étape ${ctx.iteration + 1}`,
      projectId: taskCtx.projectId,
      taskId: ctx.taskId,
      provider: spec.provider,
      model: spec.modelId,
      tier: "fast",
      status: "succeeded",
      promptTokens,
      completionTokens,
      costUsd,
      startedAt,
      finishedAt: new Date(),
    });

    return {
      done: object.done,
      note: object.note,
      costUsd,
      draft: object.draft,
      // L'artefact EST le livrable, une fois que l'agent le déclare fini : il
      // n'y a rien à produire en plus, et un second champ n'aurait servi qu'à
      // permettre la divergence entre les deux.
      artifact: object.done ? object.draft : undefined,
    };
  };

  return {
    stepFn,
    budgetExceeded: async (run) => {
      const taskCtx = await getTaskContext(userId, run.taskId);
      return taskCtx ? projectBudgetExceeded(taskCtx.projectId) : false;
    },
    onNote: async (run, note) => {
      await addMessage(run.taskId, {
        role: "assistant",
        content: note,
        kind: "auto_step",
        // Rattache la note à SON run : c'est ce qui permet à `runNotes` de ne
        // pas resservir les étapes d'un run précédent au suivant.
        data: { runId: run.id },
      });
    },
    onArtifact: async (run, artifact, opts) => {
      const id = await addArtifact(run.taskId, {
        type: "document",
        title: opts?.salvaged ? `${artifact.title} (inachevé)` : artifact.title,
        content: artifact.content,
      });
      await addMessage(run.taskId, {
        role: "assistant",
        content: opts?.salvaged
          ? `Run interrompu avant la fin — le livrable est conservé en l'état : « ${artifact.title} ».`
          : `Artefact autonome produit : « ${artifact.title} »`,
        kind: "artifact",
        data: { artifactId: id },
      });
    },
  };
}
