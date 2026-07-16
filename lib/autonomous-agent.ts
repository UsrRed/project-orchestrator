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
import { addArtifact, addMessage, getTaskContext, listMessages } from "@/lib/conversation";
import { recordExecution } from "@/lib/executions";
import { projectBudgetExceeded } from "@/lib/budgets";
import { buildPhaseNormsContext } from "@/lib/normes";
import type { StepFn, WorkerDeps } from "@/lib/worker";

const stepSchema = z.object({
  note: z
    .string()
    .describe("Ce que tu as fait ou décidé à cette étape, en 1-2 phrases."),
  done: z
    .boolean()
    .describe("true si l'objectif du run est atteint, sinon false."),
  artifact: z
    .object({
      title: z.string(),
      content: z.string().describe("Contenu Markdown de l'artefact final."),
    })
    .nullable()
    .describe("Artefact final quand done=true, sinon null."),
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
  const stepFn: StepFn = async (ctx) => {
    const taskCtx = await getTaskContext(userId, ctx.taskId);
    if (!taskCtx) throw new Error("Tâche introuvable pour le run.");

    const priorNotes = (await listMessages(userId, ctx.taskId))
      .filter((m) => m.kind === "auto_step")
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
            `du projet « ${taskCtx.projectName} » (${taskCtx.projectType}). ` +
            "Avance par petites étapes concrètes vers l'objectif. Quand il est " +
            "atteint, mets done=true et fournis l'artefact final.",
          prompt:
            `Objectif du run : ${ctx.goal}\n` +
            `Itération : ${ctx.iteration + 1}\n` +
            (priorNotes ? `Progression jusqu'ici :\n${priorNotes}\n` : "") +
            "\nRéalise la prochaine étape.",
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
      artifact: object.artifact ?? undefined,
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
      });
    },
    onArtifact: async (run, artifact) => {
      const id = await addArtifact(run.taskId, {
        type: "document",
        title: artifact.title,
        content: artifact.content,
      });
      await addMessage(run.taskId, {
        role: "assistant",
        content: `Artefact autonome produit : « ${artifact.title} »`,
        kind: "artifact",
        data: { artifactId: id },
      });
    },
  };
}
