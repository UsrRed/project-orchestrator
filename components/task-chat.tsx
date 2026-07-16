"use client";

import { useActionState } from "react";

import {
  chooseOptionAction,
  sendMessageAction,
  type ChatState,
} from "@/app/tasks/[taskId]/actions";
import type { CoworkOptionsData } from "@/lib/conversation";

const INITIAL: ChatState = { ok: false, message: "" };

/**
 * Les actions renvoient déjà leurs erreurs métier dans le `ChatState`. Restent
 * les pannes de transport (serveur qui recompile, réseau coupé, réponse
 * inattendue) : `useActionState` les relance pendant le rendu, ce qui fait
 * tomber toute la page sur l'overlay. On les rattrape ici pour n'afficher
 * qu'un message dans le composeur — la conversation reste lisible.
 */
function resilient(
  action: (prev: ChatState, formData: FormData) => Promise<ChatState>,
): (prev: ChatState, formData: FormData) => Promise<ChatState> {
  return async (prev, formData) => {
    try {
      return await action(prev, formData);
    } catch (err) {
      console.error("Échec de l'appel au serveur :", err);
      return {
        ok: false,
        message: "Le serveur n'a pas répondu correctement. Réessaie.",
      };
    }
  };
}

const SEND = resilient(sendMessageAction);
const CHOOSE = resilient(chooseOptionAction);

export function TaskChat({
  taskId,
  mode,
  awaitingChoice,
  pendingOptions,
}: {
  taskId: string;
  mode: "manual" | "cowork" | "autonomous";
  awaitingChoice: boolean;
  pendingOptions: CoworkOptionsData | null;
}) {
  const [sendState, sendAction, sending] = useActionState(SEND, INITIAL);
  const [chooseState, chooseAction, choosing] = useActionState(CHOOSE, INITIAL);

  // Point d'arrêt Cowork : l'agent attend un choix.
  if (awaitingChoice && pendingOptions) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-amber-300">
          L&apos;agent attend ton choix pour produire un artefact :
        </p>
        <form action={chooseAction} className="flex flex-col gap-2">
          <input type="hidden" name="taskId" value={taskId} />
          {pendingOptions.options.map((o, i) => (
            <button
              key={i}
              type="submit"
              name="optionIndex"
              value={i}
              disabled={choosing}
              className="flex flex-col items-start gap-1 rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 py-3 text-left transition hover:border-emerald-600 hover:bg-neutral-900 disabled:opacity-50"
            >
              <span className="font-semibold text-neutral-100">
                {i + 1}. {o.title}
              </span>
              <span className="text-sm text-neutral-400">{o.detail}</span>
            </button>
          ))}
        </form>
        {choosing && (
          <p className="text-sm text-neutral-500">Production de l&apos;artefact…</p>
        )}
        {chooseState.message && !chooseState.ok && (
          <p className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-sm text-red-200">
            {chooseState.message}
          </p>
        )}
      </div>
    );
  }

  const placeholder =
    mode === "cowork"
      ? "Décris ce sur quoi tu veux de l'aide — l'agent proposera des options…"
      : "Écris ton message à l'agent…";

  return (
    <form action={sendAction} className="flex flex-col gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <textarea
        name="message"
        rows={3}
        required
        placeholder={placeholder}
        className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={sending}
          className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {sending
            ? mode === "cowork"
              ? "L'agent réfléchit…"
              : "Envoi…"
            : mode === "cowork"
              ? "Demander des options"
              : "Envoyer"}
        </button>
        {sendState.message && !sendState.ok && (
          <p className="text-sm text-red-300">{sendState.message}</p>
        )}
      </div>
    </form>
  );
}
