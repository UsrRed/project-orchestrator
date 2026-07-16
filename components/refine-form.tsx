"use client";

import { useActionState } from "react";

import { refineProjectAction } from "@/app/projects/actions";
import type { GenerateState } from "@/app/projects/actions";

const INITIAL: GenerateState = { ok: false, message: "" };

/** Affine l'arborescence d'un projet selon une contrainte (régénération). */
export function RefineForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    refineProjectAction,
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="constraint"
          required
          placeholder="Contrainte / changement — ex: ajoute une phase sécurité, on n'a que 2 semaines…"
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-emerald-600 hover:text-emerald-400 disabled:opacity-50"
        >
          {pending ? "L'architecte révise…" : "Affiner l'arborescence"}
        </button>
      </div>
      <p className="text-xs text-neutral-600">
        Régénère les phases et tâches en tenant compte de la contrainte
        (remplace l&apos;arborescence actuelle).
      </p>
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
