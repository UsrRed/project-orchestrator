"use client";

import { useActionState } from "react";

import { createNormeAction, type NormeFormState } from "./actions";

const INITIAL: NormeFormState = { ok: false, message: "" };

export function NewNormeForm() {
  const [state, formAction, pending] = useActionState(
    createNormeAction,
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Nom</span>
          <input
            name="name"
            required
            placeholder="Ex: Charte éditoriale"
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">
            Catégorie (= type de phase, pour l&apos;auto-association)
          </span>
          <input
            name="category"
            placeholder="Ex: marketing, design, developpement…"
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Contenu (injecté en préprompt)</span>
        <textarea
          name="promptContent"
          rows={4}
          required
          placeholder="Ex: Toujours écrire dans un ton professionnel et concis, en français, avec des exemples concrets."
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "Création…" : "Créer la norme"}
      </button>

      {state.message && (
        <p
          className={`rounded-lg border px-4 py-2 text-sm ${
            state.ok
              ? "border-emerald-800 bg-emerald-950/30 text-emerald-200"
              : "border-red-800 bg-red-950/30 text-red-200"
          }`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
