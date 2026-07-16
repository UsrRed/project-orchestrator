"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { LiveAgent, LiveSnapshot } from "@/lib/live";

/**
 * Cadence de rafraîchissement. On sonde vite quand des agents tournent (la
 * valeur bouge), lentement sinon — et pas du tout onglet caché.
 */
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;

const STATUS_STYLE: Record<string, string> = {
  queued: "text-amber-300",
  running: "text-sky-300",
};

/**
 * HUD flottant, présent sur toutes les pages : nombre d'agents en cours et
 * tokens consommés en direct ; au clic, le détail des agents et les stats.
 */
export function LiveHud() {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  /** Non authentifié (page de connexion) → HUD invisible et sondage arrêté. */
  const [hidden, setHidden] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Vrai dès la première réponse : sert à ne sauter que les sondes suivantes. */
  const loaded = useRef(false);

  const poll = useCallback(async function poll() {
    // Onglet caché : on se met en veille — mais seulement une fois qu'on a de
    // quoi afficher. Sauter la toute première sonde laisserait le HUD vide au
    // moment où l'utilisateur revient sur l'onglet.
    if (document.hidden && loaded.current) return schedule(POLL_IDLE_MS);

    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      if (res.status === 401) {
        setHidden(true);
        return;
      }
      if (res.ok) {
        const data: LiveSnapshot = await res.json();
        loaded.current = true;
        setSnap(data);
        return schedule(
          data.running + data.queued > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS,
        );
      }
    } catch {
      // Réseau coupé / serveur qui redémarre : on retentera plus tard.
    }
    schedule(POLL_IDLE_MS);

    function schedule(ms: number) {
      timer.current = setTimeout(poll, ms);
    }
  }, []);

  useEffect(() => {
    void poll();
    // Retour sur l'onglet : on rafraîchit tout de suite plutôt que d'attendre.
    const onVisible = () => {
      if (!document.hidden) {
        if (timer.current) clearTimeout(timer.current);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  if (hidden || !snap) return null;

  const active = snap.running + snap.queued;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {open && <LivePanel snap={snap} onClose={() => setOpen(false)} />}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Activité des agents : ${active} en cours, ${formatTokens(
          snap.tokens.total,
        )} tokens`}
        className="flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/90 py-2 pl-2.5 pr-3 text-xs shadow-lg shadow-black/40 backdrop-blur transition hover:border-neutral-500"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {active > 0 && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
              active > 0 ? "bg-sky-400" : "bg-neutral-600"
            }`}
          />
        </span>
        <span
          className={`font-mono ${
            active > 0 ? "text-sky-300" : "text-neutral-400"
          }`}
        >
          {active}
        </span>
        <span className="text-neutral-700">|</span>
        <span className="font-mono text-neutral-300">
          {formatTokens(snap.tokens.total)}
        </span>
      </button>
    </div>
  );
}

function LivePanel({
  snap,
  onClose,
}: {
  snap: LiveSnapshot;
  onClose: () => void;
}) {
  return (
    <div className="w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-neutral-800 bg-neutral-950/95 p-4 shadow-xl shadow-black/50 backdrop-blur">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-100">
          Agents en cours
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="rounded px-1.5 text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
        >
          ✕
        </button>
      </div>

      {snap.agents.length > 0 ? (
        <ul className="mb-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
          {snap.agents.map((a) => (
            <AgentRow key={a.id} agent={a} />
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-xs text-neutral-500">
          Aucun agent en cours. Lance un run autonome depuis une tâche.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Tokens (total)" value={formatTokens(snap.tokens.total)} />
        <Stat label="Coût (total)" value={`$${snap.costUsd.toFixed(4)}`} />
        <Stat
          label="Tokens (1 h)"
          value={formatTokens(snap.recent.tokens)}
          accent="text-sky-300"
        />
        <Stat
          label="Coût (1 h)"
          value={`$${snap.recent.costUsd.toFixed(4)}`}
          accent="text-sky-300"
        />
      </div>

      <p className="mt-3 text-[11px] text-neutral-500">
        {snap.tokens.prompt.toLocaleString("fr-FR")} entrée ·{" "}
        {snap.tokens.completion.toLocaleString("fr-FR")} sortie ·{" "}
        {snap.executions.total} exécution
        {snap.executions.total > 1 ? "s" : ""}
      </p>

      <Link
        href="/health"
        className="mt-3 inline-block text-xs text-emerald-400 transition hover:text-emerald-300"
      >
        Voir la santé complète →
      </Link>
    </div>
  );
}

function AgentRow({ agent: a }: { agent: LiveAgent }) {
  return (
    <li className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2">
      <Link href={`/tasks/${a.taskId}`} className="group flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-[10px] uppercase ${
              STATUS_STYLE[a.status] ?? "text-neutral-400"
            }`}
          >
            {a.status}
          </span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            {a.engine}
            {a.boost && <span className="text-fuchsia-300"> +boost</span>}
          </span>
          {a.elapsedMs !== null && (
            <span className="ml-auto font-mono text-[10px] text-neutral-600">
              {formatDuration(a.elapsedMs)}
            </span>
          )}
        </div>
        <span className="truncate text-xs text-neutral-300 group-hover:text-neutral-100">
          {a.goal}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {a.iterations}/{a.maxIterations} it · ${a.spentUsd.toFixed(4)}/$
          {a.maxCostUsd.toFixed(2)}
        </span>
      </Link>
    </li>
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-sm ${accent ?? "text-neutral-100"}`}>
        {value}
      </div>
    </div>
  );
}

/** Compact pour tenir dans la pastille : 1234 → 1,2 k ; 2500000 → 2,5 M. */
function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(".", ",")} k`;
  return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
