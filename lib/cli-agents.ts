/**
 * Registre des agents CLI (moteur `cli` du mode Autonome).
 *
 * Un agent CLI (`claude`, `gemini`, `opencode`) n'est pas un provider LLM de
 * plus : c'est un programme qui **boucle déjà en interne** avec ses propres
 * outils (lecture/écriture de fichiers, bash, git) et s'authentifie avec **son
 * propre login** — l'app ne lui fournit aucune clé. Là où le moteur `llm`
 * respecte l'invariant « le modèle ne produit jamais de code exécutable »
 * (cf. [architect.ts](architect.ts)), le moteur `cli` le rompt par construction :
 * le CLI écrit vraiment dans son workspace. C'est le but, et c'est confiné au
 * seul moteur `cli`.
 *
 * Ce module est **pur et client-safe** (aucun import Node) : il est importé par
 * le panneau du mode Autonome pour afficher les libellés. La détection de
 * disponibilité vit dans [cli-availability.ts](cli-availability.ts) (server-only),
 * le lancement dans [cli-agent.ts](cli-agent.ts).
 */
import type { IntelligenceLevel } from "@/lib/intelligence";

export type CliAgentId = "claude" | "gemini" | "opencode";

/**
 * Modèle imposé à `opencode run`.
 *
 * Non négociable, et pas un réglage de confort : **sans `-m`, `opencode run`
 * ne rend jamais la main** (constaté : 0 octet de sortie jusqu'au timeout).
 * Avec un modèle explicite, il répond en quelques secondes. Le défaut reprend
 * le modèle gratuit déjà retenu ailleurs dans l'app (OpenCode Zen).
 */
export const OPENCODE_CLI_MODEL =
  process.env.OPENCODE_CLI_MODEL ?? "opencode/big-pickle";

/**
 * Valeur `provider` écrite dans `agent_executions` pour un run CLI. Distincte
 * des providers LLM : un run `claude` (abonnement) n'est pas un appel API
 * `anthropic`, et les mélanger fausserait la lecture du coût.
 */
export type CliExecProvider = "claude_cli" | "gemini_cli" | "opencode_cli";

/**
 * Consommation d'UN modèle pendant une invocation.
 *
 * Un agent CLI n'est pas mono-modèle : une seule invocation de `claude` passe
 * couramment par plusieurs modèles (un petit pour les tâches annexes, un gros
 * pour le raisonnement). Agréger le tout sous « claude » masquerait justement
 * ce qu'on cherche à voir.
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
  /** Coût réel remonté par le CLI, en USD. 0 si le CLI ne le remonte pas. */
  costUsd: number;
  /**
   * Consommation ventilée par modèle. Vide si le CLI n'expose rien
   * d'exploitable — on préfère une liste vide à un modèle inventé.
   */
  usage: CliModelUsage[];
  /** Identifiant de session à repasser pour reprendre (itération suivante). */
  sessionId?: string;
}

export interface BuildArgsOptions {
  /**
   * UUID du run : sert d'identifiant de session imposé quand le CLI le
   * supporte (`claude`, `gemini`), ce qui rend la reprise déterministe.
   */
  runId: string;
  /**
   * Session à reprendre, issue du `CliOutcome.sessionId` de l'itération
   * précédente. Absent → première invocation du run.
   */
  resumeSessionId?: string;
}

export interface CliAgentInfo {
  id: CliAgentId;
  label: string;
  /** Binaire cherché dans le PATH de la machine du worker. */
  bin: string;
  /**
   * Niveau d'intelligence de l'agent (cf. [intelligence.ts](intelligence.ts)),
   * pour le comparer aux autres sources lors du routage dynamique.
   *
   * C'est le niveau du **modèle que le CLI utilise par défaut**, pas celui du
   * CLI en tant qu'outil : un agent qui lit des fichiers et lance des tests fait
   * mieux qu'un appel API au même modèle, mais surcoter pour ça reviendrait à
   * l'élire sur des tâches où un modèle local gratuit suffit.
   */
  level: IntelligenceLevel;
  /**
   * Le CLI remonte-t-il un coût réel ? `false` → `costUsd` vaut toujours 0 et
   * le plafond `maxCostUsd` du run est **aveugle** : seuls `maxIterations` et
   * le timeout protègent. À afficher, pas à cacher.
   */
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
 * Les CLI mélangent parfois des lignes non-JSON (avertissements, bannières) au
 * JSON attendu, et une sortie tronquée (timeout, kill) reste exploitable. Ces
 * helpers ne jettent JAMAIS : un run par ailleurs réussi ne doit pas être perdu
 * sur un détail de format.
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

/** Objets JSON d'un flux NDJSON, en ignorant les lignes illisibles. */
function parseNdjson(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Repli de dernier recours : format non reconnu (CLI mis à jour, sortie
 * tronquée…). On rend le stdout brut, qui reste la seule information dont on
 * dispose. À n'utiliser QUE si rien n'a pu être parsé : quand la sortie est
 * comprise mais sans texte final, déverser le flux machine dans le fil de la
 * tâche est pire que de le dire.
 */
function rawFallback(stdout: string): CliOutcome {
  return { text: stdout.trim(), costUsd: 0, usage: [] };
}

/** Objet JSON imbriqué, ou `{}` — évite un `as` à chaque accès. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * `claude` : `modelUsage` ventile déjà tokens et coût par modèle — c'est la
 * source la plus fine, on la prend telle quelle.
 *
 * Repli sur `usage` (agrégé, tous modèles confondus) quand `modelUsage` manque
 * : le modèle est alors inconnu, et le dire vaut mieux que d'attribuer les
 * tokens au premier modèle venu.
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
 * `gemini` : `stats.models` est une carte modèle → { tokens: { prompt,
 * candidates, cached, thoughts, tool } }. Aucun coût n'y figure (cf.
 * `reportsCost: false`).
 *
 * NON VÉRIFIÉ sur un vrai run : l'authentification `gemini` est morte sur
 * cette machine (cf. `knownIssue`). Écrit d'après la forme documentée et
 * couvert par fixture ; à confirmer quand l'auth sera rétablie.
 */
function parseGeminiUsage(j: Record<string, unknown>): CliModelUsage[] {
  const models = asRecord(asRecord(j.stats).models);
  const out: CliModelUsage[] = [];

  for (const [model, raw] of Object.entries(models)) {
    const t = asRecord(asRecord(raw).tokens);
    const input = asNumber(t.prompt) + asNumber(t.cached);
    const output = asNumber(t.candidates) + asNumber(t.thoughts);
    if (input === 0 && output === 0) continue;
    out.push({ model, inputTokens: input, outputTokens: output, costUsd: 0 });
  }
  return out;
}

/** Modèle non identifiable dans la sortie du CLI. Affiché tel quel. */
export const UNKNOWN_MODEL = "(modèle inconnu)";

/**
 * Parse la sortie `--output-format json` de `claude`. Extraite du registre pour
 * être réutilisée par les appels synchrones (génération/chat/widgets) via
 * [claude-cli.ts](claude-cli.ts) : ces appels ne passent pas par le moteur `cli`
 * mais lisent le même format. Ne jette jamais.
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

/** Sortie comprise, mais l'agent n'a pas conclu par un message. */
const NO_FINAL_TEXT =
  "_(l'agent n'a pas renvoyé de message final — voir les changements du workspace ci-dessous)_";

// --- Registre ------------------------------------------------------------

/**
 * Formes d'invocation vérifiées sur les binaires réellement installés
 * (sondes du 2026-07-16), pas déduites de la documentation.
 */
export const CLI_AGENTS: readonly CliAgentInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    // Tourne sur Opus/Fable par défaut — mêmes niveaux que `claude-opus` dans
    // FAMILY_LEVELS.
    level: 4,
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
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    // Gemini Pro par défaut, comme `gemini-pro` dans FAMILY_LEVELS.
    level: 3,
    // Sortie `-o json` : { response, stats } — aucun coût exposé.
    reportsCost: false,
    execProvider: "gemini_cli",
    knownIssue:
      "Sur cette machine, `gemini` échoue à l'authentification : Google a retiré " +
      "Gemini Code Assist « individuals » à ce client (IneligibleTierError) et " +
      "renvoie vers Antigravity. Chemin de code écrit et testé sur fixtures, mais " +
      "non vérifié de bout en bout — il le sera quand l'auth sera rétablie.",
    note: "Ne remonte aucun coût : le plafond du run ne le limite pas.",
    buildArgs: (prompt, { runId, resumeSessionId }) => [
      "-p",
      prompt,
      "--approval-mode",
      "auto_edit",
      "-o",
      "json",
      // Un workspace fraîchement cloné n'est jamais « trusted » : sans ce flag
      // le CLI refuse de démarrer en headless.
      "--skip-trust",
      // `--resume` ne prend pas d'identifiant de session mais "latest" ou un
      // index — d'où l'asymétrie avec claude.
      ...(resumeSessionId ? ["--resume", "latest"] : ["--session-id", runId]),
    ],
    parseOutcome: (stdout) => {
      const j = parseJsonLoose(stdout) as Record<string, unknown> | null;
      if (!j) return rawFallback(stdout);
      return {
        text: asString(j.response) || NO_FINAL_TEXT,
        costUsd: 0,
        usage: parseGeminiUsage(j),
        sessionId: asString(j.sessionId) || undefined,
      };
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    // Le niveau de `OPENCODE_CLI_MODEL` (big-pickle, gratuit) — pas celui d'un
    // frontière : ce CLI est imposé à un modèle gratuit, cf. OPENCODE_CLI_MODEL.
    level: 2,
    // `step_finish.part.cost` porte un coût réel (0 sur les modèles gratuits).
    reportsCost: true,
    execProvider: "opencode_cli",
    note:
      "Utilise les credentials `opencode auth`. Le coût vaut 0 sur les modèles " +
      "gratuits (big-pickle…) — c'est un vrai 0, pas une absence de mesure.",
    buildArgs: (prompt, { resumeSessionId }) => [
      "run",
      "--format",
      "json",
      // Obligatoire : sans modèle explicite, opencode se bloque (cf.
      // OPENCODE_CLI_MODEL).
      "-m",
      OPENCODE_CLI_MODEL,
      // Les identifiants de session (`ses_…`) sont générés par opencode : on ne
      // peut pas en imposer un, seulement reprendre celui qu'il a renvoyé.
      ...(resumeSessionId ? ["--session", resumeSessionId] : []),
      prompt,
    ],
    parseOutcome: (stdout) => {
      const events = parseNdjson(stdout);
      if (events.length === 0) return rawFallback(stdout);

      let text = "";
      let costUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let sessionId: string | undefined;

      for (const e of events) {
        const part = (e.part ?? {}) as Record<string, unknown>;
        sessionId ||= asString(e.sessionID) || undefined;
        if (e.type === "text") text += asString(part.text);
        if (e.type === "step_finish") {
          costUsd += asNumber(part.cost);
          // `tokens: { input, output, reasoning, cache: { read, write } }`.
          const t = asRecord(part.tokens);
          const cache = asRecord(t.cache);
          inputTokens +=
            asNumber(t.input) + asNumber(cache.read) + asNumber(cache.write);
          // Le raisonnement est facturé comme de la sortie.
          outputTokens += asNumber(t.output) + asNumber(t.reasoning);
        }
      }

      // Le flux ne nomme pas le modèle : c'est celui qu'on a imposé via `-m`,
      // seul modèle possible de l'invocation.
      const usage: CliModelUsage[] =
        inputTokens > 0 || outputTokens > 0
          ? [{ model: OPENCODE_CLI_MODEL, inputTokens, outputTokens, costUsd }]
          : [];

      // Le flux est compris : même sans message final, on ne recrache pas les
      // événements bruts dans le fil de la tâche.
      return { text: text.trim() || NO_FINAL_TEXT, costUsd, usage, sessionId };
    },
  },
] as const;

export function cliAgentInfo(id: string): CliAgentInfo | undefined {
  return CLI_AGENTS.find((c) => c.id === id);
}

export function isCliAgentId(id: string): id is CliAgentId {
  return CLI_AGENTS.some((c) => c.id === id);
}
