"use client";

import { useActionState, useState } from "react";

import {
  killRunAction,
  startRunAction,
  type RunFormState,
} from "@/app/tasks/[taskId]/actions";
import type { CliAgentStatus } from "@/lib/cli-availability";
import { LEVEL_LABEL, type IntelligenceLevel } from "@/lib/intelligence";
import type { RunRow } from "@/lib/runs";
import { SOURCE_LABEL, type OrderedSourceKind } from "@/lib/sources";

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
  cliAgents,
  sourceOrder,
}: {
  taskId: string;
  runs: RunRow[];
  /** Agents CLI détectés sur la machine (cf. lib/cli-availability.ts). */
  cliAgents: CliAgentStatus[];
  /** Ordre de préférence des sources, issu du profil. */
  sourceOrder: readonly OrderedSourceKind[];
}) {
  const [state, formAction, pending] = useActionState(startRunAction, INITIAL);

  // Deux réglages avancés, repliés par défaut : sans eux, l'IA décide de tout.
  const [customModel, setCustomModel] = useState(false);
  const [customLimits, setCustomLimits] = useState(false);
  const [engine, setEngine] = useState("llm");

  const isCli = customModel && engine !== "llm";
  const selected = cliAgents.find((c) => c.id === engine);

  return (
    <div className="flex flex-col gap-5">
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
            placeholder="Ex : rédiger un plan détaillé pour cette tâche, avec les étapes et les risques."
            className={fieldClass}
          />
          <span className="text-xs text-neutral-500">
            C&apos;est la seule chose obligatoire : l&apos;IA en déduit le reste.
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
            <strong className="text-emerald-400">0 = ne rien dépenser</strong> :
            le run n&apos;utilisera que ton modèle local, ton abonnement ou des
            modèles gratuits. Au-dessus de 0, les modèles payants deviennent
            possibles si rien de gratuit n&apos;est assez capable.
          </span>
        </label>

        {/* --- Réglages avancés ------------------------------------------ */}

        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/50 p-4">
          <Toggle
            name="customModel"
            checked={customModel}
            onChange={setCustomModel}
            label="Choisir le modèle moi-même"
            hint={
              <>
                Par défaut, l&apos;IA évalue la difficulté de la tâche puis prend
                la source la moins chère qui en est capable, dans cet ordre :{" "}
                <strong className="text-neutral-300">
                  {sourceOrder.map((s) => SOURCE_LABEL[s]).join(" → ")}
                </strong>{" "}
                (modifiable dans ton profil).
              </>
            }
          />

          {customModel && (
            <div className="flex flex-col gap-3 border-l border-neutral-800 pl-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-400">Moteur d&apos;exécution</span>
                <select
                  name="engine"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  className={fieldClass}
                >
                  <option value="llm">Routeur LLM — produit du texte</option>
                  {cliAgents.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.available}>
                      {c.label} (abonnement)
                      {c.available ? " — écrit du code" : " — indisponible"}
                    </option>
                  ))}
                </select>
              </label>

              {isCli && (
                <p className="rounded-lg border border-amber-900 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                  L&apos;agent <code>{engine}</code> s&apos;exécute sur la machine
                  du worker, dans le workspace du projet : il{" "}
                  <strong>modifie réellement les fichiers</strong> (sans commiter
                  ni pousser — tu reliras le diff). Il utilise son propre login,
                  aucune clé API de l&apos;app.
                  {selected && !selected.reportsCost && (
                    <>
                      {" "}
                      Il ne remonte aucun coût :{" "}
                      <strong>le plafond ne le limitera pas</strong> — seuls les
                      itérations et le timeout le borneront.
                    </>
                  )}
                </p>
              )}

              {selected?.warning && !selected.available && (
                <p className="rounded-lg border border-red-900 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                  {selected.warning}
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
                      Prendre le modèle le plus capable au lieu du moins cher qui
                      suffit. Plus coûteux — le plafond le borne.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          <Toggle
            name="customLimits"
            checked={customLimits}
            onChange={setCustomLimits}
            label="Fixer les limites moi-même"
            hint="Par défaut, l'IA estime le nombre d'étapes et la durée d'après l'objectif. Le plafond de dépense, lui, reste toujours le tien."
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
                Laisse un champ vide pour que l&apos;IA l&apos;estime quand même.
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
  // Un run non planifié n'a pas encore de limites : afficher « 0/5 » serait
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
            source en cours de choix…
          </span>
        )}
        {r.plannedLevel !== null && (
          <span
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
            title={
              r.planner === "heuristic"
                ? "Estimation par défaut (aucune IA gratuite disponible)."
                : "Niveau estimé par l'IA — une estimation, pas une mesure."
            }
          >
            niveau {r.plannedLevel} {LEVEL_LABEL[r.plannedLevel as IntelligenceLevel]}
            {r.planner === "heuristic" && " ~"}
          </span>
        )}
        {r.boost && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-fuchsia-300">
            boost
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
