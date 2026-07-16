"use client";

import { useActionState, useState } from "react";

import {
  addConnectionAction,
  deleteConnectionAction,
  type KeyFormState,
} from "@/app/actions";
import type { ConnectionView } from "@/lib/keys";
import {
  METHOD_LABEL,
  PROVIDERS,
  credentialHelp,
  defaultMethod,
  providerInfo,
  type ConnMethod,
} from "@/lib/providers";
import type { Provider } from "@/lib/models";

const INITIAL: KeyFormState = { ok: false, message: "" };

export function KeysManager({ connections }: { connections: ConnectionView[] }) {
  const [state, formAction, pending] = useActionState(
    addConnectionAction,
    INITIAL,
  );
  const [provider, setProvider] = useState<Provider>("ollama");
  const [method, setMethod] = useState<ConnMethod>(defaultMethod("ollama"));

  const methods = providerInfo(provider)?.methods ?? ["api_key"];
  const needsSecret = method !== "none";
  const help = credentialHelp(provider, method);

  function onProviderChange(p: Provider) {
    setProvider(p);
    setMethod(defaultMethod(p));
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Provider</span>
            <select
              name="provider"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as Provider)}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Méthode</span>
            <select
              name="method"
              value={method}
              onChange={(e) => setMethod(e.target.value as ConnMethod)}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
            >
              {methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
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

        {needsSecret ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">
              {method === "oauth" ? "Jeton OAuth (Bearer)" : "Clé API"}
            </span>
            <input
              name="key"
              type="password"
              required
              autoComplete="off"
              placeholder={method === "oauth" ? "ya29.… / jeton d'accès" : "sk-…"}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>
        ) : (
          <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-500">
            {providerInfo(provider)?.note ??
              "Aucune credential requise pour cette méthode."}
          </p>
        )}

        {help && (
          <div className="flex flex-col gap-2 rounded-lg border border-sky-900/50 bg-sky-950/10 px-3 py-2 text-xs text-sky-200/90">
            {help.url ? (
              <a
                href={help.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-sky-300 underline-offset-2 hover:underline"
              >
                {help.label} →
              </a>
            ) : (
              <span className="font-semibold text-sky-300">{help.label}</span>
            )}
            {help.command && <CopyCommand command={help.command} />}
            {help.note && <p className="text-sky-200/70">{help.note}</p>}
          </div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {pending ? "Enregistrement…" : "Ajouter la connexion"}
        </button>
      </form>

      {method === "oauth" && (
        <p className="rounded-lg border border-sky-900/50 bg-sky-950/10 px-3 py-2 text-xs text-sky-200/80">
          Le jeton est envoyé en <code>Authorization: Bearer</code>. Fiable pour
          les endpoints OpenAI-compatibles.
        </p>
      )}

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

      {connections.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm"
            >
              <span className="min-w-[92px] font-mono text-xs uppercase text-emerald-400">
                {c.provider}
              </span>
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400">
                {METHOD_LABEL[c.method]}
              </span>
              <span className="font-mono text-neutral-300">{c.masked}</span>
              {c.label && (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  {c.label}
                </span>
              )}
              <span className="ml-auto text-xs text-neutral-600">
                {c.lastUsedAt
                  ? `utilisée ${c.lastUsedAt.toLocaleDateString("fr-FR")}`
                  : "jamais utilisée"}
              </span>
              <form action={deleteConnectionAction}>
                <input type="hidden" name="id" value={c.id} />
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                  aria-label="Supprimer la connexion"
                >
                  Supprimer
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">
          Aucune connexion. Ajoute au moins un connecteur (clé, jeton OAuth, ou
          local) — le routeur préfère le local gratuit quand il est présent.
        </p>
      )}
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-950 px-2 py-1 font-mono text-neutral-300">
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
      >
        {copied ? "✓ copié" : "Copier"}
      </button>
    </div>
  );
}
