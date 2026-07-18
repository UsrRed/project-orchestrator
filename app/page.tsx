import Link from "next/link";

import { ExecutionsList } from "@/components/executions-list";
import { cliAgentStatuses } from "@/lib/cli-availability";
import { executionStats, listExecutions } from "@/lib/executions";
import { getCurrentUserId } from "@/lib/users";

const MILESTONES: Array<{ id: string; label: string; done: boolean }> = [
  { id: "M0", label: "Fondations + walking skeleton", done: true },
  { id: "M1", label: "Routeur d'Intelligence minimal", done: true },
  { id: "M2", label: "Agent Architecte", done: true },
  { id: "M3", label: "Modes Manuel + Cowork", done: true },
  { id: "M4", label: "Mode Autonome (Full-Auto)", done: true },
  { id: "M5", label: "Bibliothèque de Normes/Skills", done: true },
  { id: "M6", label: "UI adaptative + widgets", done: true },
];

// Les données dépendent de la base (exécutions) → rendu dynamique.
export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await getCurrentUserId();
  const [executions, stats] = await Promise.all([
    listExecutions(userId),
    executionStats(userId),
  ]);
  const claude = cliAgentStatuses().find((s) => s.id === "claude");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Orchestration de projet par Claude Code
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Orchestrato.AI</h1>
        <p className="text-neutral-400">
          Gestion de projet pilotée par <strong>Claude Code</strong>. L&apos;agent
          découpe l&apos;idée en phases, discute, et exécute les tâches
          autonomes directement dans le workspace — sur l&apos;abonnement de la
          machine, sans clé API. Chaque appel est journalisé avec ses tokens et
          son <strong>coût réel</strong>.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/projects"
          className="flex items-center justify-between rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-6 py-4 transition hover:border-emerald-600 hover:bg-emerald-950/40"
        >
          <span className="font-semibold text-emerald-200">
            Agent Architecte — projets →
          </span>
          <span className="text-xs text-emerald-500">M2–M4</span>
        </Link>
        <Link
          href="/normes"
          className="flex items-center justify-between rounded-xl border border-neutral-700 bg-neutral-900/40 px-6 py-4 transition hover:border-emerald-600 hover:bg-neutral-900/70"
        >
          <span className="font-semibold text-neutral-200">
            Bibliothèque de normes →
          </span>
          <span className="text-xs text-neutral-500">M5</span>
        </Link>
      </div>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-1 text-lg font-semibold">Moteur : Claude Code</h2>
        <p className="mb-4 text-sm text-neutral-500">
          L&apos;app n&apos;utilise que le binaire <code>claude</code> installé sur
          la machine du worker, avec son propre login (abonnement) — aucune clé API
          ni secret à stocker.
        </p>
        <div
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
            claude?.available
              ? "border-emerald-800/60 bg-emerald-950/20 text-emerald-200"
              : "border-amber-800/60 bg-amber-950/20 text-amber-200"
          }`}
        >
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              claude?.available ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          <span>
            {claude?.available
              ? "Claude Code est disponible sur la machine du worker."
              : (claude?.warning ??
                "Claude Code (`claude`) est introuvable dans le PATH du worker.")}
          </span>
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-1 text-lg font-semibold">Suivi du coût réel</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Table de vérité <code>agent_executions</code> — chaque appel de Claude
          Code y est journalisé, ventilé par modèle.
        </p>
        <ExecutionsList executions={executions} stats={stats} />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Jalons</h2>
        <ul className="flex flex-col gap-2">
          {MILESTONES.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/30 px-4 py-3"
            >
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  m.done
                    ? "bg-emerald-500 text-neutral-950"
                    : "border border-neutral-700 text-neutral-500"
                }`}
              >
                {m.done ? "✓" : ""}
              </span>
              <span className="font-mono text-sm text-neutral-500">{m.id}</span>
              <span
                className={m.done ? "text-neutral-200" : "text-neutral-500"}
              >
                {m.label}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex items-center justify-between text-xs text-neutral-600">
        <span>Claude Code · abonnement · coût réel journalisé</span>
        <Link href="/health" className="hover:text-neutral-300">
          Santé →
        </Link>
      </footer>
    </main>
  );
}
