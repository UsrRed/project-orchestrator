/**
 * Appels synchrones à Claude Code CLI (`claude -p`).
 *
 * Depuis le passage en « Claude uniquement », toute génération de l'app —
 * architecture de projet, chat manuel/cowork, widgets, dimensionnement d'un run
 * — passe par le binaire `claude` sur l'abonnement de la machine, plus par une
 * API par clé. Ce module généralise ce que faisait déjà la sonde de quota
 * ([claude-usage.ts](claude-usage.ts)) : lancer `claude -p --output-format json`
 * via l'unique site de `spawn` ([process.ts](process.ts)), avec `buildEnv()` qui
 * retire les clés API pour forcer l'abonnement, et parser la sortie avec le même
 * lecteur que le moteur `cli` ([cli-agents.ts](cli-agents.ts)).
 *
 * `claudeText` rend le texte final ; `claudeJson` rend un objet validé par un
 * schéma Zod. Contrairement à `generateObject` du Vercel AI SDK (supprimé), le
 * CLI n'offre pas de `response_format` : la conformité repose sur le prompt (on
 * y injecte le JSON Schema) puis un parsing tolérant et **un** retry de
 * réparation. Voir le README du plan pour ce tradeoff assumé.
 *
 * Module pur : il ne journalise pas (pas de dépendance DB). Les appelants
 * écrivent dans `agent_executions` via `recordClaudeExecution`
 * ([executions.ts](executions.ts)) pour que le HUD ventile les tokens.
 */
import "server-only";

import { tmpdir } from "node:os";

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  parseClaudeStdout,
  type CliModelUsage,
} from "@/lib/cli-agents";
import { runProcess, buildEnv } from "@/lib/process";

/** ~4 caractères par token (approximation rapide, sans tokenizer). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Timeout par défaut d'un appel synchrone. Généreux : `claude -p` démarre un
 * agent complet, une génération d'architecture peut prendre des dizaines de
 * secondes. Surchargeable par `opts.timeoutMs` (ex. plus court pour le chat).
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Nombre de tentatives de réparation JSON après un premier parse non conforme. */
const JSON_REPAIR_ATTEMPTS = 1;

export interface ClaudeOpts {
  /** Consigne système, passée via `--append-system-prompt`. */
  system?: string;
  /**
   * Modèle imposé (`--model`). Omis par défaut : Claude Code choisit son modèle
   * lui-même (« auto »). À ne renseigner que pour forcer un modèle rapide là où
   * la latence gêne (chat manuel).
   */
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Résultat d'un appel `claude -p`, avec sa consommation ventilée par modèle. */
export interface ClaudeCall {
  text: string;
  usage: CliModelUsage[];
  costUsd: number;
  sessionId?: string;
}

/** Lance `claude -p` et rend le texte final. Jette sur timeout ou code non nul. */
export async function claudeText(
  prompt: string,
  opts: ClaudeOpts = {},
): Promise<ClaudeCall> {
  const args = ["-p", prompt, "--output-format", "json"];
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (opts.model) args.push("--model", opts.model);

  const r = await runProcess({
    bin: "claude",
    args,
    // Hors de tout projet : un appel de génération n'a aucune raison de voir un
    // dépôt, et un workspace non « trusted » ferait échouer le démarrage du CLI.
    // Pas de `--permission-mode acceptEdits` non plus : rien à écrire ici.
    cwd: tmpdir(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // `buildEnv` retire les clés API : sinon `claude` basculerait sur la
    // facturation à la clé au lieu de rapporter/consommer l'abonnement.
    env: buildEnv(),
    signal: opts.signal,
  });

  if (r.timedOut) throw new Error("L'appel `claude -p` a expiré.");
  if (r.aborted) throw new Error("L'appel `claude -p` a été interrompu.");
  if (r.code !== 0) {
    throw new Error(
      `\`claude -p\` a échoué (code ${r.code}) : ${r.stderr.trim().slice(0, 300)}`,
    );
  }

  const outcome = parseClaudeStdout(r.stdout);
  return {
    text: outcome.text,
    usage: outcome.usage,
    costUsd: outcome.costUsd,
    sessionId: outcome.sessionId,
  };
}

/**
 * Isole un objet JSON d'un texte : retire d'éventuelles clôtures ```json et
 * ne garde que du premier `{` au dernier `}`. Rend `null` si rien d'exploitable.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * Lance `claude -p` en demandant un objet conforme à `schema`, et le valide.
 *
 * Le schéma est dérivé en JSON Schema et injecté dans le prompt. En cas de
 * sortie non conforme, on retente une fois avec les erreurs Zod (« réparation »),
 * en cumulant la consommation des tentatives. Jette après épuisement.
 */
export async function claudeJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  opts: ClaudeOpts = {},
): Promise<ClaudeCall & { value: T }> {
  const jsonSchema = JSON.stringify(
    zodToJsonSchema(schema, { target: "jsonSchema7" }),
  );

  const system =
    (opts.system ? opts.system.trim() + "\n\n" : "") +
    "Tu réponds UNIQUEMENT par un objet JSON valide conforme au schéma fourni, " +
    "sans texte autour ni bloc markdown.";

  const basePrompt =
    `${prompt}\n\n` +
    `<json_schema>\n${jsonSchema}\n</json_schema>\n\n` +
    "Réponds par le seul objet JSON conforme à ce schéma.";

  const usage: CliModelUsage[] = [];
  let costUsd = 0;
  let sessionId: string | undefined;
  let currentPrompt = basePrompt;
  let lastText = "";
  let lastError = "";

  for (let attempt = 0; attempt <= JSON_REPAIR_ATTEMPTS; attempt++) {
    const call = await claudeText(currentPrompt, { ...opts, system });
    usage.push(...call.usage);
    costUsd += call.costUsd;
    sessionId = call.sessionId ?? sessionId;
    lastText = call.text;

    const raw = extractJsonObject(call.text);
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const result = schema.safeParse(parsed);
        if (result.success) {
          return { value: result.data, text: call.text, usage, costUsd, sessionId };
        }
        lastError = result.error.issues
          .map((i) => `${i.path.join(".") || "(racine)"}: ${i.message}`)
          .join(" ; ");
      }
    } else {
      lastError = "aucun objet JSON trouvé dans la réponse.";
    }

    // Prompt de réparation pour la prochaine tentative.
    currentPrompt =
      `${basePrompt}\n\nTa réponse précédente n'était pas un JSON conforme.\n` +
      `Erreurs : ${lastError}\n` +
      `Réponse précédente :\n${lastText.slice(0, 2000)}\n\n` +
      "Renvoie UNIQUEMENT un objet JSON corrigé et conforme au schéma.";
  }

  throw new Error(
    `\`claude -p\` n'a pas produit de JSON conforme après ${
      JSON_REPAIR_ATTEMPTS + 1
    } tentative(s) : ${lastError}`,
  );
}
