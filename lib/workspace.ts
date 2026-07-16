/**
 * Workspaces disque des projets (moteur `cli` du mode Autonome).
 *
 * Jusqu'ici, rattacher un projet à un dépôt GitHub ne stockait qu'une URL :
 * personne ne clonait. Un agent CLI a besoin d'un `cwd` réel — c'est ce que
 * fournit ce module, à raison d'**un workspace par projet**, réutilisé d'un run
 * à l'autre.
 *
 * Le jeton GitHub réutilisé est celui de la connexion Auth.js de l'utilisateur
 * (cf. [github.ts](github.ts)) : aucun secret supplémentaire à lui demander.
 */
import "server-only";

import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getGitHubAccess } from "@/lib/github";
import { getProjectRepo, type ProjectRepo } from "@/lib/projects";
import { runProcess } from "@/lib/process";

/** Un clone peut être long (gros dépôt, réseau lent) sans être bloqué. */
const GIT_TIMEOUT_MS = 120_000;
/** Les commandes de lecture (status/diff) doivent répondre tout de suite. */
const GIT_READ_TIMEOUT_MS = 15_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Racine des workspaces (hors dépôt de l'app par défaut : `.workspaces/`). */
export function workspacesRoot(): string {
  const configured = process.env.WORKSPACES_DIR;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(configured);
  }
  return join(process.cwd(), ".workspaces");
}

/**
 * Chemin du workspace d'un projet. L'identifiant doit être un UUID : c'est ce
 * qui garantit qu'aucune valeur venue de la base ne peut sortir de la racine
 * (`..`, chemin absolu…).
 */
export function workspacePathFor(projectId: string): string {
  if (!UUID_RE.test(projectId)) {
    throw new Error(`Identifiant de projet invalide : « ${projectId} ».`);
  }
  return join(workspacesRoot(), projectId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Lance une commande git et jette un message lisible si elle échoue. */
async function git(
  args: string[],
  cwd: string,
  timeoutMs = GIT_READ_TIMEOUT_MS,
): Promise<string> {
  const r = await runProcess({ bin: "git", args, cwd, timeoutMs });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 500);
    throw new Error(`git ${args[0]} a échoué : ${detail || `code ${r.code}`}`);
  }
  return r.stdout;
}

export interface Workspace {
  path: string;
  repo: ProjectRepo;
  /** false → le workspace existait déjà et a été réutilisé tel quel. */
  created: boolean;
}

/**
 * Garantit que le workspace est la **racine** de son propre dépôt git.
 *
 * Garde-fou central, et pas théorique : un dossier nu placé sous
 * `.workspaces/` reste *à l'intérieur* du dépôt de l'app, et git remonte alors
 * jusqu'à celui-ci. L'agent croit travailler dans le projet de l'utilisateur
 * alors que son `git` pilote le dépôt de l'orchestrateur — un `git commit -a`
 * y commiterait le code de l'app. Un dépôt à la racine du workspace rend la
 * frontière opaque au parent.
 */
async function assertIsRepoRoot(path: string): Promise<void> {
  const top = (
    await runProcess({
      bin: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: path,
      timeoutMs: GIT_READ_TIMEOUT_MS,
    })
  ).stdout.trim();

  const expected = await realpath(path);
  if (!top || (await realpath(top)) !== expected) {
    throw new Error(
      `Workspace ${path} n'est pas la racine d'un dépôt git (git remonte à « ${top || "?"} ») : ` +
        "l'agent travaillerait dans le mauvais dépôt.",
    );
  }
}

/**
 * Garantit l'existence du workspace d'un projet et renvoie son chemin.
 *
 * Un workspace déjà présent est réutilisé **sans être touché** : ni `fetch`, ni
 * `reset`. Un `reset --hard` détruirait le travail non encore relu d'un run
 * précédent ; remettre le clone à niveau est une décision de l'utilisateur, pas
 * un effet de bord de la mise en file d'un run.
 */
export async function ensureWorkspace(
  userId: string,
  projectId: string,
): Promise<Workspace> {
  const repo = await getProjectRepo(userId, projectId);
  if (!repo) throw new Error("Projet introuvable pour ce workspace.");

  const path = workspacePathFor(projectId);
  if (await exists(path)) {
    await assertIsRepoRoot(path);
    return { path, repo, created: false };
  }

  const root = workspacesRoot();
  await mkdir(root, { recursive: true });

  // `local` = aucun dépôt rattaché (et non « dépôt cloné localement ») :
  // l'agent part d'un dossier vide — mais versionné, cf. `assertIsRepoRoot`.
  if (repo.mode === "local" || !repo.fullName) {
    await mkdir(path, { recursive: true });
    await git(["init", "-q"], path);
    await assertIsRepoRoot(path);
    return { path, repo, created: true };
  }

  const access = await getGitHubAccess(userId);
  if (!access) {
    throw new Error(
      "Aucun jeton GitHub : reconnecte-toi pour cloner le dépôt du projet.",
    );
  }

  // Le jeton transite par l'argv de `git clone` (visible en `ps` le temps du
  // clone) : acceptable en mono-utilisateur, à revoir si l'app devient
  // multi-tenant. Il est en revanche retiré de la config juste après, pour
  // qu'il ne dorme pas en clair dans .git/config.
  const authUrl = `https://x-access-token:${access.token}@github.com/${repo.fullName}.git`;
  await git(["clone", "--depth", "1", authUrl, path], root, GIT_TIMEOUT_MS);
  await git(
    ["remote", "set-url", "origin", `https://github.com/${repo.fullName}`],
    path,
  );
  await assertIsRepoRoot(path);

  return { path, repo, created: true };
}

/**
 * Résumé Markdown de ce que l'agent a changé dans le workspace, ou null si git
 * est inutilisable (le workspace est toujours un dépôt, cf. `assertIsRepoRoot`).
 *
 * `git status --short` est indispensable ici : `git diff --stat` seul **ignore
 * les fichiers non suivis**, or un agent qui crée des fichiers ne produirait
 * alors aucune trace visible.
 */
export async function workspaceChanges(path: string): Promise<string | null> {
  try {
    const status = (await git(["status", "--short"], path)).trim();
    if (!status) return "_Aucun changement dans le workspace._";

    const diffstat = (await git(["diff", "--stat"], path)).trim();
    return [
      "```",
      status,
      "```",
      ...(diffstat ? ["", "```", diffstat, "```"] : []),
    ].join("\n");
  } catch {
    // Pas un dépôt git, ou git absent : l'artefact reste utile sans ça.
    return null;
  }
}
