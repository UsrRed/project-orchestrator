import Link from "next/link";

import {
  canManageRepos,
  getGitHubAccess,
  listUserRepos,
} from "@/lib/github";
import { listProjects } from "@/lib/projects";
import { getProfile } from "@/lib/profile";
import { getCurrentUserId } from "@/lib/users";
import { NewProjectForm, type RepoOption } from "./new-project-form";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const userId = await getCurrentUserId();
  const [projects, profile, access] = await Promise.all([
    listProjects(userId),
    getProfile(userId),
    getGitHubAccess(userId),
  ]);

  // Dépôts proposés à la liaison. GitHub peut être lent ou l'accès révoqué :
  // l'échec ne doit pas casser la page, il retire juste les suggestions.
  const manages = canManageRepos(access);
  let repos: RepoOption[] = [];
  if (access && manages) {
    try {
      repos = (await listUserRepos(access.token)).map((r) => ({
        fullName: r.fullName,
        private: r.private,
      }));
    } catch {
      repos = [];
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Agent architecte
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Projets</h1>
        <p className="text-neutral-400">
          Décris une idée : l&apos;<strong>agent architecte</strong> la découpe
          en phases et tâches cohérentes, que tu peux ensuite éditer.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-4 text-lg font-semibold">Nouveau projet</h2>
        <NewProjectForm
          defaultType={profile.defaultProjectType}
          repos={repos}
          canManageRepos={manages}
          hasGitHub={access !== null}
        />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Mes projets</h2>
        {projects.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => {
              const pct =
                p.taskCount > 0
                  ? Math.round((p.doneTaskCount / p.taskCount) * 100)
                  : 0;
              return (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/30 px-4 py-3 transition hover:border-neutral-700 hover:bg-neutral-900/60"
                  >
                    <div className="flex items-center gap-3">
                      <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs uppercase text-emerald-400">
                        {p.type}
                      </span>
                      <span className="font-medium text-neutral-100">
                        {p.name}
                      </span>
                      <span
                        className="rounded border border-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-400"
                        title={
                          p.repo.mode === "github"
                            ? `${p.repo.fullName} (${p.repo.private ? "privé" : "public"})`
                            : "Projet local, aucun dépôt lié"
                        }
                      >
                        {p.repo.mode === "github"
                          ? `${p.repo.private ? "🔒" : "🌐"} ${p.repo.fullName}`
                          : "local"}
                      </span>
                      <span className="ml-auto text-xs text-neutral-500">
                        {p.doneTaskCount}/{p.taskCount} tâches · {p.phaseCount}{" "}
                        phases
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-9 text-right text-[11px] text-neutral-500">
                        {pct}%
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
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
