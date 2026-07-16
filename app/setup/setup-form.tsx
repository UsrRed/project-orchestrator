"use client";

import { useActionState } from "react";

import { saveGitHubOAuthAction, type SetupState } from "./actions";

const INITIAL: SetupState = { ok: false, message: "" };

export function SetupForm() {
  const [state, formAction, pending] = useActionState(
    saveGitHubOAuthAction,
    INITIAL,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Client ID</span>
        <input
          name="clientId"
          required
          autoComplete="off"
          placeholder="Ov23li… (client ID de ton OAuth App)"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Client Secret</span>
        <input
          name="clientSecret"
          type="password"
          required
          autoComplete="off"
          placeholder="••••••••••••••••"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "Enregistrement…" : "Enregistrer les identifiants"}
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
