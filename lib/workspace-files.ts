/**
 * Lecture (seule) du workspace disque d'un projet, pour l'explorateur intégré
 * ([app/projects/[id]/files](../app/projects/%5Bid%5D/files/page.tsx)).
 *
 * C'est ce que produisent les runs autonomes : l'agent Claude Code écrit de
 * vrais fichiers dans `.workspaces/<projectId>/`. Ce module les liste et les lit
 * **sans jamais sortir de la racine du workspace** (le chemin demandé vient de
 * l'URL) : toute cible est re-résolue et doit rester sous la racine, sinon on
 * refuse. `workspacePathFor` garantit déjà que `projectId` est un UUID.
 */
import "server-only";

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { workspacePathFor } from "@/lib/workspace";

/** Dossiers jamais listés : bruit ou volumineux. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next"]);
/** Garde-fous : au-delà, on tronque (un workspace n'est pas un explorateur système). */
const MAX_ENTRIES = 4000;
const MAX_READ_BYTES = 512 * 1024;

export interface WorkspaceFile {
  /** Chemin relatif à la racine du workspace (séparateur `/`). */
  path: string;
  size: number;
}

export interface WorkspaceListing {
  exists: boolean;
  root: string;
  files: WorkspaceFile[];
  truncated: boolean;
}

/**
 * Liste (récursive, à plat) les fichiers du workspace, triés par chemin.
 * `exists:false` si aucun run n'a encore créé le workspace.
 */
export async function listWorkspaceFiles(
  projectId: string,
): Promise<WorkspaceListing> {
  const root = workspacePathFor(projectId);
  const files: WorkspaceFile[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          continue;
        }
        files.push({ path: relative(root, abs).split(sep).join("/"), size });
      }
    }
  }

  try {
    await stat(root);
  } catch {
    return { exists: false, root, files: [], truncated: false };
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { exists: true, root, files, truncated };
}

export interface WorkspaceFileContent {
  path: string;
  size: number;
  /** Contenu texte (tronqué si trop long), ou null si binaire. */
  content: string | null;
  binary: boolean;
  truncated: boolean;
}

/**
 * Lit un fichier du workspace en garantissant qu'il reste **sous la racine**.
 * Renvoie null si le chemin s'échappe, n'existe pas, ou n'est pas un fichier.
 */
export async function readWorkspaceFile(
  projectId: string,
  relPath: string,
): Promise<WorkspaceFileContent | null> {
  const root = workspacePathFor(projectId);
  // Re-résolution + confinement : la cible doit être la racine ou dessous.
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) return null;

  let info;
  try {
    info = await stat(target);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const buf = await readFile(target);
  // Détection binaire simple : un octet nul dans les 8 premiers Ko.
  const binary = buf.subarray(0, 8192).includes(0);
  const relOut = relative(root, target).split(sep).join("/");
  if (binary) {
    return { path: relOut, size: info.size, content: null, binary: true, truncated: false };
  }
  const truncated = buf.length > MAX_READ_BYTES;
  const content = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
  return { path: relOut, size: info.size, content, binary: false, truncated };
}
