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
  providerInfo,
} from "@/lib/providers";
import type { Provider } from "@/lib/models";

const INITIAL: KeyFormState = { ok: false, message: "" };

export function KeysManager({
  connections,
  modelCounts,
}: {
  connections: ConnectionView[];
  modelCounts: Record<string, number>;
}) {
  const [state, formAction, pending] = useActionState(
    addConnectionAction,
    INITIAL,
  );
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [oauth, setOauth] = useState(false);

  const info = providerInfo(provider);
  const isLocal = info?.methods.length === 1 && info.methods[0] === "none";
  const supportsOauth = info?.methods.includes("oauth") ?? false;
  const method = isLocal ? "none" : oauth ? "oauth" : "api_key";
  const help = credentialHelp(provider, method);
  const count = modelCounts[provider] ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="method" value={method} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-neutral-400">Provider</span>
            <select
              name="provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as Provider);
                setOauth(false);
              }}
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {modelCounts[p.id] ? ` — ${modelCounts[p.id]} modèles` : ""}
                </option>
              ))}
            </select>
          </label>

          {!isLocal && (
            <label className="flex flex-[2] flex-col gap-1 text-sm">
              <span className="text-neutral-400">
                {oauth ? "Jeton OAuth (Bearer)" : "Clé API"}
              </span>
              <input
                name="key"
                type="password"
                required
                autoComplete="off"
                placeholder={oauth ? "jeton d'accès…" : "colle ta clé ici…"}
                className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
              />
            </label>
          )}

          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            {pending
              ? "…"
              : isLocal
                ? "Activer le local"
                : "Connecter"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {count > 0 && (
            <span className="text-neutral-500">
              {count} modèle{count > 1 ? "s" : ""} disponible
              {count > 1 ? "s" : ""} pour ce provider
            </span>
          )}
          {help?.url && (
            <a
              href={help.url}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline"
            >
              {help.label} →
            </a>
          )}
          {supportsOauth && !isLocal && (
            <button
              type="button"
              onClick={() => setOauth((v) => !v)}
              className="text-sky-400 hover:underline"
            >
              {oauth ? "← utiliser une clé API" : "utiliser un jeton OAuth"}
            </button>
          )}
          {isLocal && info?.note && (
            <span className="text-neutral-500">{info.note}</span>
          )}
        </div>

        {oauth && help?.command && (
          <p className="rounded-lg border border-sky-900/50 bg-sky-950/10 px-3 py-2 text-xs text-sky-200/80">
            Obtiens un jeton :{" "}
            <code className="rounded bg-neutral-950 px-1 py-0.5 font-mono">
              {help.command}
            </code>
            {help.note ? ` — ${help.note}` : ""}
          </p>
        )}
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
              <span className="ml-auto text-xs text-neutral-600">
                {modelCounts[c.provider] ?? 0} modèles
              </span>
              <form action={deleteConnectionAction}>
                <input type="hidden" name="id" value={c.id} />
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                  aria-label="Supprimer la connexion"
                >
                  ✕
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">
          Aucune connexion. Choisis un provider et colle ta clé — le routeur
          préfère le local gratuit quand il est présent.
        </p>
      )}
    </div>
  );
}
