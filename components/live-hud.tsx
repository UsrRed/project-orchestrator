"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ModelUsageRow } from "@/lib/executions";
import type { ClaudeQuota, LiveAgent, LiveSnapshot } from "@/lib/live";

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
 * Comment le modèle a été payé. Un run `claude` passe par un abonnement CLI,
 * un appel `anthropic` par une clé API : même modèle, facturation opposée —
 * les confondre rendrait la ventilation trompeuse.
 */
function providerKind(provider: string): { label: string; style: string } {
  return provider.endsWith("_cli")
    ? { label: "CLI", style: "bg-fuchsia-950 text-fuchsia-300" }
    : { label: "API", style: "bg-sky-950 text-sky-300" };
}

/** `claude_cli` → `claude` : le badge CLI/API porte déjà la distinction. */
function providerName(provider: string): string {
  return provider.replace(/_cli$/, "");
}

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

      <ModelBreakdown snap={snap} />

      {snap.claude && <ClaudeQuotaPanel quota={snap.claude} />}

      <Link
        href="/health"
        className="mt-3 inline-block text-xs text-emerald-400 transition hover:text-emerald-300"
      >
        Voir la santé complète →
      </Link>
    </div>
  );
}

/**
 * Tokens par modèle, avec bascule entre la fenêtre live (1 h) et le cumul.
 * Le global écrase vite le live une fois l'historique constitué : garder les
 * deux sous le même œil est tout l'intérêt.
 */
function ModelBreakdown({ snap }: { snap: LiveSnapshot }) {
  const [scope, setScope] = useState<"recent" | "global">("recent");
  const rows = snap.byModel[scope];
  const totalTokens =
    scope === "recent" ? snap.recent.tokens : snap.tokens.total;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-neutral-300">
          Tokens par modèle
        </h3>
        <div className="flex rounded border border-neutral-800 p-0.5 text-[10px]">
          {(
            [
              ["recent", "1 h"],
              ["global", "global"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setScope(k)}
              aria-pressed={scope === k}
              className={`rounded px-1.5 py-0.5 transition ${
                scope === k
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {rows.length > 0 ? (
        <>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {rows.map((r) => (
              <ModelRow key={`${r.provider}/${r.model}`} row={r} />
            ))}
          </ul>
          <div className="flex items-baseline justify-between border-t border-neutral-800 pt-1.5 text-[11px]">
            <span className="text-neutral-500">Total</span>
            <span className="font-mono text-neutral-200">
              {formatTokens(totalTokens)} tokens
            </span>
          </div>
        </>
      ) : (
        <p className="text-xs text-neutral-500">
          {scope === "recent"
            ? "Rien consommé sur la dernière heure."
            : "Aucune consommation journalisée."}
        </p>
      )}
    </section>
  );
}

/**
 * Quota d'abonnement Claude : ce qu'il RESTE, et ce qui a été consommé depuis
 * le premier relevé de la fenêtre (le « avant »).
 *
 * La mention « machine » n'est pas un détail de politesse : ce quota inclut la
 * consommation faite hors de l'app, donc un delta non nul ne prouve pas qu'un
 * run de l'app en est la cause.
 */
function ClaudeQuotaPanel({ quota }: { quota: ClaudeQuota }) {
  return (
    <section className="mt-3 flex flex-col gap-2 border-t border-neutral-800 pt-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-neutral-300">
          Abonnement Claude
        </h3>
        <span className="font-mono text-[10px] text-neutral-600">machine</span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {quota.limits.map((l) => (
          <li key={l.key} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-neutral-400">
                {l.label}
              </span>
              <span className="font-mono text-neutral-200">
                {formatPercent(100 - l.percentUsed)} restant
              </span>
              {l.deltaPoints !== null && l.deltaPoints > 0 && (
                <span className="font-mono text-amber-300">
                  −{formatPercent(l.deltaPoints)}
                </span>
              )}
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-neutral-800"
              role="progressbar"
              aria-valuenow={Math.round(l.percentUsed)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${l.label} : ${formatPercent(l.percentUsed)} utilisé`}
            >
              <div
                className={`h-full rounded-full ${
                  l.percentUsed >= 90
                    ? "bg-red-400"
                    : l.percentUsed >= 70
                      ? "bg-amber-400"
                      : "bg-emerald-400"
                }`}
                style={{ width: `${Math.min(100, l.percentUsed)}%` }}
              />
            </div>
            {l.resetsAt && (
              <span className="text-[10px] text-neutral-600">
                remis à zéro {l.resetsAt}
              </span>
            )}
          </li>
        ))}
      </ul>

      <p className="text-[10px] leading-relaxed text-neutral-600">
        {quota.comparedTo ? (
          <>
            Baisse mesurée depuis {formatClock(quota.comparedTo)}
            {quota.agentsActiveBefore ? " (agents actifs)" : " (aucun agent)"}.{" "}
          </>
        ) : (
          <>Premier relevé : rien à comparer pour l&apos;instant. </>
        )}
        Quota du login <code>claude</code> de la machine — il inclut ton usage
        hors de l&apos;app.
      </p>
    </section>
  );
}

function ModelRow({ row: r }: { row: ModelUsageRow }) {
  const kind = providerKind(r.provider);
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <span
        className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9px] ${kind.style}`}
        title={r.provider}
      >
        {kind.label}
      </span>
      <span className="min-w-0 flex-1 truncate" title={`${r.provider}/${r.model}`}>
        <span className="text-neutral-300">{r.model}</span>
        <span className="text-neutral-600"> · {providerName(r.provider)}</span>
      </span>
      <span
        className="shrink-0 font-mono text-neutral-400"
        title={`${r.promptTokens.toLocaleString("fr-FR")} entrée · ${r.completionTokens.toLocaleString(
          "fr-FR",
        )} sortie · ${r.count} appel${r.count > 1 ? "s" : ""}`}
      >
        {formatTokens(r.tokens)}
      </span>
    </li>
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
          {/* Limites absentes tant que l'IA n'a pas planifié le run. */}
          {a.iterations}/{a.maxIterations ?? "?"} it ·{" "}
          {a.maxTokens > 0
            ? `${formatTokens(a.spentTokens)}/${formatTokens(a.maxTokens)} tk`
            : `${formatTokens(a.spentTokens)} tk`}
        </span>
      </Link>
    </li>
  );
}

/** Compact pour tenir dans la pastille : 1234 → 1,2 k ; 2500000 → 2,5 M. */
function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(".", ",")} k`;
  return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
}

/** `8` → `8 %` ; `0,5` → `0,5 %`. Pas de décimale inutile. */
function formatPercent(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${String(Number.isInteger(rounded) ? rounded : rounded.toFixed(1)).replace(".", ",")} %`;
}

function formatClock(d: Date | string): string {
  return new Date(d).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
