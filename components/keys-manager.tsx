"use client";

import { useActionState } from "react";

import { addKeyAction, deleteKeyAction, type KeyFormState } from "@/app/actions";
import type { ApiKeyView } from "@/lib/keys";

const INITIAL: KeyFormState = { ok: false, message: "" };

const PROVIDERS: Array<{ value: string; label: string }> = [
  { value: "ollama", label: "Local (LM Studio / Ollama)" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "groq", label: "Groq (Llama)" },
  { value: "openrouter", label: "OpenRouter" },
];

export function KeysManager({ keys }: { keys: ApiKeyView[] }) {
  const [state, formAction, pending] = useActionState(addKeyAction, INITIAL);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Provider</span>
            <select
              name="provider"
              defaultValue="anthropic"
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Libellé (optionnel)</span>
            <input
              name="label"
              type="text"
              placeholder="Ex: perso, prod…"
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Clé API</span>
          <input
            name="key"
            type="password"
            required
            autoComplete="off"
            placeholder="sk-…"
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {pending ? "Chiffrement…" : "Ajouter la clé"}
        </button>
      </form>

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

      {keys.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm"
            >
              <span className="min-w-[92px] font-mono text-xs uppercase text-emerald-400">
                {k.provider}
              </span>
              <span className="font-mono text-neutral-300">{k.masked}</span>
              {k.label && (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  {k.label}
                </span>
              )}
              <span className="ml-auto text-xs text-neutral-600">
                {k.lastUsedAt
                  ? `utilisée ${k.lastUsedAt.toLocaleDateString("fr-FR")}`
                  : "jamais utilisée"}
              </span>
              <form action={deleteKeyAction}>
                <input type="hidden" name="id" value={k.id} />
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                  aria-label="Supprimer la clé"
                >
                  Supprimer
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">
          Aucune clé enregistrée. Ajoutez-en au moins une pour déclencher des
          appels réels (le routeur reste démontrable en dry-run sans clé).
        </p>
      )}
    </div>
  );
}
