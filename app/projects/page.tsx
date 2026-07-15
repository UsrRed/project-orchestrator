import Link from "next/link";

import { listProjects } from "@/lib/projects";
import { getCurrentUserId } from "@/lib/users";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const userId = await getCurrentUserId();
  const projects = await listProjects(userId);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Accueil
        </Link>
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Milestone 2 — agent architecte
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Projets</h1>
        <p className="text-neutral-400">
          Décris une idée : l&apos;<strong>agent architecte</strong> la découpe
          en phases et tâches cohérentes, que tu peux ensuite éditer.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-4 text-lg font-semibold">Nouveau projet</h2>
        <NewProjectForm />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Mes projets</h2>
        {projects.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/30 px-4 py-3 transition hover:border-neutral-700 hover:bg-neutral-900/60"
                >
                  <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs uppercase text-emerald-400">
                    {p.type}
                  </span>
                  <span className="font-medium text-neutral-100">{p.name}</span>
                  <span className="ml-auto text-xs text-neutral-500">
                    {p.phaseCount} phases · {p.taskCount} tâches
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            Aucun projet. Génère ta première arborescence ci-dessus.
          </p>
        )}
      </section>
    </main>
  );
}
