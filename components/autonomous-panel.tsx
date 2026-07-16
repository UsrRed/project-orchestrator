"use client";

import { useActionState, useState } from "react";

import {
  killRunAction,
  startRunAction,
  type RunFormState,
} from "@/app/tasks/[taskId]/actions";
import type { CliAgentStatus } from "@/lib/cli-availability";
import type { RunRow } from "@/lib/runs";

const INITIAL: RunFormState = { ok: false, message: "" };

const STATUS_STYLE: Record<string, string> = {
  queued: "text-amber-300",
  running: "text-sky-300",
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
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

export function AutonomousPanel({
  taskId,
  runs,
  cliAgents,
}: {
  taskId: string;
  runs: RunRow[];
  /** Agents CLI détectés sur la machine (cf. lib/cli-availability.ts). */
  cliAgents: CliAgentStatus[];
}) {
  const [state, formAction, pending] = useActionState(startRunAction, INITIAL);
  const [engine, setEngine] = useState("llm");

  const isCli = engine !== "llm";
  const selected = cliAgents.find((c) => c.id === engine);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Objectif du run autonome</span>
          <textarea
            name="goal"
            rows={2}
            required
            placeholder="Ex: rédiger un premier plan détaillé pour cette tâche…"
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Moteur d&apos;exécution</span>
          <select
            name="engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
          >
            <option value="llm">LLM (routeur) — produit du texte</option>
            {cliAgents.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.available}>
                {c.label}
                {c.available ? " — écrit du code" : " — indisponible"}
              </option>
            ))}
          </select>
        </label>

        {isCli && (
          <p className="rounded-lg border border-amber-900 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
            L&apos;agent <code>{engine}</code> s&apos;exécute sur la machine du
            worker, dans le workspace du projet : il{" "}
            <strong>modifie réellement les fichiers</strong> (sans commiter ni
            pousser — tu reliras le diff). Il utilise son propre login, aucune
            clé API de l&apos;app.
            {selected && !selected.reportsCost && (
              <>
                {" "}
                Il ne remonte aucun coût :{" "}
                <strong>le plafond ci-dessous ne le limitera pas</strong> —
                seuls les itérations et le timeout le borneront.
              </>
            )}
          </p>
        )}

        {/* Sans objet en moteur CLI : l'agent choisit son modèle lui-même. */}
        {!isCli && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="boost"
              className="mt-1 accent-sky-500"
            />
            <span>
              <span className="text-neutral-300">Boost</span>
              <span className="block text-xs text-neutral-500">
                Router vers le modèle le plus capable au lieu du moins cher
                atteignant le niveau requis. Plus coûteux — le plafond ci-dessous
                le borne.
              </span>
            </span>
          </label>
        )}

        {selected?.warning && !selected.available && (
          <p className="rounded-lg border border-red-900 bg-red-950/20 px-3 py-2 text-xs text-red-200">
            {selected.warning}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Max itérations
            <input
              // Remonté à chaque changement de moteur pour reprendre le défaut :
              // un agent CLI boucle déjà en interne, une invocation suffit.
              key={isCli ? "cli" : "llm"}
              name="maxIterations"
              type="number"
              min={1}
              max={20}
              defaultValue={isCli ? 1 : 5}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Plafond coût ($)
            <input
              name="maxCostUsd"
              type="number"
              min={0.01}
              step={0.01}
              defaultValue={0.5}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Timeout (min)
            <input
              // Un agent CLI travaille en minutes, pas en secondes : 10 min
              // suffisent au moteur `llm` mais couperaient souvent un run CLI.
              key={isCli ? "cli" : "llm"}
              name="timeoutMin"
              type="number"
              min={1}
              max={120}
              defaultValue={isCli ? 30 : 10}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-sky-400 disabled:opacity-50"
        >
          {pending ? "Mise en file…" : "Lancer un run autonome"}
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
        <ul className="flex flex-col gap-2">
          {runs.map((r) => {
            const active = r.status === "queued" || r.status === "running";
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm"
              >
                <span
                  className={`font-mono text-xs uppercase ${
                    STATUS_STYLE[r.status] ?? "text-neutral-400"
                  }`}
                >
                  {r.status}
                </span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                  {r.engine === "cli" ? r.engineCli : "llm"}
                  {r.boost && (
                    <span className="text-fuchsia-300"> +boost</span>
                  )}
                </span>
                <span className="flex-1 truncate text-neutral-300">
                  {r.goal}
                </span>
                <span className="text-xs text-neutral-500">
                  {r.iterations}/{r.maxIterations} it · ${r.spentUsd.toFixed(4)}/
                  ${r.maxCostUsd.toFixed(2)}
                </span>
                {r.stopReason && (
                  <span className="text-xs text-neutral-500">
                    {STOP_LABEL[r.stopReason] ?? r.stopReason}
                  </span>
                )}
                {active && (
                  <form action={killRunAction}>
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
