import Link from "next/link";

import { listNormes } from "@/lib/normes";
import { getCurrentUserId } from "@/lib/users";
import { deleteNormeAction } from "./actions";
import { NewNormeForm } from "./new-norme-form";

export const dynamic = "force-dynamic";

export default async function NormesPage() {
  const userId = await getCurrentUserId();
  const normes = await listNormes(userId);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Accueil
        </Link>
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Milestone 5 — normes / skills
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Bibliothèque de normes</h1>
        <p className="text-neutral-400">
          Des consignes réutilisables (chartes, guides méthodo) que tu associes
          à des phases. Une norme dont la <strong>catégorie</strong> égale le
          <strong> type d&apos;une phase</strong> est associée automatiquement à
          la création d&apos;un projet, puis <strong>injectée en préprompt</strong>.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="mb-4 text-lg font-semibold">Nouvelle norme</h2>
        <NewNormeForm />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Mes normes</h2>
        {normes.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {normes.map((n) => (
              <li
                key={n.id}
                className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/30 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-neutral-100">{n.name}</span>
                  {n.category && (
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-emerald-400">
                      {n.category}
                    </span>
                  )}
                  <span className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] uppercase text-neutral-500">
                    {n.scope}
                  </span>
                  <form action={deleteNormeAction} className="ml-auto">
                    <input type="hidden" name="normeId" value={n.id} />
                    <button
                      type="submit"
                      className="rounded px-2 py-1 text-xs text-red-400 transition hover:bg-red-950/50"
                    >
                      Supprimer
                    </button>
                  </form>
                </div>
                <p className="text-sm text-neutral-400">{n.promptContent}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            Aucune norme. Crée-en une ci-dessus (ex: catégorie « design » pour
            l&apos;associer aux phases de type design).
          </p>
        )}
      </section>
    </main>
  );
}
