"use client";

import { useActionState } from "react";

import { generateProjectAction, type GenerateState } from "./actions";

const INITIAL: GenerateState = { ok: false, message: "" };

export function NewProjectForm({
  defaultType = "tech",
}: {
  defaultType?: "tech" | "marketing";
}) {
  const [state, formAction, pending] = useActionState(
    generateProjectAction,
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Ton idée de projet</span>
        <textarea
          name="idea"
          rows={3}
          required
          placeholder="Ex: une app mobile de suivi d'habitudes avec rappels intelligents…"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Type de projet</span>
        <select
          name="type"
          defaultValue={defaultType}
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        >
          <option value="tech">Tech / logiciel</option>
          <option value="marketing">Marketing</option>
        </select>
      </label>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "L'architecte réfléchit…" : "Générer l'arborescence"}
      </button>

      {state.message && !state.ok && (
        <p className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-sm text-red-200">
          {state.message}
        </p>
      )}
    </form>
  );
}
