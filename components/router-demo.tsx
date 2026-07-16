"use client";

import { useActionState } from "react";

import { routeAction, type RouteFormState } from "@/app/actions";

const INITIAL: RouteFormState = { ok: false, message: "", executed: false };

const KINDS: Array<{ value: string; label: string }> = [
  { value: "generic", label: "Générique" },
  { value: "translate", label: "Traduction" },
  { value: "format", label: "Formatage" },
  { value: "validate", label: "Validation" },
  { value: "summarize", label: "Résumé" },
  { value: "research", label: "Recherche / R&D" },
  { value: "architecture", label: "Architecture" },
  { value: "code", label: "Code" },
];

export function RouterDemo() {
  const [state, formAction, pending] = useActionState(routeAction, INITIAL);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Prompt</span>
          <textarea
            name="prompt"
            rows={3}
            required
            placeholder="Ex: Traduis « bonjour » en anglais."
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Type de tâche</span>
          <select
            name="kind"
            defaultValue="generic"
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="boost"
            className="mt-1 accent-emerald-500"
          />
          <span>
            <span className="text-neutral-300">Boost</span>
            <span className="block text-xs text-neutral-500">
              Prendre le modèle le plus capable au lieu du moins cher qui
              atteint le niveau requis. Plus cher, à réserver aux tâches où la
              qualité prime.
            </span>
          </span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {pending ? "Routage…" : "Router"}
        </button>
      </form>

      {state.message && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            state.ok
              ? "border-emerald-800 bg-emerald-950/30 text-emerald-200"
              : "border-red-800 bg-red-950/30 text-red-200"
          }`}
        >
          <p>{state.message}</p>

          {state.model && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs text-neutral-300">
              <dt className="text-neutral-500">provider</dt>
              <dd>{state.provider}</dd>
              <dt className="text-neutral-500">modèle</dt>
              <dd>{state.model}</dd>
              <dt className="text-neutral-500">tier</dt>
              <dd>
                {state.tier}
                {state.boost && (
                  <span className="ml-2 rounded bg-fuchsia-950/60 px-1.5 py-0.5 text-[10px] text-fuchsia-300">
                    boost
                  </span>
                )}
              </dd>
              {state.level !== undefined && (
                <>
                  <dt className="text-neutral-500">intelligence</dt>
                  <dd>
                    niveau {state.level}
                    {state.minLevel !== undefined && (
                      <span className="text-neutral-500">
                        {" "}
                        (requis : ≥ {state.minLevel})
                      </span>
                    )}
                  </dd>
                </>
              )}
              {state.reason && (
                <>
                  <dt className="text-neutral-500">raison</dt>
                  <dd>{state.reason}</dd>
                </>
              )}
              {state.executed && (
                <>
                  <dt className="text-neutral-500">tokens</dt>
                  <dd>
                    {state.promptTokens} in / {state.completionTokens} out
                  </dd>
                  <dt className="text-neutral-500">coût</dt>
                  <dd>${state.costUsd?.toFixed(6)}</dd>
                </>
              )}
            </dl>
          )}

          {state.text && (
            <pre className="mt-3 whitespace-pre-wrap rounded-md bg-neutral-950 p-3 text-xs text-neutral-200">
              {state.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
