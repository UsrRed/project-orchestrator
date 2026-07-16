/**
 * Lancement de sous-processus — **unique site de `spawn` du dépôt**.
 *
 * Le reste de l'app n'exécute rien : les agents `llm` produisent des données
 * conformes à un schéma Zod, jamais du code (cf. risque #5 du plan). Le moteur
 * `cli` du mode Autonome fait exception : il lance de vrais agents de code
 * (`claude`, `gemini`, `opencode`) dans le workspace d'un projet. Toute
 * exécution passe donc par ici, pour qu'il n'y ait qu'un endroit à auditer.
 *
 * Ce n'est **pas une sandbox** : le processus hérite des droits de
 * l'utilisateur du worker. Le confinement repose sur le `cwd` (workspace du
 * projet), les modes de permission du CLI, le timeout et le kill de groupe.
 */
import "server-only";

import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Le timeout a expiré → le processus a été tué. */
  timedOut: boolean;
  /** Le signal d'annulation a été déclenché → le processus a été tué. */
  aborted: boolean;
  /** Sortie tronquée : elle a dépassé `maxOutputBytes`. */
  truncated: boolean;
}

export interface RunProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Annulation externe (kill switch, dépassement de budget). */
  signal?: AbortSignal;
  /** Environnement complet du processus (cf. `buildEnv`). */
  env?: Record<string, string>;
  /** Plafond par flux. Un agent bavard ne doit pas saturer la RAM du worker. */
  maxOutputBytes?: number;
  onStderrLine?: (line: string) => void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
/** Délai laissé au processus pour sortir sur SIGTERM avant le SIGKILL. */
const KILL_GRACE_MS = 3_000;

/**
 * Variables d'environnement transmises aux agents CLI.
 *
 * Allowlist stricte, pour une raison précise : le `.env` du worker contient des
 * clés LLM (`ANTHROPIC_API_KEY`…). Les propager ferait basculer Claude Code sur
 * la facturation à la clé au lieu de l'abonnement de l'utilisateur — soit
 * exactement ce que le moteur `cli` cherche à éviter. Tout ce qui n'est pas
 * listé ici est écarté.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

const ENV_ALLOWED_PREFIXES = ["XDG_"] as const;

/** Environnement d'un agent CLI : allowlist + surcharges explicites. */
export function buildEnv(
  overrides: Record<string, string> = {},
  // Dictionnaire simple plutôt que `NodeJS.ProcessEnv` : Next y impose un
  // `NODE_ENV` obligatoire dont cette fonction n'a que faire.
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [key, v] of Object.entries(source)) {
    if (v !== undefined && ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = v;
    }
  }
  return { ...env, ...overrides };
}

/** Accumulateur de flux borné : garde le début et compte la troncature. */
function makeSink(maxBytes: number) {
  const chunks: string[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(s: string): void {
      if (truncated) return;
      const remaining = maxBytes - size;
      if (s.length >= remaining) {
        chunks.push(s.slice(0, remaining));
        truncated = true;
      } else {
        chunks.push(s);
        size += s.length;
      }
    },
    get text(): string {
      return chunks.join("");
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

/**
 * Exécute un binaire et attend sa fin. Ne jette que si le binaire est
 * introuvable ou non exécutable — un code de sortie non nul est un résultat,
 * pas une exception (l'appelant décide).
 */
export async function runProcess(
  opts: RunProcessOptions,
): Promise<ProcessResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const out = makeSink(maxBytes);
  const err = makeSink(maxBytes);

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      // Cast : Next augmente `ProcessEnv` avec un `NODE_ENV` obligatoire, que
      // l'allowlist ne transmet volontairement pas (elle n'invente rien).
      env: (opts.env ?? buildEnv()) as NodeJS.ProcessEnv,
      // shell:false → le prompt passe en argv, jamais réinterprété par un shell.
      shell: false,
      // detached → le fils devient chef de groupe : on peut tuer TOUTE sa
      // descendance (node, git, tests qu'il lance…), pas seulement lui.
      detached: true,
      // stdin ignoré, et c'est structurant : `opencode run` attend sur stdin
      // tant qu'il reste ouvert et ne rend jamais la main (constaté :
      // 0 octet de sortie jusqu'au timeout). Les agents CLI sont pilotés par
      // argv, ils n'ont rien à lire sur stdin.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stderrBuf = "";

    /** Tue le groupe de processus : SIGTERM, puis SIGKILL si ça résiste. */
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Déjà mort, ou groupe absent : rien à faire.
      }
      setTimeout(() => {
        if (settled || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // idem
        }
      }, KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => out.push(d));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      err.push(d);
      if (!opts.onStderrLine) return;
      stderrBuf += d;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onStderrLine(line);
    });

    child.on("error", (e) => {
      cleanup();
      const msg =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? `CLI \`${opts.bin}\` introuvable sur la machine du worker (PATH).`
          : `Impossible de lancer \`${opts.bin}\` : ${e.message}`;
      reject(new Error(msg));
    });

    child.on("close", (code) => {
      cleanup();
      resolve({
        code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        aborted,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
