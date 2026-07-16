import Link from "next/link";

import { signIn } from "@/auth";
import { isGitHubConfigured } from "@/auth.config";

export default function SignInPage() {
  const githubReady = isGitHubConfigured();
  const devOpen =
    process.env.ALLOW_DEV_USER === "true" ||
    process.env.NODE_ENV !== "production";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2 text-center">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Orchestrato.AI
        </span>
        <h1 className="text-3xl font-bold tracking-tight">Connexion</h1>
        <p className="text-sm text-neutral-400">
          Connecte-toi pour accéder à tes projets, clés et exécutions.
        </p>
      </header>

      {githubReady ? (
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-semibold text-neutral-100 transition hover:border-emerald-600 hover:bg-neutral-800"
          >
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Se connecter avec GitHub
          </button>
        </form>
      ) : (
        <div className="rounded-lg border border-amber-800 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
          <p className="font-semibold">GitHub OAuth non configuré.</p>
          <p className="mt-1 text-amber-200/80">
            Renseigne <code>AUTH_GITHUB_ID</code> et{" "}
            <code>AUTH_GITHUB_SECRET</code> dans <code>.env</code> (callback :{" "}
            <code>/api/auth/callback/github</code>), puis redémarre.
          </p>
        </div>
      )}

      {devOpen && (
        <Link
          href="/"
          className="text-center text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
        >
          Continuer en mode développement (utilisateur local) →
        </Link>
      )}
    </main>
  );
}
