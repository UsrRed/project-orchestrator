"use client";

import { useActionState } from "react";

import { saveProfileAction, type ProfileFormState } from "./actions";
import type { Profile } from "@/lib/profile";

const INITIAL: ProfileFormState = { ok: false, message: "" };

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, formAction, pending] = useActionState(saveProfileAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Nom affiché</span>
        <input
          name="displayName"
          defaultValue={profile.displayName ?? ""}
          placeholder="Ton nom / pseudo"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Langue des réponses IA</span>
          <select
            name="language"
            defaultValue={profile.language}
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          >
            <option value="fr">Français</option>
            <option value="en">Anglais</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Type de projet par défaut</span>
          <select
            name="defaultProjectType"
            defaultValue={profile.defaultProjectType}
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          >
            <option value="tech">Tech / logiciel</option>
            <option value="marketing">Marketing</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Ton de l&apos;IA</span>
        <input
          name="tone"
          defaultValue={profile.tone}
          placeholder="ex: neutre et professionnel, direct, pédagogue…"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Budget par défaut / projet ($)</span>
        <input
          name="defaultBudgetUsd"
          type="number"
          min={0}
          step={0.01}
          defaultValue={profile.defaultBudgetUsd ?? ""}
          placeholder="ex: 5.00 (vide = aucun)"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "Enregistrement…" : "Enregistrer le profil"}
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
