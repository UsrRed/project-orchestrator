import Link from "next/link";

import { ExecutionsList } from "@/components/executions-list";
import { KeysManager } from "@/components/keys-manager";
import { RouterDemo } from "@/components/router-demo";
import { executionStats, listExecutions } from "@/lib/executions";
import { listApiKeys } from "@/lib/keys";
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

// Les données dépendent de la base (clés, exécutions) → rendu dynamique.
export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await getCurrentUserId();
  const [keys, executions, stats] = await Promise.all([
    listApiKeys(userId),
    listExecutions(userId),
    executionStats(userId),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Milestone 1 — routeur d&apos;intelligence
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Orchestrato.AI</h1>
        <p className="text-neutral-400">
          Gestion de projet pilotée par orchestration dynamique d&apos;IA. Le
          <strong> routeur</strong> choisit le modèle le plus adapté (complexité
          × contexte × coût), exécute l&apos;appel avec vos clés chiffrées, et
          journalise le <strong>coût réel</strong>.
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
        <h2 className="mb-1 text-lg font-semibold">Clés API</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Stockées chiffrées (AES-256-GCM). Le client ne reçoit qu&apos;un
          aperçu masqué — jamais la clé en clair.
        </p>
        <KeysManager keys={keys} />
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-4 text-lg font-semibold">Tester le routeur</h2>
        <RouterDemo />
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-1 text-lg font-semibold">Suivi du coût réel</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Table de vérité <code>agent_executions</code> — chaque appel routé y
          est journalisé.
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

      <footer className="text-xs text-neutral-600">
        Clés chiffrées hors-ligne · coût réel journalisé · routage multi-provider
      </footer>
    </main>
  );
}
