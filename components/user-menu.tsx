import Link from "next/link";

import { auth, signOut } from "@/auth";

/** Affiche l'utilisateur connecté + déconnexion, ou un lien de connexion. */
export async function UserMenu() {
  let session = null;
  try {
    session = await auth();
  } catch {
    // hors contexte (ne devrait pas arriver dans une page)
  }

  if (session?.user) {
    const label = session.user.name ?? session.user.email ?? "Compte";
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-neutral-400">{label}</span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button
            type="submit"
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition hover:border-red-600 hover:text-red-400"
          >
            Déconnexion
          </button>
        </form>
      </div>
    );
  }

  // Pas de session (mode développement / non connecté).
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span>mode développement</span>
      <Link
        href="/signin"
        className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 transition hover:border-emerald-600 hover:text-emerald-400"
      >
        Se connecter
      </Link>
    </div>
  );
}
