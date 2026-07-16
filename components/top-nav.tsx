import Link from "next/link";

import { UserMenu } from "@/components/user-menu";

const LINKS: Array<{ href: string; label: string }> = [
  { href: "/projects", label: "Projets" },
  { href: "/normes", label: "Normes" },
  { href: "/models", label: "Modèles" },
  { href: "/health", label: "Santé" },
  { href: "/profile", label: "Profil" },
];

/** Barre de navigation partagée (toutes les pages via le layout racine). */
export function TopNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
        <Link
          href="/"
          className="text-sm font-bold tracking-tight text-neutral-100"
        >
          Orchestrato<span className="text-emerald-400">.AI</span>
        </Link>
        <div className="flex items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded px-2 py-1 text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </nav>
    </header>
  );
}
