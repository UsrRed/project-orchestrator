import Link from "next/link";
import { notFound } from "next/navigation";

import { AutonomousPanel } from "@/components/autonomous-panel";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { PhasePanel } from "@/components/phase-panel";
import { TaskChat } from "@/components/task-chat";
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

const MODES = [
  { value: "manual", label: "Manuel" },
  { value: "cowork", label: "Cowork" },
  { value: "autonomous", label: "Autonome (M4)" },
];

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

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-16">
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
              Mode
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

      {/* Fil de discussion */}
      <section className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        {messages.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {ctx.taskMode === "cowork"
              ? "Mode Cowork : décris ton besoin, l'agent proposera des options avant d'agir."
              : "Mode Manuel : démarre la discussion avec l'agent."}
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </section>

      {/* Composeur / choix Cowork */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
        <TaskChat
          taskId={taskId}
          mode={ctx.taskMode}
          awaitingChoice={cowork.awaitingChoice}
          pendingOptions={cowork.pendingOptions}
        />
      </section>

      {/* Mode Autonome : runs en arrière-plan */}
      <section className="rounded-xl border border-sky-900/50 bg-sky-950/10 p-5">
        <h2 className="mb-1 text-lg font-semibold text-sky-200">
          Mode Autonome (Full-Auto)
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          Lance un run en arrière-plan avec garde-fous (itérations, plafond de
          coût vérifié à chaque étape, timeout, kill switch). Exécuté par le
          worker&nbsp;: <code>npm run worker</code>.
        </p>
        <AutonomousPanel taskId={taskId} runs={runs} />
      </section>

      {/* Widgets « generative UI » (M6) */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="mb-1 text-lg font-semibold">Widget à la volée</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Le modèle produit des <strong>données structurées</strong> (schéma
          fixe), rendues par des composants whitelistés — jamais de code
          exécuté côté client.
        </p>
        <WidgetGenerator taskId={taskId} />
      </section>

      {/* Artefacts produits (documents + widgets rendus) */}
      {artifacts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Artefacts</h2>
          {artifacts.map((a) =>
            a.type === "widget" ? (
              <div
                key={a.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
              >
                <WidgetRenderer raw={a.content} />
              </div>
            ) : (
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
            ),
          )}
        </section>
      )}
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
