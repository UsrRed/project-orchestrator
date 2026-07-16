import { headers } from "next/headers";
import Link from "next/link";

import { getGitHubClientIdMasked } from "@/lib/oauth-config";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const callbackUrl = `${origin}/api/auth/callback/github`;

  const params = new URLSearchParams();
  params.set("oauth_application[name]", "Orchestrato.AI");
  params.set("oauth_application[url]", origin);
  params.set("oauth_application[callback_url]", callbackUrl);
  const githubNewAppUrl = `https://github.com/settings/applications/new?${params.toString()}`;

  const configuredId = await getGitHubClientIdMasked();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Configuration OAuth
        </span>
        <h1 className="text-3xl font-bold tracking-tight">
          Connexion GitHub en 2 étapes
        </h1>
        <p className="text-sm text-neutral-400">
          Pas besoin de toucher au <code>.env</code> : renseigne l&apos;OAuth App
          ici, le secret est stocké chiffré et le login GitHub s&apos;active
          aussitôt.
        </p>
      </header>

      {configuredId && (
        <p className="rounded-lg border border-emerald-800 bg-emerald-950/20 px-4 py-2 text-sm text-emerald-200">
          ✓ Déjà configuré — client ID <code>{configuredId}</code>. Tu peux le
          remplacer ci-dessous.
        </p>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="text-lg font-semibold">1. Créer l&apos;app GitHub</h2>
        <p className="text-sm text-neutral-400">
          Le lien ci-dessous ouvre le formulaire GitHub{" "}
          <strong>déjà pré-rempli</strong> (nom, homepage et surtout l&apos;URL
          de callback). Il ne te reste qu&apos;à cliquer{" "}
          <em>« Register application »</em>, puis{" "}
          <em>« Generate a new client secret »</em>.
        </p>
        <a
          href={githubNewAppUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-semibold text-neutral-100 transition hover:border-emerald-600 hover:bg-neutral-800"
        >
          <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Créer l&apos;OAuth App GitHub (pré-rempli) →
        </a>
        <p className="text-xs text-neutral-500">
          URL de callback attendue :{" "}
          <code className="break-all text-neutral-400">{callbackUrl}</code>
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <h2 className="text-lg font-semibold">2. Coller les identifiants</h2>
        <SetupForm />
      </section>

      <div className="flex justify-between text-xs text-neutral-500">
        <Link href="/signin" className="hover:text-neutral-300">
          → Aller à la connexion
        </Link>
        <Link href="/" className="hover:text-neutral-300">
          Accueil
        </Link>
      </div>
    </main>
  );
}
