import Link from "next/link";

import {
  fetchLocalModels,
  listCatalogModels,
} from "@/lib/model-catalog";
import { findModel } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const localModels = await fetchLocalModels();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Accueil
        </Link>
        <h1 className="text-4xl font-bold tracking-tight">Modèles disponibles</h1>
        <p className="text-sm text-neutral-400">
          Catalogue complet issu de <strong>models.dev</strong> (coûts USD / 1M
          tokens). Le routeur sélectionne par tier :{" "}
          <span className="text-emerald-400">fast</span> = le moins cher,{" "}
          <span className="text-emerald-400">frontier</span> = le plus haut de
          gamme.
        </p>
      </header>

      {PROVIDERS.map((p) => {
        const models =
          p.id === "ollama"
            ? localModels.map((id) => ({
                id,
                name: id,
                input: 0,
                output: 0,
                context: 0,
              }))
            : listCatalogModels(p.id);
        const fast = findModel(p.id, "fast");
        const frontier = findModel(p.id, "frontier");

        return (
          <details
            key={p.id}
            className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
          >
            <summary className="cursor-pointer text-sm font-semibold text-neutral-200">
              {p.label}{" "}
              <span className="text-neutral-500">— {models.length} modèles</span>
            </summary>

            {p.id !== "ollama" && (fast || frontier) && (
              <p className="mt-2 text-xs text-neutral-500">
                Routage : fast → <code>{fast?.modelId}</code> · frontier →{" "}
                <code>{frontier?.modelId}</code>
              </p>
            )}

            {models.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="text-neutral-500">
                    <tr className="border-b border-neutral-800">
                      <th className="py-1 pr-3 font-medium">Modèle</th>
                      <th className="py-1 pr-3 font-medium">$ in / out (1M)</th>
                      <th className="py-1 font-medium">Contexte</th>
                    </tr>
                  </thead>
                  <tbody className="text-neutral-300">
                    {models.map((m) => (
                      <tr key={m.id} className="border-b border-neutral-900">
                        <td className="py-1 pr-3 font-mono">{m.id}</td>
                        <td className="py-1 pr-3">
                          {p.id === "ollama"
                            ? "local (gratuit)"
                            : `$${m.input} / $${m.output}`}
                        </td>
                        <td className="py-1 text-neutral-500">
                          {m.context ? `${(m.context / 1000).toFixed(0)}k` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-xs text-neutral-500">
                {p.id === "ollama"
                  ? "Serveur local injoignable ou aucun modèle chargé."
                  : "Aucun modèle."}
              </p>
            )}
          </details>
        );
      })}
    </main>
  );
}
