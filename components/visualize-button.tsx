"use client";

import { useActionState } from "react";

import {
  visualizeResultsAction,
  type VisualizeState,
} from "@/app/tasks/[taskId]/actions";

const INITIAL: VisualizeState = { ok: false, message: "" };

async function safeVisualize(
  prev: VisualizeState,
  formData: FormData,
): Promise<VisualizeState> {
  try {
    return await visualizeResultsAction(prev, formData);
  } catch (err) {
    console.error("Échec de la visualisation :", err);
    return { ok: false, message: "Serveur indisponible. Réessaie." };
  }
}

/**
 * Bouton « Visualiser les résultats » (Manuel/Cowork) : demande à l'IA de mettre
 * en forme les résultats déjà produits en widgets, ajoutés au tableau de bord.
 */
export function VisualizeButton({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState(safeVisualize, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg border border-sky-800 bg-sky-950/30 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:border-sky-500 hover:bg-sky-950/50 disabled:opacity-50"
      >
        {pending ? "Mise en forme…" : "📊 Visualiser les résultats"}
      </button>
      {state.message && (
        <p
          className={`text-xs ${state.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
