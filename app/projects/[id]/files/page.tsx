import Link from "next/link";
import { notFound } from "next/navigation";

import { getProjectTree } from "@/lib/projects";
import { getCurrentUserId } from "@/lib/users";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
} from "@/lib/workspace-files";

export const dynamic = "force-dynamic";

/** Taille lisible (o / Ko / Mo). */
function humanSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

export default async function ProjectFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const { id } = await params;
  const { f } = await searchParams;
  const userId = await getCurrentUserId();

  // getProjectTree renvoie null si le projet n'appartient pas à l'utilisateur :
  // c'est ce qui protège l'accès au workspace.
  const project = await getProjectTree(userId, id);
  if (!project) notFound();

  const listing = await listWorkspaceFiles(id);
  const selected = f ? await readWorkspaceFile(id, f) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <Link
          href={`/projects/${id}`}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          ← {project.name}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Dossier du projet
        </h1>
        <p className="text-sm text-neutral-500">
          Fichiers réels produits dans le workspace par les runs autonomes
          (lecture seule).
        </p>
        <code className="w-fit rounded bg-neutral-900 px-2 py-1 text-xs text-neutral-400">
          {listing.root}
        </code>
      </div>

      {!listing.exists ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-400">
          Aucun workspace pour l&apos;instant. Lance un run{" "}
          <span className="text-neutral-200">Autonome</span> sur une tâche :
          l&apos;agent y écrira de vrais fichiers, qui apparaîtront ici.
        </div>
      ) : listing.files.length === 0 ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-400">
          Le workspace existe mais ne contient encore aucun fichier.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
          {/* Liste des fichiers */}
          <nav className="flex max-h-[70vh] flex-col overflow-auto rounded-xl border border-neutral-800 bg-neutral-900/40 p-2">
            <div className="px-2 py-1 text-xs uppercase tracking-wide text-neutral-500">
              {listing.files.length} fichier(s)
              {listing.truncated && " (tronqué)"}
            </div>
            {listing.files.map((file) => {
              const active = file.path === selected?.path;
              return (
                <Link
                  key={file.path}
                  href={`/projects/${id}/files?f=${encodeURIComponent(file.path)}`}
                  className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs transition ${
                    active
                      ? "bg-emerald-950/50 text-emerald-300"
                      : "text-neutral-300 hover:bg-neutral-800"
                  }`}
                >
                  <span className="truncate font-mono">{file.path}</span>
                  <span className="shrink-0 text-neutral-600">
                    {humanSize(file.size)}
                  </span>
                </Link>
              );
            })}
          </nav>

          {/* Aperçu du fichier sélectionné */}
          <section className="min-w-0 rounded-xl border border-neutral-800 bg-neutral-900/40">
            {!f ? (
              <div className="p-6 text-sm text-neutral-500">
                Sélectionne un fichier à gauche pour voir son contenu.
              </div>
            ) : !selected ? (
              <div className="p-6 text-sm text-red-400">
                Fichier introuvable ou hors du workspace.
              </div>
            ) : (
              <div className="flex flex-col">
                <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
                  <span className="truncate font-mono text-xs text-neutral-300">
                    {selected.path}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-600">
                    {humanSize(selected.size)}
                  </span>
                </div>
                {selected.binary ? (
                  <div className="p-6 text-sm text-neutral-500">
                    Fichier binaire — aperçu indisponible.
                  </div>
                ) : (
                  <>
                    {selected.truncated && (
                      <div className="border-b border-neutral-800 bg-amber-950/30 px-4 py-1 text-xs text-amber-400">
                        Aperçu tronqué aux premiers 512 Ko.
                      </div>
                    )}
                    <pre className="max-h-[60vh] overflow-auto p-4 text-xs leading-relaxed text-neutral-200">
                      {selected.content}
                    </pre>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
