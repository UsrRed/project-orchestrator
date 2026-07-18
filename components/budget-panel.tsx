import type { BudgetStatus } from "@/lib/budgets";
import { setBudgetAction } from "@/app/projects/actions";

const fmt = (n: number) => n.toLocaleString("fr-FR");

/** Panneau budget d'un projet : tokens consommés/plafond, alerte, réglage. */
export function BudgetPanel({
  projectId,
  status,
}: {
  projectId: string;
  status: BudgetStatus;
}) {
  const { limitTokens, spentTokens, ratio, alert, exceeded } = status;
  const pct = Math.min(100, Math.round(ratio * 100));

  const barColor = exceeded
    ? "bg-red-500"
    : alert
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">
          Budget de tokens
        </h2>
        <span className="font-mono text-xs text-neutral-400">
          {fmt(spentTokens)}
          {limitTokens !== null ? ` / ${fmt(limitTokens)}` : " consommés"}
        </span>
      </div>

      {limitTokens !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {exceeded && (
        <p className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          ⛔ Plafond de tokens atteint — les nouveaux appels IA sur ce projet
          sont bloqués. Augmente le plafond pour reprendre.
        </p>
      )}
      {alert && (
        <p className="rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          ⚠️ Plafond de tokens consommé à {pct}%.
        </p>
      )}

      <form action={setBudgetAction} className="flex items-center gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <label className="text-xs text-neutral-500">Plafond (tokens)</label>
        <input
          name="limitTokens"
          type="number"
          min={0}
          step={1000}
          defaultValue={limitTokens ?? ""}
          placeholder="ex: 500000"
          className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
        >
          Enregistrer
        </button>
        <span className="text-[11px] text-neutral-600">0 = pas de plafond</span>
      </form>
    </section>
  );
}
