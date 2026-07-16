import Link from "next/link";

import { deleteConnectionAction } from "@/app/actions";
import {
  assessLevel,
  LEVEL_HINT,
  LEVEL_LABEL,
  type IntelligenceLevel,
} from "@/lib/intelligence";
import { listConnections, type ConnectionView } from "@/lib/keys";
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
  type Provider,
} from "@/lib/models";
import { PROVIDERS, type ProviderInfo } from "@/lib/providers";
import { getCurrentUserId } from "@/lib/users";

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
  muted,
}: {
  level: IntelligenceLevel;
  source?: "family" | "derived";
  muted?: boolean;
}) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        muted ? "bg-neutral-800/60 text-neutral-500" : LEVEL_STYLE[level]
      }`}
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

interface ModelRow {
  id: string;
  input: number;
  output: number;
  context: number;
  free: boolean;
  level: IntelligenceLevel;
  source: "family" | "derived";
}

/**
 * État d'un provider du point de vue de l'utilisateur : ses modèles ne servent
 * à rien s'il n'est pas réellement joignable.
 */
interface ProviderCard {
  info: ProviderInfo;
  models: ModelRow[];
  connections: ConnectionView[];
  /** Le routeur peut-il réellement l'utiliser maintenant ? */
  reachable: boolean;
  /** Pourquoi il ne l'est pas, ou avertissement s'il l'est à moitié. */
  note: string | null;
  routing: { fast?: string; frontier?: string; boost?: string };
}

function buildRouting(id: Provider): ProviderCard["routing"] {
  const fast = findFreeModel(id, "fast") ?? findModel(id, "fast");
  const frontier = findFreeModel(id, "frontier") ?? findModel(id, "frontier");
  // En boost, la capacité prime sur la gratuité (cf. selectModelChain) :
  // afficher le gratuit d'abord ici mentirait sur le choix réel.
  const boostFree = findFreeModel(id, "frontier", { boost: true });
  const boostPaid = findModel(id, "frontier", { boost: true });
  const boost =
    (boostFree?.level ?? -1) >= (boostPaid?.level ?? -1)
      ? (boostFree ?? boostPaid)
      : boostPaid;
  return {
    fast: fast?.modelId,
    frontier: frontier?.modelId,
    boost: boost?.modelId,
  };
}

export default async function ModelsPage() {
  const userId = await getCurrentUserId();
  const [localModels, connections] = await Promise.all([
    fetchLocalModels(),
    listConnections(userId),
  ]);

  const localUp = localModels.length > 0;

  const cards: ProviderCard[] = PROVIDERS.map((info) => {
    const conns = connections.filter((c) => c.provider === info.id);
    const connected = conns.length > 0;

    if (info.id === "ollama") {
      // Deux conditions distinctes, à ne pas confondre : le serveur répond, et
      // une connexion « Local » est enregistrée (sans elle le routeur l'ignore).
      return {
        info,
        models: localModels.map((id) => ({
          id,
          input: 0,
          output: 0,
          context: 0,
          free: true,
          level: LOCAL_MODEL_LEVEL,
          source: "derived" as const,
        })),
        connections: conns,
        reachable: localUp && connected,
        note: !localUp
          ? "Serveur local injoignable (LOCAL_AI_BASE_URL) — démarre LM Studio / Ollama."
          : !connected
            ? "Serveur détecté, mais aucune connexion « Local » enregistrée : le routeur ne l'utilisera pas."
            : null,
        routing: { fast: "modèle local", frontier: "modèle local" },
      };
    }

    return {
      info,
      models: listCatalogModels(info.id).map((m) => {
        const a = assessLevel(m);
        return {
          id: m.id,
          input: m.input,
          output: m.output,
          context: m.context,
          free: isFreeModel(m),
          level: a.level,
          source: a.source,
        };
      }),
      connections: conns,
      reachable: connected,
      note: connected ? null : "Aucune credential enregistrée.",
      routing: buildRouting(info.id),
    };
  });

  const reachable = cards.filter((c) => c.reachable);
  const others = cards.filter((c) => !c.reachable);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Accueil
        </Link>
        <h1 className="text-4xl font-bold tracking-tight">Modèles</h1>
        <p className="text-sm text-neutral-400">
          Ce que le routeur peut <strong>réellement</strong> utiliser d&apos;après
          tes connexions. Catalogue{" "}
          <strong>models.dev</strong> (coûts USD / 1M tokens), filtré des modèles
          retirés, non textuels et des embeddings.
        </p>
        <p className="text-sm text-neutral-400">
          Chaque modèle porte un <strong>niveau d&apos;intelligence</strong>. Le
          routeur prend le{" "}
          <strong>moins cher qui atteint le niveau requis</strong> (
          <span className="text-emerald-400">fast</span> ≥ {TIER_MIN_LEVEL.fast},{" "}
          <span className="text-emerald-400">frontier</span> ≥{" "}
          {TIER_MIN_LEVEL.frontier}), en essayant d&apos;abord les modèles à 0 $.
          En <strong>boost</strong>, il prend le plus capable.
        </p>
        <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-500">
          models.dev ne publie <strong>aucun score de capacité</strong> : ces
          niveaux sont <strong>estimés</strong> ici — par famille de modèles quand
          elle est connue, sinon déduits du prix, du raisonnement, du contexte et
          de l&apos;âge. Un <span className="font-mono">~</span> signale une
          estimation déduite.
        </p>
        <div className="flex flex-wrap gap-2">
          {([0, 1, 2, 3, 4] as IntelligenceLevel[]).map((l) => (
            <LevelBadge key={l} level={l} />
          ))}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-200">
          Joignables{" "}
          <span className="text-neutral-500">— {reachable.length}</span>
        </h2>
        {reachable.length === 0 ? (
          <p className="rounded-xl border border-amber-900 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
            Aucun provider joignable : le routeur ne peut rien exécuter.{" "}
            <Link href="/" className="underline">
              Connecte un provider
            </Link>{" "}
            depuis l&apos;accueil.
          </p>
        ) : (
          reachable.map((c) => <ProviderBlock key={c.info.id} card={c} open />)
        )}
      </section>

      {others.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-500">
            Non connectés <span className="text-neutral-600">— {others.length}</span>
          </h2>
          <p className="text-xs text-neutral-600">
            Leurs modèles existent au catalogue mais le routeur ne peut pas les
            appeler.{" "}
            <Link href="/" className="underline hover:text-neutral-400">
              Ajouter une connexion
            </Link>
          </p>
          {others.map((c) => (
            <ProviderBlock key={c.info.id} card={c} />
          ))}
        </section>
      )}
    </main>
  );
}

function ProviderBlock({ card, open }: { card: ProviderCard; open?: boolean }) {
  const { info, models, connections, reachable, note, routing } = card;
  const freeCount = models.filter((m) => m.free).length;

  return (
    <details
      open={open}
      className={`rounded-xl border p-4 ${
        reachable
          ? "border-neutral-800 bg-neutral-900/40"
          : "border-neutral-900 bg-neutral-950/40 opacity-60"
      }`}
    >
      <summary className="cursor-pointer text-sm font-semibold text-neutral-200">
        <span className={reachable ? "" : "text-neutral-500"}>{info.label}</span>{" "}
        <span className="text-neutral-500">— {models.length} modèles</span>
        {freeCount > 0 && info.id !== "ollama" && (
          <span className="text-emerald-400"> · {freeCount} gratuits</span>
        )}
        {reachable ? (
          <span className="ml-2 rounded bg-emerald-950/60 px-1.5 py-0.5 text-[10px] text-emerald-400">
            connecté
          </span>
        ) : (
          <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
            indisponible
          </span>
        )}
      </summary>

      {note && (
        <p className="mt-2 text-xs text-amber-300/80">{note}</p>
      )}

      {connections.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 text-xs text-neutral-400"
            >
              <span className="font-mono text-neutral-500">{c.masked}</span>
              {c.label && <span className="text-neutral-600">{c.label}</span>}
              <span className="text-neutral-600">
                {c.lastUsedAt
                  ? `utilisé le ${c.lastUsedAt.toLocaleDateString("fr-FR")}`
                  : "jamais utilisé"}
              </span>
              {/* « Oublier » supprime la credential chiffrée : le provider sort
                  du routage partout, il faudra la recoller pour revenir. */}
              <form action={deleteConnectionAction}>
                <input type="hidden" name="id" value={c.id} />
                <button
                  type="submit"
                  className="rounded px-2 py-0.5 text-red-400 transition hover:bg-red-950/50"
                  title="Supprimer la credential enregistrée (irréversible)"
                >
                  Oublier
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {reachable && info.id !== "ollama" && (
        <p className="mt-2 text-xs text-neutral-500">
          Routage : fast → <code>{routing.fast ?? "aucun assez capable"}</code> ·
          frontier → <code>{routing.frontier ?? "aucun assez capable"}</code> ·
          boost → <code>{routing.boost ?? "—"}</code>
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
                    {m.free && info.id !== "ollama" && (
                      <span className="ml-2 rounded bg-emerald-950/60 px-1.5 py-0.5 font-sans text-[10px] text-emerald-400">
                        gratuit
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3">
                    <LevelBadge
                      level={m.level}
                      source={m.source}
                      muted={!reachable}
                    />
                  </td>
                  <td className="py-1 pr-3">
                    {info.id === "ollama"
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
          {info.id === "ollama"
            ? "Aucun modèle chargé (serveur injoignable ou vide)."
            : "Aucun modèle."}
        </p>
      )}
    </details>
  );
}
