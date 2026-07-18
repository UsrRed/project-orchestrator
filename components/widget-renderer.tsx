/**
 * Rendu whitelisté des widgets « generative UI » (Milestone 6, élargi).
 *
 * Ne rend QUE des types de widgets connus, à partir de données déjà validées
 * par `parseWidget` (schéma Zod). Aucun HTML brut injecté dans le DOM de l'app,
 * aucun `dangerouslySetInnerHTML`, aucune exécution de code fourni par le modèle
 * → pas de surface XSS. Le widget `sandboxed_html` fait exception CONTRÔLÉE : son
 * HTML est rendu dans un `<iframe srcdoc sandbox="">` totalement isolé (pas de
 * scripts, pas d'accès à l'origine, aux cookies ni au DOM parent).
 */
import { parseWidget, type Widget } from "@/lib/widgets";

/** Palette fixe (whitelistée) pour les segments/barres — jamais fournie par le LLM. */
const PALETTE = [
  "#34d399", // emerald
  "#60a5fa", // blue
  "#f472b6", // pink
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#a3e635", // lime
];

/** Somme des valeurs, en ignorant les valeurs négatives/non finies. */
function sumValues(values: number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) && v > 0 ? v : 0), 0);
}

/** Ramène une valeur dans [0, 100] pour les jauges. */
function pct(value: number, target?: number): number {
  const base = target && target > 0 ? (value / target) * 100 : value;
  if (!Number.isFinite(base)) return 0;
  return Math.max(0, Math.min(100, base));
}

/** Rend un widget à partir de son contenu brut (JSON string ou objet). */
export function WidgetRenderer({ raw }: { raw: unknown }) {
  const widget = parseWidget(raw);
  if (!widget) {
    return (
      <p className="text-xs text-red-400">
        Widget non conforme au schéma — rendu ignoré.
      </p>
    );
  }
  return <WidgetView widget={widget} />;
}

function WidgetView({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "comparison_table":
      return (
        <figure className="flex flex-col gap-2">
          <figcaption className="text-sm font-medium text-neutral-200">
            {widget.title}
          </figcaption>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-700 text-neutral-400">
                  {widget.columns.map((c, i) => (
                    <th key={i} className="px-3 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {widget.rows.map((row, r) => (
                  <tr key={r} className="border-b border-neutral-800">
                    {row.cells.map((cell, c) => (
                      <td key={c} className="px-3 py-2 text-neutral-300">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );

    case "checklist":
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <ul className="flex flex-col gap-1">
            {widget.items.map((it, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
                    it.checked
                      ? "border-emerald-500 bg-emerald-500 text-neutral-950"
                      : "border-neutral-600 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span
                  className={
                    it.checked ? "text-neutral-500 line-through" : "text-neutral-300"
                  }
                >
                  {it.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "kpi_grid":
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {widget.metrics.map((m, i) => (
              <div
                key={i}
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2"
              >
                <div className="text-xs text-neutral-500">{m.label}</div>
                <div className="mt-1 font-mono text-lg text-neutral-100">
                  {m.value}
                </div>
                {m.hint && (
                  <div className="mt-0.5 text-[11px] text-neutral-600">
                    {m.hint}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      );

    case "callout": {
      const styles: Record<string, string> = {
        info: "border-sky-800 bg-sky-950/20 text-sky-200",
        warn: "border-amber-800 bg-amber-950/20 text-amber-200",
        success: "border-emerald-800 bg-emerald-950/20 text-emerald-200",
      };
      return (
        <div className={`rounded-lg border px-4 py-3 ${styles[widget.level]}`}>
          <div className="text-sm font-semibold">{widget.title}</div>
          <p className="mt-1 text-sm opacity-90">{widget.body}</p>
        </div>
      );
    }

    case "bar_chart": {
      const max = Math.max(1, ...widget.bars.map((b) => (b.value > 0 ? b.value : 0)));
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <ul className="flex flex-col gap-1.5">
            {widget.bars.map((b, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-neutral-300">{b.label}</span>
                  <span className="font-mono text-neutral-400">
                    {b.value}
                    {b.hint ? ` · ${b.hint}` : ""}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${Math.max(0, (b.value / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case "progress":
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <ul className="flex flex-col gap-2">
            {widget.items.map((it, i) => {
              const p = pct(it.value, it.target);
              return (
                <li key={i} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-neutral-300">{it.label}</span>
                    <span className="font-mono text-neutral-400">
                      {it.target && it.target > 0
                        ? `${it.value}/${it.target}`
                        : `${Math.round(p)}%`}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${p}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      );

    case "timeline": {
      const dot: Record<string, string> = {
        done: "border-emerald-500 bg-emerald-500",
        current: "border-sky-400 bg-sky-400 animate-pulse",
        todo: "border-neutral-600 bg-transparent",
      };
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <ol className="flex flex-col">
            {widget.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${dot[s.status]}`}
                  />
                  {i < widget.steps.length - 1 && (
                    <span className="w-px flex-1 bg-neutral-800" />
                  )}
                </div>
                <div className="pb-3">
                  <div
                    className={`text-sm ${
                      s.status === "todo" ? "text-neutral-500" : "text-neutral-200"
                    }`}
                  >
                    {s.label}
                  </div>
                  {s.detail && (
                    <div className="text-xs text-neutral-500">{s.detail}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      );
    }

    case "distribution": {
      const total = sumValues(widget.segments.map((s) => s.value)) || 1;
      return (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium text-neutral-200">{widget.title}</h4>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-neutral-800">
            {widget.segments.map((s, i) => (
              <div
                key={i}
                style={{
                  width: `${Math.max(0, (s.value / total) * 100)}%`,
                  backgroundColor: PALETTE[i % PALETTE.length],
                }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {widget.segments.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                />
                {s.label}
                <span className="font-mono text-neutral-500">
                  {Math.round((s.value / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case "metric": {
      const trend = widget.trend ?? "flat";
      const trendStyle: Record<string, string> = {
        up: "text-emerald-400",
        down: "text-red-400",
        flat: "text-neutral-500",
      };
      const arrow: Record<string, string> = { up: "▲", down: "▼", flat: "→" };
      return (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-neutral-500">{widget.title}</div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl text-neutral-100">
              {widget.value}
            </span>
            {widget.unit && (
              <span className="text-sm text-neutral-500">{widget.unit}</span>
            )}
          </div>
          {(widget.delta || widget.trend) && (
            <div className={`text-xs ${trendStyle[trend]}`}>
              {arrow[trend]} {widget.delta ?? ""}
            </div>
          )}
        </div>
      );
    }

    case "sandboxed_html":
      // HTML « libre » du modèle, rendu dans un bac à sable TOTAL :
      // `sandbox=""` interdit scripts, forms, popups, navigation ET l'accès à
      // l'origine (cookies, storage, DOM parent). Ne JAMAIS ajouter
      // `allow-scripts` avec `allow-same-origin` : la combinaison lève le bac à
      // sable. `referrerPolicy` coupe toute fuite d'URL.
      return (
        <figure className="flex flex-col gap-2">
          <figcaption className="text-sm font-medium text-neutral-200">
            {widget.title}
          </figcaption>
          <iframe
            title={widget.title}
            srcDoc={widget.html}
            sandbox=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className="h-64 w-full rounded-lg border border-neutral-800 bg-white"
          />
        </figure>
      );

    default: {
      const _exhaustive: never = widget;
      void _exhaustive;
      return null;
    }
  }
}
