"use client";

import { useActionState } from "react";

import {
  suggestPromptsAction,
  type SuggestState,
} from "@/app/tasks/[taskId]/actions";

const INITIAL: SuggestState = { ok: false, message: "", suggestions: [] };

/**
 * Rattrape les pannes de transport (comme `resilient` dans task-chat) pour ne
 * pas faire tomber la page sur l'overlay d'erreur : une suggestion ratée n'est
 * pas critique.
 */
async function safeSuggest(
  prev: SuggestState,
  formData: FormData,
): Promise<SuggestState> {
  try {
    return await suggestPromptsAction(prev, formData);
  } catch (err) {
    console.error("Échec des suggestions :", err);
    return { ok: false, message: "Serveur indisponible. Réessaie.", suggestions: [] };
  }
}

/**
 * Bouton « Suggérer des prompts » + puces cliquables. Éphémère : les
 * suggestions vivent dans le state de l'action, jamais persistées. Un clic sur
 * une puce remplit le composeur du parent via `onPick`.
 */
export function PromptSuggestions({
  taskId,
  onPick,
}: {
  taskId: string;
  onPick: (prompt: string) => void;
}) {
  const [state, action, pending] = useActionState(safeSuggest, INITIAL);

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <input type="hidden" name="taskId" value={taskId} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-200 disabled:opacity-50"
        >
          {pending ? "Réflexion…" : "💡 Suggérer des prompts"}
        </button>
      </form>

      {state.message && !state.ok && (
        <p className="text-xs text-red-300">{state.message}</p>
      )}

      {state.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {state.suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              title={s.prompt}
              onClick={() => onPick(s.prompt)}
              className="rounded-full border border-emerald-900/60 bg-emerald-950/20 px-3 py-1 text-xs text-emerald-200 transition hover:border-emerald-500 hover:bg-emerald-950/40"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
