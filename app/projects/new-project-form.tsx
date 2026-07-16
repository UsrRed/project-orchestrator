"use client";

import { useActionState, useState } from "react";

import { generateProjectAction, type GenerateState } from "./actions";

const INITIAL: GenerateState = { ok: false, message: "" };

/** Rattachement Git proposé à la création (cf. `resolveRepoChoice` côté serveur). */
type RepoChoice = "link" | "create" | "local";

export interface RepoOption {
  fullName: string;
  private: boolean;
}

export function NewProjectForm({
  defaultType = "tech",
  repos = [],
  canManageRepos = false,
  hasGitHub = false,
}: {
  defaultType?: "tech" | "marketing";
  /** Dépôts de l'utilisateur (vide si accès GitHub absent ou insuffisant). */
  repos?: RepoOption[];
  /** L'accès GitHub couvre-t-il la liste / la création de dépôts ? */
  canManageRepos?: boolean;
  /** Un compte GitHub est-il lié ? */
  hasGitHub?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    generateProjectAction,
    INITIAL,
  );
  const [choice, setChoice] = useState<RepoChoice>("local");

  const choices: Array<{ id: RepoChoice; label: string; hint: string }> = [
    {
      id: "link",
      label: "Lier un dépôt existant",
      hint: "le projet pointe vers un dépôt que tu as déjà",
    },
    {
      id: "create",
      label: "Créer un dépôt",
      hint: "nouveau dépôt sur ton compte GitHub, privé par défaut",
    },
    {
      id: "local",
      label: "Local seulement",
      hint: "aucun dépôt, le projet vit uniquement ici",
    },
  ];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Ton idée de projet</span>
        <textarea
          name="idea"
          rows={3}
          required
          placeholder="Ex: une app mobile de suivi d'habitudes avec rappels intelligents…"
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Type de projet</span>
        <select
          name="type"
          defaultValue={defaultType}
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
        >
          <option value="tech">Tech / logiciel</option>
          <option value="marketing">Marketing</option>
        </select>
      </label>

      <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
        <legend className="px-1 text-sm text-neutral-400">Dépôt Git</legend>

        <div className="flex flex-col gap-1.5">
          {choices.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="repoChoice"
                value={c.id}
                checked={choice === c.id}
                onChange={() => setChoice(c.id)}
                className="mt-1 accent-emerald-500"
              />
              <span>
                <span className="text-neutral-200">{c.label}</span>{" "}
                <span className="text-xs text-neutral-500">— {c.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {choice === "link" && (
          <div className="flex flex-col gap-1">
            <input
              name="repoInput"
              required
              list={repos.length > 0 ? "repo-options" : undefined}
              placeholder="https://github.com/moi/mon-depot ou moi/mon-depot"
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
            {repos.length > 0 && (
              <datalist id="repo-options">
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.private ? "privé" : "public"}
                  </option>
                ))}
              </datalist>
            )}
            <span className="text-xs text-neutral-500">
              {repos.length > 0
                ? `${repos.length} dépôts de ton compte GitHub proposés à la saisie — ou colle n'importe quelle URL.`
                : "Colle l'URL du dépôt."}
            </span>
          </div>
        )}

        {choice === "create" && (
          <div className="flex flex-col gap-2">
            <input
              name="repoName"
              placeholder="nom-du-depot (par défaut : dérivé de ton idée)"
              className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-400">Visibilité</span>
              <select
                name="repoVisibility"
                defaultValue="private"
                className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-emerald-500"
              >
                <option value="private">Privé (recommandé)</option>
                <option value="public">Public</option>
              </select>
            </label>
            <span className="text-xs text-neutral-500">
              Le dépôt est créé sur ton compte GitHub au moment de la génération.
            </span>
          </div>
        )}

        {choice !== "local" && !canManageRepos && (
          <p className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/80">
            {hasGitHub
              ? "Ton accès GitHub ne couvre pas encore les dépôts : déconnecte-toi puis reconnecte-toi pour l'accorder. En attendant, seul le lien par URL fonctionne."
              : "Aucun compte GitHub lié : seul le lien par URL fonctionne."}
          </p>
        )}
      </fieldset>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
      >
        {pending ? "L'architecte réfléchit…" : "Générer l'arborescence"}
      </button>

      {state.message && !state.ok && (
        <p className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-sm text-red-200">
          {state.message}
        </p>
      )}
    </form>
  );
}
