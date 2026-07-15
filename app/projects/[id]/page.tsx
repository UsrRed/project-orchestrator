import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { getProjectTree } from "@/lib/projects";
import { getCurrentUserId } from "@/lib/users";
import {
  addPhaseAction,
  addTaskAction,
  deletePhaseAction,
  deleteProjectAction,
  deleteTaskAction,
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
        {project.idea && (
          <p className="text-sm italic text-neutral-500">« {project.idea} »</p>
        )}
      </div>

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
