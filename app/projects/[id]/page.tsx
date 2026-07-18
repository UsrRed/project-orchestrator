import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { BudgetPanel } from "@/components/budget-panel";
import { RefineForm } from "@/components/refine-form";
import { getProjectTree } from "@/lib/projects";
import { getBudgetStatus } from "@/lib/budgets";
import { listNormesForProject, listPhaseNormes } from "@/lib/normes";
import { getCurrentUserId } from "@/lib/users";
import {
  addPhaseAction,
  addTaskAction,
  associateNormeAction,
  deletePhaseAction,
  deleteProjectAction,
  deleteTaskAction,
  dissociateNormeAction,
  renameProjectAction,
  updatePhaseAction,
  updateTaskAction,
} from "../actions";

export const dynamic = "force-dynamic";

const TASK_STATUS = [
  { value: "todo", label: "À faire" },
  { value: "in_progress", label: "En cours" },
  { value: "blocked", label: "Bloquée" },
  { value: "done", label: "Terminée" },
];
const TASK_MODE = [
  { value: "manual", label: "Manuel" },
  { value: "cowork", label: "Cowork" },
  { value: "autonomous", label: "Autonome" },
];
const PRIORITY = [
  { value: "0", label: "P0" },
  { value: "1", label: "P1" },
  { value: "2", label: "P2" },
  { value: "3", label: "P3" },
];
const PHASE_STATUS = [
  { value: "pending", label: "En attente" },
  { value: "in_progress", label: "En cours" },
  { value: "done", label: "Terminée" },
];

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const project = await getProjectTree(userId, id);
  if (!project) notFound();

  const budget = await getBudgetStatus(userId, id);

  // Normes disponibles + normes associées par phase (M5).
  const availableNormes = await listNormesForProject(userId, id);
  const phaseNormes = new Map(
    await Promise.all(
      project.phases.map(
        async (p) =>
          [p.id, await listPhaseNormes(userId, p.id)] as const,
      ),
    ),
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <Link
          href="/projects"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← Projets
        </Link>
        <div className="flex items-start justify-between gap-4">
          <form
            action={renameProjectAction}
            className="flex flex-1 items-center gap-2"
          >
            <input type="hidden" name="projectId" value={project.id} />
            <input
              name="name"
              defaultValue={project.name}
              className="flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-bold tracking-tight text-neutral-100 outline-none hover:border-neutral-800 focus:border-emerald-500"
            />
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs uppercase text-emerald-400">
              {project.type}
            </span>
          </form>
          <div className="flex shrink-0 items-center gap-1">
            <Link
              href={`/projects/${project.id}/files`}
              className="rounded px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800"
            >
              📁 Dossier du projet
            </Link>
            <form action={deleteProjectAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <button
                type="submit"
                className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
              >
                Supprimer le projet
              </button>
            </form>
          </div>
        </div>
        {project.idea && (
          <p className="text-sm italic text-neutral-500">« {project.idea} »</p>
        )}
      </div>

      <BudgetPanel projectId={project.id} status={budget} />

      {(() => {
        const all = project.phases.flatMap((p) => p.tasks);
        const done = all.filter((t) => t.status === "done").length;
        const pct = all.length > 0 ? Math.round((done / all.length) * 100) : 0;
        return (
          <div className="flex items-center gap-3 text-xs text-neutral-500">
            <span>Progression</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-neutral-400">
              {done}/{all.length} · {pct}%
            </span>
          </div>
        );
      })()}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <h2 className="mb-2 text-sm font-semibold text-neutral-200">
          Affiner avec l&apos;architecte
        </h2>
        <RefineForm projectId={project.id} />
      </section>

      <div className="flex flex-col gap-5">
        {project.phases.map((phase) => (
          <section
            key={phase.id}
            className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5"
          >
            <div className="mb-3 flex items-center gap-3">
              <form action={updatePhaseAction} className="flex-1">
                <input type="hidden" name="phaseId" value={phase.id} />
                <input type="hidden" name="projectId" value={project.id} />
                <input
                  name="name"
                  defaultValue={phase.name}
                  className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-semibold text-neutral-100 outline-none hover:border-neutral-800 focus:border-emerald-500"
                />
              </form>
              {phase.type && (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400">
                  {phase.type}
                </span>
              )}
              <form action={updatePhaseAction}>
                <input type="hidden" name="phaseId" value={phase.id} />
                <input type="hidden" name="projectId" value={project.id} />
                <AutoSubmitSelect
                  name="status"
                  defaultValue={phase.status}
                  options={PHASE_STATUS}
                  title="Statut de la phase"
                />
              </form>
              <form action={deletePhaseAction}>
                <input type="hidden" name="phaseId" value={phase.id} />
                <input type="hidden" name="projectId" value={project.id} />
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                  title="Supprimer la phase"
                >
                  ✕
                </button>
              </form>
            </div>

            {/* Normes de la phase (M5) — injectées en préprompt */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-neutral-600">
                Normes
              </span>
              {(phaseNormes.get(phase.id) ?? []).map((n) => (
                <span
                  key={n.id}
                  className="flex items-center gap-1 rounded-full border border-emerald-900/60 bg-emerald-950/20 px-2 py-0.5 text-xs text-emerald-300"
                  title={n.autoApplied ? "Associée automatiquement" : "Associée manuellement"}
                >
                  {n.autoApplied && <span title="auto">⚙️</span>}
                  {n.name}
                  <form action={dissociateNormeAction} className="inline">
                    <input type="hidden" name="phaseId" value={phase.id} />
                    <input type="hidden" name="normeId" value={n.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <button
                      type="submit"
                      className="text-emerald-500/70 hover:text-red-400"
                      title="Détacher"
                    >
                      ×
                    </button>
                  </form>
                </span>
              ))}
              {availableNormes.length > 0 && (
                <form action={associateNormeAction} className="inline">
                  <input type="hidden" name="phaseId" value={phase.id} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <AutoSubmitSelect
                    name="normeId"
                    defaultValue=""
                    title="Associer une norme"
                    options={[
                      { value: "", label: "+ associer une norme…" },
                      ...availableNormes.map((n) => ({
                        value: n.id,
                        label: n.name,
                      })),
                    ]}
                  />
                </form>
              )}
            </div>

            <ul className="flex flex-col gap-2">
              {phase.tasks.map((task) => (
                <li
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
                >
                  <form action={updateTaskAction} className="min-w-[180px] flex-1">
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <input
                      name="title"
                      defaultValue={task.title}
                      title={task.description ?? undefined}
                      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-neutral-200 outline-none hover:border-neutral-800 focus:border-emerald-500"
                    />
                  </form>
                  <form action={updateTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <AutoSubmitSelect
                      name="priority"
                      defaultValue={String(task.priority)}
                      options={PRIORITY}
                      title="Priorité"
                    />
                  </form>
                  <form action={updateTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <AutoSubmitSelect
                      name="mode"
                      defaultValue={task.mode}
                      options={TASK_MODE}
                      title="Mode d'exécution"
                    />
                  </form>
                  <form action={updateTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <AutoSubmitSelect
                      name="status"
                      defaultValue={task.status}
                      options={TASK_STATUS}
                      title="Statut"
                    />
                  </form>
                  <Link
                    href={`/tasks/${task.id}`}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
                    title="Ouvrir la discussion (Manuel / Cowork)"
                  >
                    Discuter →
                  </Link>
                  <form action={deleteTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <button
                      type="submit"
                      className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                      title="Supprimer la tâche"
                    >
                      ✕
                    </button>
                  </form>
                </li>
              ))}
            </ul>

            <form
              action={addTaskAction}
              className="mt-3 flex items-center gap-2"
            >
              <input type="hidden" name="phaseId" value={phase.id} />
              <input type="hidden" name="projectId" value={project.id} />
              <input
                name="title"
                placeholder="+ Ajouter une tâche"
                className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
              >
                Ajouter
              </button>
            </form>
          </section>
        ))}
      </div>

      <form
        action={addPhaseAction}
        className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-800 p-4"
      >
        <input type="hidden" name="projectId" value={project.id} />
        <input
          name="name"
          placeholder="+ Ajouter une phase"
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
        >
          Ajouter la phase
        </button>
      </form>
    </main>
  );
}
