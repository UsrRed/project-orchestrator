import Link from "next/link";

import {
  assessLevel,
  LEVEL_HINT,
  LEVEL_LABEL,
  type IntelligenceLevel,
} from "@/lib/intelligence";
import {
  fetchLocalModels,
  isFreeModel,
  listCatalogModels,
} from "@/lib/model-catalog";
import {
  findFreeModel,
  findModel,
  LOCAL_MODEL_LEVEL,
  TIER_MIN_LEVEL,
} from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";

export const dynamic = "force-dynamic";

const LEVEL_STYLE: Record<IntelligenceLevel, string> = {
  0: "bg-neutral-800 text-neutral-400",
  1: "bg-sky-950/60 text-sky-300",
  2: "bg-emerald-950/60 text-emerald-300",
  3: "bg-amber-950/60 text-amber-300",
  4: "bg-fuchsia-950/60 text-fuchsia-300",
};

function LevelBadge({
  level,
  source,
}: {
  level: IntelligenceLevel;
  source?: "family" | "derived";
}) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${LEVEL_STYLE[level]}`}
      // Un niveau estimé ne doit pas passer pour une mesure.
      title={`${LEVEL_HINT[level]}${
        source === "derived" ? " (estimé d'après prix/capacités)" : ""
      }`}
    >
      {level} {LEVEL_LABEL[level]}
      {source === "derived" && <span className="opacity-60"> ~</span>}
    </span>
  );
}

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
          Catalogue issu de <strong>models.dev</strong> (coûts USD / 1M tokens),
          filtré de ce qui n&apos;est pas routable : modèles retirés, non
          textuels (image/audio), embeddings.
        </p>
        <p className="text-sm text-neutral-400">
          Chaque modèle porte un <strong>niveau d&apos;intelligence</strong>. Le
          routeur prend le <strong>moins cher qui atteint le niveau requis</strong>{" "}
          par la tâche (<span className="text-emerald-400">fast</span> ≥{" "}
          {TIER_MIN_LEVEL.fast}, <span className="text-emerald-400">frontier</span>{" "}
          ≥ {TIER_MIN_LEVEL.frontier}), en essayant d&apos;abord les modèles à
          0 $. En mode <strong>boost</strong>, il prend le plus capable au lieu du
          moins cher.
        </p>
        <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-500">
          models.dev ne publie <strong>aucun score de capacité</strong> : ces
          niveaux sont <strong>estimés</strong> ici — par famille de modèles
          quand elle est connue, sinon déduits du prix, du raisonnement, du
          contexte et de l&apos;âge. Un{" "}
          <span className="font-mono">~</span> signale une estimation déduite.
        </p>
        <div className="flex flex-wrap gap-2">
          {([0, 1, 2, 3, 4] as IntelligenceLevel[]).map((l) => (
            <LevelBadge key={l} level={l} />
          ))}
        </div>
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
                free: true,
                // Le modèle local est inconnaissable : c'est celui que
                // l'utilisateur a chargé (cf. LOCAL_AI_LEVEL).
                level: LOCAL_MODEL_LEVEL,
                source: "derived" as const,
              }))
            : listCatalogModels(p.id).map((m) => {
                const a = assessLevel(m);
                return {
                  ...m,
                  free: isFreeModel(m),
                  level: a.level,
                  source: a.source,
                };
              });
        // Le routeur essaie le gratuit avant le payant → on montre les deux.
        const fast = findFreeModel(p.id, "fast") ?? findModel(p.id, "fast");
        const frontier =
          findFreeModel(p.id, "frontier") ?? findModel(p.id, "frontier");
        // En boost, la capacité prime sur la gratuité (cf. selectModelChain) :
        // afficher le gratuit d'abord ici mentirait sur le choix réel.
        const boostFree = findFreeModel(p.id, "frontier", { boost: true });
        const boostPaid = findModel(p.id, "frontier", { boost: true });
        const boost =
          (boostFree?.level ?? -1) >= (boostPaid?.level ?? -1)
            ? (boostFree ?? boostPaid)
            : boostPaid;
        const freeCount = models.filter((m) => m.free).length;

        return (
          <details
            key={p.id}
            className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
          >
            <summary className="cursor-pointer text-sm font-semibold text-neutral-200">
              {p.label}{" "}
              <span className="text-neutral-500">— {models.length} modèles</span>
              {freeCount > 0 && (
                <span className="text-emerald-400"> · {freeCount} gratuits</span>
              )}
            </summary>

            {p.id !== "ollama" && (
              <p className="mt-2 text-xs text-neutral-500">
                Routage : fast →{" "}
                <code>{fast?.modelId ?? "aucun modèle assez capable"}</code> ·
                frontier →{" "}
                <code>{frontier?.modelId ?? "aucun modèle assez capable"}</code>{" "}
                · boost → <code>{boost?.modelId ?? "—"}</code>
              </p>
            )}

            {models.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-xs">
                  <thead className="text-neutral-500">
                    <tr className="border-b border-neutral-800">
                      <th className="py-1 pr-3 font-medium">Modèle</th>
                      <th className="py-1 pr-3 font-medium">Intelligence</th>
                      <th className="py-1 pr-3 font-medium">$ in / out (1M)</th>
                      <th className="py-1 font-medium">Contexte</th>
                    </tr>
                  </thead>
                  <tbody className="text-neutral-300">
                    {models.map((m) => (
                      <tr key={m.id} className="border-b border-neutral-900">
                        <td className="py-1 pr-3 font-mono">
                          {m.id}
                          {m.free && p.id !== "ollama" && (
                            <span className="ml-2 rounded bg-emerald-950/60 px-1.5 py-0.5 font-sans text-[10px] text-emerald-400">
                              gratuit
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-3">
                          <LevelBadge level={m.level} source={m.source} />
                        </td>
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
