/**
 * Accès GitHub au nom de l'utilisateur connecté (Milestone 7).
 *
 * L'utilisateur se connecte déjà via GitHub (Auth.js, cf. [auth.ts](../auth.ts)) :
 * on réutilise le jeton d'accès stocké par l'adapter Drizzle (table `accounts`)
 * pour lister ses dépôts et en créer un — sans jamais lui redemander de secret.
 *
 * Le scope `repo` n'est accordé qu'à la connexion. Un compte connecté avant
 * l'ajout de cette fonctionnalité n'a que les scopes de lecture de profil :
 * l'appelant doit vérifier `canManageRepos` et proposer une reconnexion, ou
 * retomber sur la saisie manuelle d'une URL de dépôt.
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts } from "@/drizzle/schema";

const API = "https://api.github.com";

export interface GitHubAccess {
  token: string;
  /** Scopes effectivement accordés par l'utilisateur. */
  scopes: string[];
}

export interface RepoRef {
  /** `owner/repo`. */
  fullName: string;
  url: string;
  private: boolean;
}

/** Scope requis pour lister/créer des dépôts privés. */
const REPO_SCOPE = "repo";

/** Le jeton permet-il de gérer (lister/créer) des dépôts privés ? */
export function canManageRepos(access: GitHubAccess | null): boolean {
  return access?.scopes.includes(REPO_SCOPE) ?? false;
}

/** Jeton GitHub de l'utilisateur, ou null s'il n'a pas de compte GitHub lié. */
export async function getGitHubAccess(
  userId: string,
): Promise<GitHubAccess | null> {
  const [row] = await db
    .select({ token: accounts.access_token, scope: accounts.scope })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")))
    .limit(1);

  if (!row?.token) return null;
  return {
    token: row.token,
    // GitHub sépare les scopes par virgule ; Auth.js les stocke tels quels.
    scopes: (row.scope ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // L'API renvoie un message lisible ; on le remonte tel quel à l'UI.
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    } | null;
    const detail =
      body?.errors?.map((e) => e.message).filter(Boolean).join(", ") ||
      body?.message ||
      `HTTP ${res.status}`;
    throw new Error(`GitHub : ${detail}`);
  }
  return (await res.json()) as T;
}

interface RawRepo {
  full_name: string;
  html_url: string;
  private: boolean;
}

/** Dépôts de l'utilisateur (les plus récemment actifs d'abord). */
export async function listUserRepos(token: string): Promise<RepoRef[]> {
  const raw = await gh<RawRepo[]>(
    token,
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
  );
  return raw.map((r) => ({
    fullName: r.full_name,
    url: r.html_url,
    private: r.private,
  }));
}

/**
 * Crée un dépôt sur le compte de l'utilisateur. **Privé par défaut** :
 * `isPrivate` doit être explicitement `false` pour publier.
 */
export async function createUserRepo(
  token: string,
  name: string,
  opts: { private?: boolean; description?: string } = {},
): Promise<RepoRef> {
  const raw = await gh<RawRepo>(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name,
      private: opts.private !== false,
      description: opts.description?.slice(0, 350),
      auto_init: true,
    }),
  });
  return { fullName: raw.full_name, url: raw.html_url, private: raw.private };
}

/** Le dépôt existe-t-il et est-il accessible avec ce jeton ? */
export async function getRepo(
  token: string,
  fullName: string,
): Promise<RepoRef> {
  const raw = await gh<RawRepo>(token, `/repos/${fullName}`);
  return { fullName: raw.full_name, url: raw.html_url, private: raw.private };
}

// --- Helpers purs (testables sans réseau) --------------------------------

const FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;

/**
 * Extrait `owner/repo` d'une saisie utilisateur : URL https, URL SSH, ou
 * `owner/repo` directement. Renvoie null si ce n'est pas un dépôt GitHub.
 */
export function parseRepoInput(input: string): string | null {
  // Slashes finaux d'abord : « …/depot.git/ » doit aussi perdre son .git.
  const raw = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!raw) return null;

  const ssh = raw.match(/^git@github\.com:(.+)$/);
  const https = raw.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/);
  const candidate = ssh?.[1] ?? https?.[1] ?? raw;

  return FULL_NAME_RE.test(candidate) ? candidate : null;
}

/** URL web canonique d'un `owner/repo`. */
export function repoUrlFor(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/**
 * Nom de dépôt valide dérivé d'un texte libre (nom de projet / idée).
 * GitHub n'accepte que `[A-Za-z0-9._-]`.
 */
export function slugifyRepoName(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 90);
  return slug || "projet";
}
