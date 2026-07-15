/**
 * Rendu whitelisté des widgets « generative UI » (Milestone 6).
 *
 * Ne rend QUE des types de widgets connus, à partir de données déjà validées
 * par `parseWidget` (schéma Zod). Aucun HTML brut, aucun `dangerouslySetInnerHTML`,
 * aucune exécution de code fourni par le modèle → pas de surface XSS.
 */
import { parseWidget, type Widget } from "@/lib/widgets";

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

    default: {
      const _exhaustive: never = widget;
      void _exhaustive;
      return null;
    }
  }
}
