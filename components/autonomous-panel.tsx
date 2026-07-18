"use client";

import { useActionState, useState } from "react";

import {
  killRunAction,
  startRunAction,
  type RunFormState,
} from "@/app/tasks/[taskId]/actions";
import { PromptSuggestions } from "@/components/prompt-suggestions";
import type { RunRow } from "@/lib/runs";

const INITIAL: RunFormState = { ok: false, message: "" };

const STATUS_STYLE: Record<string, string> = {
  queued: "text-amber-300",
  running: "text-sky-300",
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
};

const STATUS_LABEL: Record<string, string> = {
  queued: "en attente",
  running: "en cours",
  succeeded: "terminé",
  failed: "échec",
  cancelled: "arrêté",
};

const STOP_LABEL: Record<string, string> = {
  completed: "objectif atteint",
  budget: "plafond de coût atteint",
  project_budget: "budget du projet dépassé",
  iterations: "max d'itérations atteint",
  timeout: "timeout",
  killed: "arrêté (kill switch)",
  error: "erreur",
};

const fieldClass =
  "rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-emerald-500";

export function AutonomousPanel({
  taskId,
  runs,
}: {
  taskId: string;
  runs: RunRow[];
}) {
  const [state, formAction, pending] = useActionState(startRunAction, INITIAL);

  // Un seul réglage avancé, replié par défaut : sans lui, l'agent décide de ses
  // limites (une invocation, 30 min max).
  const [customLimits, setCustomLimits] = useState(false);

  // Objectif contrôlé : une suggestion de prompt le remplit au clic.
  const [goal, setGoal] = useState("");

  return (
    <div className="flex flex-col gap-5">
      {/* Hors du <form> : PromptSuggestions a son propre formulaire (imbrication
          interdite en HTML). Un clic remplit l'objectif contrôlé ci-dessous. */}
      <PromptSuggestions taskId={taskId} onPick={setGoal} />
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="taskId" value={taskId} />

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-200">
            Qu&apos;est-ce que l&apos;agent doit accomplir ?
          </span>
          <textarea
            name="goal"
            rows={3}
            required
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Ex : implémenter cette tâche directement dans le dépôt, avec un résumé des changements."
            className={fieldClass}
          />
          <span className="text-xs text-neutral-500">
            Claude Code travaille dans le workspace du projet, sur l&apos;abonnement
            de la machine — il modifie réellement les fichiers (sans commiter ni
            pousser : tu reliras le diff).
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-200">
            Plafond de dépense
          </span>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">$</span>
            <input
              name="maxCostUsd"
              type="number"
              min={0}
              max={50}
              step={0.01}
              defaultValue={0}
              className={`${fieldClass} w-28`}
            />
          </div>
          <span className="text-xs text-neutral-500">
            <strong className="text-emerald-400">0 = ne rien facturer</strong> :
            l&apos;abonnement Claude reste gratuit au token ; ce plafond n&apos;arrête
            le run que si un coût réel apparaissait malgré tout.
          </span>
        </label>

        {/* --- Réglage avancé -------------------------------------------- */}

        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/50 p-4">
          <Toggle
            name="customLimits"
            checked={customLimits}
            onChange={setCustomLimits}
            label="Fixer les limites moi-même"
            hint="Par défaut : une invocation de l'agent (qui boucle déjà en interne), 30 min max. Le plafond de dépense, lui, reste toujours le tien."
          />

          {customLimits && (
            <div className="grid grid-cols-2 gap-3 border-l border-neutral-800 pl-4">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Max itérations
                <input
                  name="maxIterations"
                  type="number"
                  min={1}
                  max={20}
                  placeholder="auto"
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Timeout (min)
                <input
                  name="timeoutMin"
                  type="number"
                  min={1}
                  max={120}
                  placeholder="auto"
                  className={fieldClass}
                />
              </label>
              <p className="col-span-2 text-xs text-neutral-600">
                Laisse un champ vide pour garder la valeur par défaut.
              </p>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-sky-400 disabled:opacity-50"
        >
          {pending ? "Lancement…" : "Lancer l'agent"}
        </button>

        {state.message && (
          <p
            className={`rounded-lg border px-4 py-2 text-sm ${
              state.ok
                ? "border-sky-800 bg-sky-950/30 text-sky-200"
                : "border-red-800 bg-red-950/30 text-red-200"
            }`}
          >
            {state.message}
          </p>
        )}
      </form>

      {runs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">
            Runs de cette tâche
          </h3>
          <ul className="flex flex-col gap-2">
            {runs.map((r) => (
              <RunItem key={r.id} run={r} taskId={taskId} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Toggle({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-sky-500"
      />
      <span>
        <span className="text-neutral-300">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  );
}

function RunItem({ run: r, taskId }: { run: RunRow; taskId: string }) {
  const active = r.status === "queued" || r.status === "running";
  // Un run non préparé n'a pas encore de limites : afficher « 0/5 » serait
  // inventer une borne que rien n'a décidée.
  const planned = r.maxIterations !== null;

  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`font-mono text-xs uppercase ${
            STATUS_STYLE[r.status] ?? "text-neutral-400"
          }`}
        >
          {STATUS_LABEL[r.status] ?? r.status}
        </span>
        {r.sourceLabel ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
            {r.sourceLabel}
          </span>
        ) : (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
            en préparation…
          </span>
        )}
        {active && (
          <form action={killRunAction} className="ml-auto">
            <input type="hidden" name="runId" value={r.id} />
            <input type="hidden" name="taskId" value={taskId} />
            <button
              type="submit"
              className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
              title="Arrêter le run (kill switch)"
            >
              ⛔ Stop
            </button>
          </form>
        )}
      </div>

      <span className="text-neutral-300">{r.goal}</span>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span>
          {r.iterations}/{planned ? r.maxIterations : "?"} itérations
        </span>
        <span>
          {r.maxCostUsd > 0
            ? `$${r.spentUsd.toFixed(4)} / $${r.maxCostUsd.toFixed(2)}`
            : `${r.spentUsd > 0 ? `$${r.spentUsd.toFixed(4)} — ` : ""}sans dépense`}
        </span>
        {r.timeoutMin !== null && <span>{r.timeoutMin} min max</span>}
        {r.stopReason && (
          <span className="text-neutral-400">
            {STOP_LABEL[r.stopReason] ?? r.stopReason}
          </span>
        )}
      </div>

      {r.planReason && (
        <p className="text-xs text-neutral-600">{r.planReason}</p>
      )}
      {r.error && (
        <p className="rounded border border-red-900/50 bg-red-950/20 px-2 py-1 text-xs text-red-300">
          {r.error}
        </p>
      )}
    </li>
  );
}
