/**
 * Registre de l'agent CLI — désormais **Claude Code uniquement**.
 *
 * L'agent `claude` n'est pas un provider LLM : c'est un programme qui **boucle
 * déjà en interne** avec ses propres outils (lecture/écriture de fichiers, bash,
 * git) et s'authentifie avec **son propre login** (l'abonnement de la machine) —
 * l'app ne lui fournit aucune clé API. Il écrit vraiment dans son workspace :
 * c'est le but du mode Autonome.
 *
 * Ce module est **pur et client-safe** (aucun import Node) : il est importé par
 * le panneau du mode Autonome pour ses libellés. La détection de disponibilité
 * vit dans [cli-availability.ts](cli-availability.ts) (server-only), le lancement
 * dans [cli-agent.ts](cli-agent.ts), et les appels synchrones (génération, chat,
 * widgets) dans [claude-cli.ts](claude-cli.ts).
 */

/** Un seul agent depuis le passage en « Claude uniquement ». */
export type CliAgentId = "claude";

/**
 * Valeur `provider` écrite dans `agent_executions` pour un appel Claude Code
 * (moteur `cli` ou appel synchrone). Distincte d'un hypothétique provider API :
 * un run sur abonnement n'est pas un appel API facturé à la clé.
 */
export type CliExecProvider = "claude_cli";

/**
 * Consommation d'UN modèle pendant une invocation.
 *
 * Claude Code n'est pas mono-modèle : une seule invocation passe couramment par
 * plusieurs modèles (un petit pour les tâches annexes, un gros pour le
 * raisonnement). Agréger le tout masquerait justement ce qu'on cherche à voir.
 */
export interface CliModelUsage {
  /** Identifiant du modèle tel que le CLI le nomme (`claude-fable-5`…). */
  model: string;
  /**
   * Tokens d'entrée, **cache inclus** (lecture + écriture). Le champ « input »
   * brut de `claude` ne compte que le non-caché : s'y fier afficherait 2 tokens
   * là où le modèle en a réellement traité ~26 000.
   */
  inputTokens: number;
  outputTokens: number;
  /** Coût de ce modèle. 0 si le CLI ne le ventile pas par modèle. */
  costUsd: number;
}

/** Ce que l'on retient d'une invocation, quel que soit le format de sortie. */
export interface CliOutcome {
  /** Texte final de l'agent (sa réponse), jamais vide en pratique. */
  text: string;
  /** Coût réel remonté par le CLI, en USD. */
  costUsd: number;
  /** Consommation ventilée par modèle. Vide si le CLI n'expose rien d'exploitable. */
  usage: CliModelUsage[];
  /** Identifiant de session à repasser pour reprendre (itération suivante). */
  sessionId?: string;
}

export interface BuildArgsOptions {
  /** UUID du run : identifiant de session imposé → reprise déterministe. */
  runId: string;
  /** Session à reprendre (itération précédente). Absent → première invocation. */
  resumeSessionId?: string;
}

export interface CliAgentInfo {
  id: CliAgentId;
  label: string;
  /** Binaire cherché dans le PATH de la machine du worker. */
  bin: string;
  /** Le CLI remonte-t-il un coût réel ? (Claude Code : oui, `total_cost_usd`.) */
  reportsCost: boolean;
  execProvider: CliExecProvider;
  /** Renseigné quand le CLI est connu pour ne pas fonctionner en l'état. */
  knownIssue?: string;
  note?: string;
  buildArgs(prompt: string, opts: BuildArgsOptions): string[];
  parseOutcome(stdout: string): CliOutcome;
}

// --- Parsing tolérant ----------------------------------------------------

/**
 * Le CLI mêle parfois des lignes non-JSON (avertissements, bannières) au JSON
 * attendu, et une sortie tronquée (timeout, kill) reste exploitable. Ces helpers
 * ne jettent JAMAIS : un run par ailleurs réussi ne doit pas être perdu sur un
 * détail de format.
 */
function parseJsonLoose(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Repli : la dernière ligne qui parse (le récapitulatif arrive en dernier).
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Objet JSON imbriqué, ou `{}` — évite un `as` à chaque accès. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Repli de dernier recours : format non reconnu (CLI mis à jour, sortie
 * tronquée…). On rend le stdout brut, seule information disponible.
 */
function rawFallback(stdout: string): CliOutcome {
  return { text: stdout.trim(), costUsd: 0, usage: [] };
}

/** Modèle non identifiable dans la sortie du CLI. Affiché tel quel. */
export const UNKNOWN_MODEL = "(modèle inconnu)";

/** Sortie comprise, mais l'agent n'a pas conclu par un message. */
const NO_FINAL_TEXT =
  "_(l'agent n'a pas renvoyé de message final — voir les changements du workspace ci-dessous)_";

/**
 * `claude` : `modelUsage` ventile déjà tokens et coût par modèle — c'est la
 * source la plus fine, on la prend telle quelle.
 *
 * Repli sur `usage` (agrégé) quand `modelUsage` manque : le modèle est alors
 * inconnu, et le dire vaut mieux que d'attribuer les tokens au premier venu.
 */
function parseClaudeUsage(j: Record<string, unknown>): CliModelUsage[] {
  const byModel = asRecord(j.modelUsage);
  const out: CliModelUsage[] = [];

  for (const [model, raw] of Object.entries(byModel)) {
    const u = asRecord(raw);
    out.push({
      model,
      inputTokens:
        asNumber(u.inputTokens) +
        asNumber(u.cacheReadInputTokens) +
        asNumber(u.cacheCreationInputTokens),
      outputTokens: asNumber(u.outputTokens),
      costUsd: asNumber(u.costUSD),
    });
  }
  if (out.length > 0) return out;

  const u = asRecord(j.usage);
  const input =
    asNumber(u.input_tokens) +
    asNumber(u.cache_read_input_tokens) +
    asNumber(u.cache_creation_input_tokens);
  const output = asNumber(u.output_tokens);
  if (input === 0 && output === 0) return [];

  return [
    {
      model: UNKNOWN_MODEL,
      inputTokens: input,
      outputTokens: output,
      costUsd: asNumber(j.total_cost_usd),
    },
  ];
}

/**
 * Parse la sortie `--output-format json` de `claude`. Réutilisée par le moteur
 * `cli` ([cli-agent.ts](cli-agent.ts)) et par les appels synchrones
 * ([claude-cli.ts](claude-cli.ts)) : même format. Ne jette jamais.
 */
export function parseClaudeStdout(stdout: string): CliOutcome {
  const j = parseJsonLoose(stdout) as Record<string, unknown> | null;
  if (!j) return rawFallback(stdout);
  return {
    text: asString(j.result) || NO_FINAL_TEXT,
    costUsd: asNumber(j.total_cost_usd),
    usage: parseClaudeUsage(j),
    sessionId: asString(j.session_id) || undefined,
  };
}

// --- Registre ------------------------------------------------------------

/**
 * Forme d'invocation vérifiée sur le binaire réellement installé (sonde du
 * 2026-07-16), pas déduite de la documentation.
 */
export const CLI_AGENTS: readonly CliAgentInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    reportsCost: true,
    execProvider: "claude_cli",
    note:
      "Utilise le login `claude` de la machine du worker (abonnement), pas une clé API. " +
      "Coût réel remonté à chaque invocation.",
    buildArgs: (prompt, { runId, resumeSessionId }) => [
      "-p",
      prompt,
      "--output-format",
      "json",
      // acceptEdits : le CLI écrit dans son workspace sans demander, mais
      // reste soumis aux permissions. JAMAIS --dangerously-skip-permissions.
      "--permission-mode",
      "acceptEdits",
      ...(resumeSessionId
        ? ["--resume", resumeSessionId]
        : // --session-id impose un UUID : celui du run → reprise déterministe.
          ["--session-id", runId]),
    ],
    parseOutcome: parseClaudeStdout,
  },
] as const;

export function cliAgentInfo(id: string): CliAgentInfo | undefined {
  return CLI_AGENTS.find((c) => c.id === id);
}

export function isCliAgentId(id: string): id is CliAgentId {
  return CLI_AGENTS.some((c) => c.id === id);
}
