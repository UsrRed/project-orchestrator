/**
 * Installe le faux binaire `claude` ([fake-claude-bin.mjs](fake-claude-bin.mjs))
 * sur le PATH le temps d'un test, et expose de quoi le configurer et lire les
 * appels qu'il a reçus.
 *
 * Fidèle à la philosophie du test fonctionnel : tout le reste de la plateforme
 * s'exécute pour de vrai (Server Actions, worker, base, spawn réel via
 * [lib/process.ts]). Seule la sortie de `claude` est fabriquée — comme l'ancien
 * faux modèle HTTP, mais au bout du `spawn` plutôt qu'au bout du réseau.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(tmpdir(), "orchestrato-fake-claude");
const CONFIG = join(DIR, "config.json");
const CALLS = join(DIR, "calls.jsonl");
const BIN = join(DIR, "claude");

const BIN_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-claude-bin.mjs",
);

/** Ce qu'un appel a demandé — matière à assertions. */
export interface FakeClaudeCall {
  index: number;
  /** Rang parmi les appels demandant le MÊME schéma (0-based). */
  sameSchemaIndex: number;
  /** Propriétés de premier niveau du schéma demandé (vide si texte libre). */
  properties: string[];
  model: string;
  structured: boolean;
}

export interface FakeClaudeConfig {
  /** Valeurs imposées par **nom de propriété**, à n'importe quelle profondeur. */
  values?: Record<string, unknown>;
  /** Réponse des appels en texte libre (chat manuel, run autonome). */
  text?: string;
}

export interface FakeClaude {
  /** Appels reçus depuis le dernier `reset()`. */
  readonly calls: FakeClaudeCall[];
  /** Change le comportement en cours de test. */
  configure(config: FakeClaudeConfig): void;
  /** Oublie les appels enregistrés. */
  reset(): void;
  /** Retire le faux du PATH et nettoie. */
  uninstall(): void;
}

/**
 * Installe le faux `claude` et préfixe le PATH du process avec son dossier.
 * `buildEnv` recopie `PATH` depuis `process.env` (allowlist) → les process
 * spawnés voient le faux. `fileParallelism: false` rend sûre la mutation globale.
 */
export function installFakeClaude(initial: FakeClaudeConfig = {}): FakeClaude {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(initial));
  writeFileSync(CALLS, "");
  // Lien vers le script source (shebang `#!/usr/bin/env node`), rendu exécutable.
  symlinkSync(BIN_SOURCE, BIN);
  chmodSync(BIN_SOURCE, 0o755);

  const dirs = (process.env.PATH ?? "").split(delimiter);
  if (dirs[0] !== DIR) process.env.PATH = [DIR, ...dirs].join(delimiter);

  return {
    get calls(): FakeClaudeCall[] {
      let raw = "";
      try {
        raw = readFileSync(CALLS, "utf8");
      } catch {
        return [];
      }
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeClaudeCall);
    },
    configure: (config) => writeFileSync(CONFIG, JSON.stringify(config)),
    reset: () => writeFileSync(CALLS, ""),
    uninstall: () => {
      process.env.PATH = (process.env.PATH ?? "")
        .split(delimiter)
        .filter((d) => d !== DIR)
        .join(delimiter);
      rmSync(DIR, { recursive: true, force: true });
    },
  };
}
