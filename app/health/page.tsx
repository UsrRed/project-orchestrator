import Link from "next/link";

import {
  executionHealth,
  listFailedExecutions,
} from "@/lib/executions";
import { listRecentRuns, runHealth } from "@/lib/runs";
import { getCurrentUserId } from "@/lib/users";

export const dynamic = "force-dynamic";

const RUN_STATUS_COLOR: Record<string, string> = {
  queued: "text-amber-300",
  running: "text-sky-300",
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
};

export default async function HealthPage() {
  const userId = await getCurrentUserId();
  const [exec, failedExecs, runs, recentRuns] = await Promise.all([
    executionHealth(userId),
    listFailedExecutions(userId),
    runHealth(userId),
    listRecentRuns(userId),
  ]);

  const sentryOn = Boolean(process.env.SENTRY_DSN);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Accueil
        </Link>
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Milestone 7.4 — observabilité
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Santé</h1>
        <p className="text-sm text-neutral-400">
          Taux d&apos;échec des exécutions, coût, et derniers incidents. Capture
          Sentry&nbsp;:{" "}
          <span className={sentryOn ? "text-emerald-400" : "text-neutral-500"}>
            {sentryOn ? "activée" : "désactivée (définir SENTRY_DSN)"}
          </span>
          .
        </p>
      </header>

      {/* Exécutions */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Exécutions LLM</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={String(exec.total)} />
          <Stat label="Réussies" value={String(exec.succeeded)} accent="text-emerald-400" />
          <Stat
            label="Échecs"
            value={String(exec.failed)}
            accent={exec.failed > 0 ? "text-red-400" : undefined}
          />
          <Stat
            label="Taux d'échec"
            value={`${(exec.failureRate * 100).toFixed(1)}%`}
            accent={exec.failureRate > 0 ? "text-red-400" : undefined}
          />
        </div>
        <p className="text-xs text-neutral-500">
          Coût total réel journalisé&nbsp;:{" "}
          <span className="font-mono text-neutral-300">
            ${exec.totalCostUsd.toFixed(6)}
          </span>
        </p>
      </section>

      {/* Runs autonomes */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Runs autonomes</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(
            ["total", "running", "queued", "succeeded", "failed", "cancelled"] as const
          ).map((k) => (
            <Stat
              key={k}
              label={k}
              value={String(runs[k])}
              accent={RUN_STATUS_COLOR[k]}
            />
          ))}
        </div>
      </section>

      {/* Derniers échecs */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Derniers échecs d&apos;exécution</h2>
        {failedExecs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead className="text-neutral-500">
                <tr className="border-b border-neutral-800">
                  <th className="py-2 pr-3 font-medium">Requête</th>
                  <th className="py-2 pr-3 font-medium">Modèle</th>
                  <th className="py-2 font-medium">Quand</th>
                </tr>
              </thead>
              <tbody className="text-neutral-300">
                {failedExecs.map((e) => (
                  <tr key={e.id} className="border-b border-neutral-900">
                    <td className="max-w-[220px] truncate py-2 pr-3">
                      {e.taskLabel ?? "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono">
                      <span className="text-red-400">{e.provider}</span>/{e.model}
                    </td>
                    <td className="py-2 text-neutral-500">
                      {e.createdAt.toLocaleString("fr-FR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Aucun échec d&apos;exécution. 🎉</p>
        )}
      </section>

      {/* Derniers runs */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Derniers runs</h2>
        {recentRuns.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {recentRuns.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2 text-sm"
              >
                <span
                  className={`font-mono text-xs uppercase ${
                    RUN_STATUS_COLOR[r.status] ?? "text-neutral-400"
                  }`}
                >
                  {r.status}
                </span>
                <span className="flex-1 truncate text-neutral-300">{r.goal}</span>
                {r.stopReason && (
                  <span className="text-xs text-neutral-500">{r.stopReason}</span>
                )}
                <span className="text-xs text-neutral-600">
                  {r.iterations} it · ${r.spentUsd.toFixed(4)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">Aucun run pour l&apos;instant.</p>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg ${accent ?? "text-neutral-100"}`}>
        {value}
      </div>
    </div>
  );
}
