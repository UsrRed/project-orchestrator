import type { ExecutionStats, ExecutionView } from "@/lib/executions";

const fmt = (n: number) => n.toLocaleString("fr-FR");

/** Historique + agrégats de tokens (table de vérité `agent_executions`). */
export function ExecutionsList({
  executions,
  stats,
}: {
  executions: ExecutionView[];
  stats: ExecutionStats;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Exécutions" value={fmt(stats.count)} />
        <Stat
          label="Tokens"
          value={fmt(stats.totalPromptTokens + stats.totalCompletionTokens)}
        />
        <Stat
          label="Entrée / sortie"
          value={`${fmt(stats.totalPromptTokens)} / ${fmt(stats.totalCompletionTokens)}`}
        />
      </div>

      {executions.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="text-neutral-500">
              <tr className="border-b border-neutral-800">
                <th className="py-2 pr-3 font-medium">Requête</th>
                <th className="py-2 pr-3 font-medium">Modèle</th>
                <th className="py-2 pr-3 font-medium">Tier</th>
                <th className="py-2 pr-3 font-medium">Tokens (E/S)</th>
                <th className="py-2 font-medium">Statut</th>
              </tr>
            </thead>
            <tbody className="font-mono text-neutral-300">
              {executions.map((e) => (
                <tr key={e.id} className="border-b border-neutral-900">
                  <td className="max-w-[220px] truncate py-2 pr-3 font-sans text-neutral-400">
                    {e.taskLabel ?? "—"}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="text-emerald-400">{e.provider}</span>/
                    {e.model}
                  </td>
                  <td className="py-2 pr-3">{e.tier ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {fmt(e.promptTokens)}/{fmt(e.completionTokens)}
                  </td>
                  <td className="py-2">
                    <span
                      className={
                        e.status === "succeeded"
                          ? "text-emerald-400"
                          : "text-red-400"
                      }
                    >
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          Aucune exécution encore. Lance un run ou une action IA pour voir
          apparaître les tokens consommés ici.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-lg text-neutral-100">{value}</div>
    </div>
  );
}
