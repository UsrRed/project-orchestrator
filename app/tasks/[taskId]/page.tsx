import Link from "next/link";
import { notFound } from "next/navigation";

import { AutonomousPanel } from "@/components/autonomous-panel";
import { AutoRefresh } from "@/components/auto-refresh";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { PhasePanel } from "@/components/phase-panel";
import { TaskChat } from "@/components/task-chat";
import { VisualizeButton } from "@/components/visualize-button";
import { WidgetGenerator } from "@/components/widget-generator";
import { WidgetRenderer } from "@/components/widget-renderer";
import {
  getCoworkStatus,
  getTaskContext,
  listArtifacts,
  listMessages,
  type CoworkOptionsData,
} from "@/lib/conversation";
import { listRunsForTask } from "@/lib/runs";
import { listPhaseNormes } from "@/lib/normes";
import { getCurrentUserId } from "@/lib/users";
import { setModeAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Les trois modes, décrits par ce que l'utilisateur *fait* — pas par leur nom
 * de code. Le mode pilote la page entière : chaque mode n'affiche que son propre
 * outil, au lieu d'empiler les trois et de laisser deviner lequel agit.
 */
const MODES = [
  { value: "manual", label: "Manuel" },
  { value: "cowork", label: "Cowork" },
  { value: "autonomous", label: "Autonome" },
];

const MODE_INTRO: Record<string, { title: string; detail: string }> = {
  manual: {
    title: "Tu discutes, l'agent répond.",
    detail:
      "Une conversation ordinaire : rien ne se produit sans que tu écrives. Aucun fichier n'est touché.",
  },
  cowork: {
    title: "L'agent propose, tu choisis, il produit.",
    detail:
      "Tu décris ton besoin ; l'agent s'arrête et propose des options plutôt que de foncer. Ton choix déclenche la production d'un artefact (un document), ajouté plus bas.",
  },
  autonomous: {
    title: "Tu donnes un objectif, l'agent travaille seul.",
    detail:
      "L'agent boucle en arrière-plan jusqu'à l'objectif, encadré par un plafond de dépense, un nombre d'étapes et un timeout. Tu peux l'arrêter à tout moment.",
  },
};

export default async function TaskChatPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  const userId = await getCurrentUserId();
  const ctx = await getTaskContext(userId, taskId);
  if (!ctx) notFound();

  const [messages, artifacts, cowork, runs, norms] = await Promise.all([
    listMessages(userId, taskId),
    listArtifacts(userId, taskId),
    getCoworkStatus(userId, taskId),
    listRunsForTask(userId, taskId),
    listPhaseNormes(userId, ctx.phaseId),
  ]);

  const isAutonomous = ctx.taskMode === "autonomous";
  const intro = MODE_INTRO[ctx.taskMode] ?? MODE_INTRO.manual!;

  // La partie « visualisation » (widgets) est séparée des livrables documents :
  // les widgets peuplent le tableau de bord, les documents restent dans la
  // colonne de travail.
  const widgets = artifacts.filter((a) => a.type === "widget");
  const documents = artifacts.filter((a) => a.type !== "widget");

  // Un run en cours pilote l'auto-rafraîchissement : le tableau de bord se
  // remplit tout seul pendant que l'agent travaille.
  const hasActiveRun = runs.some(
    (r) => r.status === "queued" || r.status === "running",
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <Link
          href={`/projects/${ctx.projectId}`}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← {ctx.projectName}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
              {ctx.phaseName}
            </span>
            <h1 className="text-2xl font-bold tracking-tight">
              {ctx.taskTitle}
            </h1>
            {ctx.taskDescription && (
              <p className="mt-1 text-sm text-neutral-400">
                {ctx.taskDescription}
              </p>
            )}
          </div>
          <form action={setModeAction} className="shrink-0">
            <input type="hidden" name="taskId" value={taskId} />
            <label className="flex flex-col items-end gap-1 text-xs text-neutral-500">
              Mode de travail
              <AutoSubmitSelect
                name="mode"
                defaultValue={ctx.taskMode}
                options={MODES}
                title="Mode d'exécution de la tâche"
              />
            </label>
          </form>
        </div>
      </div>

      {/* Ce que le mode courant implique, en clair : le sélecteur seul ne dit
          pas ce qui va se passer. */}
      <div
        className={`rounded-xl border px-4 py-3 ${
          isAutonomous
            ? "border-sky-900/50 bg-sky-950/20"
            : "border-neutral-800 bg-neutral-900/40"
        }`}
      >
        <p
          className={`text-sm font-medium ${
            isAutonomous ? "text-sky-200" : "text-neutral-200"
          }`}
        >
          {intro.title}
        </p>
        <p className="mt-1 text-xs text-neutral-500">{intro.detail}</p>
      </div>

      {/* Panneau adaptatif par type de phase (M6) */}
      <PhasePanel phaseName={ctx.phaseName} phaseType={ctx.phaseType} />

      {/* Normes injectées en préprompt (M5) — traçabilité */}
      {norms.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-900/40 bg-emerald-950/10 px-4 py-2 text-xs">
          <span className="uppercase tracking-wide text-emerald-500">
            Normes injectées au contexte
          </span>
          {norms.map((n) => (
            <span
              key={n.id}
              className="rounded-full border border-emerald-900/60 px-2 py-0.5 text-emerald-300"
            >
              {n.autoApplied ? "⚙️ " : ""}
              {n.name}
            </span>
          ))}
        </div>
      )}

      {/* Deux zones distinctes : « Travail » (fait avancer le projet) à gauche,
          « Tableau de bord » (met en forme les résultats) à droite. */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* --- Colonne Travail (2/3) ----------------------------------- */}
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* L'outil du mode courant, et lui seul : les trois panneaux empilés
              faisaient de cette page une devinette (« lequel agit ? »). */}
          {isAutonomous ? (
            <section className="rounded-xl border border-sky-900/50 bg-sky-950/10 p-5">
              <AutonomousPanel taskId={taskId} runs={runs} />
            </section>
          ) : (
            <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
              <TaskChat
                taskId={taskId}
                mode={ctx.taskMode}
                awaitingChoice={cowork.awaitingChoice}
                pendingOptions={cowork.pendingOptions}
              />
            </section>
          )}

          {/* Le fil : conversation en Manuel/Cowork, journal du run en Autonome. */}
          <section className="flex flex-col gap-3">
            <h2 className="text-xs uppercase tracking-wide text-neutral-500">
              {isAutonomous ? "Journal de l'agent" : "Conversation"}
            </h2>
            <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
              {messages.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  {isAutonomous
                    ? "Aucun run pour l'instant. Lance l'agent ci-dessus : ses étapes s'afficheront ici au fil de l'eau."
                    : "Rien encore — écris le premier message ci-dessus."}
                </p>
              ) : (
                messages.map((m) => <MessageBubble key={m.id} message={m} />)
              )}
            </div>
          </section>

          {/* Livrables « documents » (Markdown) : ce que l'agent a produit. */}
          {documents.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs uppercase tracking-wide text-neutral-500">
                Livrables
              </h2>
              {documents.map((a) => (
                <details
                  key={a.id}
                  className="rounded-xl border border-emerald-900/50 bg-emerald-950/10 p-4"
                >
                  <summary className="cursor-pointer font-medium text-emerald-200">
                    {a.title ?? "Artefact"}{" "}
                    <span className="text-xs text-emerald-600">({a.type})</span>
                  </summary>
                  <pre className="mt-3 whitespace-pre-wrap text-sm text-neutral-300">
                    {a.content}
                  </pre>
                </details>
              ))}
            </section>
          )}
        </div>

        {/* --- Colonne Tableau de bord (1/3) --------------------------- */}
        <aside className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Tableau de bord</h2>
            {hasActiveRun && (
              <span className="flex items-center gap-1.5 text-[11px] text-sky-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                en direct
              </span>
            )}
          </div>

          {/* Visualisation : à la demande en Manuel/Cowork, automatique en
              Autonome (le worker génère les widgets pendant le run). */}
          {isAutonomous ? (
            <p className="rounded-lg border border-sky-900/40 bg-sky-950/10 px-3 py-2 text-xs text-sky-200/80">
              En autonome, l&apos;agent met lui-même ses résultats en forme :
              les widgets apparaissent ici au fil du run.
            </p>
          ) : (
            <VisualizeButton taskId={taskId} />
          )}

          {widgets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-600">
              Aucun widget pour l&apos;instant.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {widgets.map((a) => (
                <div
                  key={a.id}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
                >
                  <WidgetRenderer raw={a.content} />
                </div>
              ))}
            </div>
          )}

          {/* Outil d'appoint : un widget ad hoc à partir d'une consigne libre. */}
          <details className="rounded-xl border border-neutral-800 bg-neutral-900/30 px-4 py-3">
            <summary className="cursor-pointer text-sm text-neutral-400 hover:text-neutral-200">
              + Générer un widget précis
            </summary>
            <p className="mb-3 mt-3 text-xs text-neutral-500">
              Le modèle remplit un <strong>schéma de données fixe</strong> (tableau,
              graphe, jauges, frise…), rendu par des composants whitelistés — jamais
              de code exécuté sur l&apos;origine de l&apos;app.
            </p>
            <WidgetGenerator taskId={taskId} />
          </details>
        </aside>
      </div>

      {/* Pendant un run actif, rafraîchit la page pour remplir journal + widgets. */}
      {hasActiveRun && <AutoRefresh />}
    </main>
  );
}

function MessageBubble({
  message,
}: {
  message: {
    role: string;
    content: string;
    kind: string;
    data: unknown;
  };
}) {
  const isUser = message.role === "user";

  if (message.kind === "cowork_options") {
    const data = message.data as CoworkOptionsData;
    return (
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-4 py-3">
        <p className="mb-2 text-xs uppercase tracking-wide text-amber-400">
          Cowork — options proposées
        </p>
        <p className="text-sm text-neutral-300">{data?.intro}</p>
        <ul className="mt-2 flex flex-col gap-1">
          {data?.options?.map((o, i) => (
            <li key={i} className="text-sm text-neutral-400">
              <span className="font-medium text-neutral-200">
                {i + 1}. {o.title}
              </span>{" "}
              — {o.detail}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      className={`max-w-[85%] rounded-lg px-4 py-2 text-sm ${
        isUser
          ? "self-end bg-emerald-900/30 text-emerald-100"
          : "self-start bg-neutral-800/60 text-neutral-200"
      } ${message.kind === "artifact" ? "italic text-emerald-300" : ""}`}
    >
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">
        {isUser ? "toi" : "agent"}
      </span>
      <span className="whitespace-pre-wrap">{message.content}</span>
    </div>
  );
}
