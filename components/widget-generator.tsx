"use client";

import { useActionState } from "react";

import {
  generateWidgetAction,
  type WidgetFormState,
} from "@/app/tasks/[taskId]/actions";

const INITIAL: WidgetFormState = { ok: false, message: "" };

export function WidgetGenerator({ taskId }: { taskId: string }) {
  const [state, formAction, pending] = useActionState(
    generateWidgetAction,
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <div className="flex items-center gap-2">
        <input
          name="instruction"
          required
          placeholder="Ex: compare 3 approches d'authentification sur coût, sécurité, effort"
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {pending ? "Génération…" : "Générer un widget"}
        </button>
      </div>
      {state.message && (
        <p
          className={`text-sm ${state.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
