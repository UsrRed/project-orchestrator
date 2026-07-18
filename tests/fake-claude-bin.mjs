#!/usr/bin/env node
/**
 * Faux binaire `claude`, branché là où le vrai le serait : **sur le PATH**.
 *
 * Depuis le passage en « Claude uniquement », toute l'app appelle `claude -p`
 * (génération d'architecture, chat, widgets, run autonome, sonde de quota). En
 * CI il n'y a ni binaire réel ni abonnement : ce script imite la sortie
 * `--output-format json` de Claude Code, avec un contenu dérivé du JSON Schema
 * injecté dans le prompt (mêmes structured outputs que le vrai), pas de fixtures.
 *
 * Config et journal des appels transitent par des fichiers dans un dossier
 * partagé sous `os.tmpdir()` — l'allowlist d'environnement de `buildEnv`
 * ([lib/process.ts]) empêche de passer quoi que ce soit par une variable
 * d'environnement custom, mais `os.tmpdir()` est identique parent/enfant.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(tmpdir(), "orchestrato-fake-claude");
const CONFIG = join(DIR, "config.json");
const CALLS = join(DIR, "calls.jsonl");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Lit une option `--flag valeur` dans argv. */
function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// --- Génération d'une valeur conforme à un JSON Schema (cf. ancien fake-llm) --

function primaryType(schema) {
  const t = schema.type;
  return Array.isArray(t) ? t.find((x) => x !== "null") : t;
}

function itemCount(schema) {
  const min = schema.minItems ?? 1;
  const max = schema.maxItems ?? Math.max(min, 2);
  return Math.min(Math.max(min, 2), max);
}

function fakeNumber(schema) {
  const min = schema.minimum ?? 1;
  const max = schema.maximum ?? min + 1;
  return Math.min(min, max);
}

function build(schema, key, values) {
  const override = values?.[key];
  if (override !== undefined) return override;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants && variants.length > 0) {
    const first =
      variants.find((v) => primaryType(v) && primaryType(v) !== "null") ??
      variants[0];
    return build(first, key, values);
  }

  switch (primaryType(schema)) {
    case "object": {
      const out = {};
      for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        out[name] = build(sub, name, values);
      }
      return out;
    }
    case "array": {
      const items = schema.items ?? {};
      return Array.from({ length: itemCount(schema) }, (_, i) =>
        build(items, `${key}[${i}]`, values),
      );
    }
    case "boolean":
      return false;
    case "integer":
    case "number":
      return fakeNumber(schema);
    case "null":
      return null;
    default:
      return `${key} (faux claude)`;
  }
}

// --- Corps ---------------------------------------------------------------

const argv = process.argv.slice(2);
const prompt = argValue(argv, "-p") ?? "";
const model = argValue(argv, "--model") ?? "claude-fake-1";
const config = readJson(CONFIG, {});

/** Sonde de quota : `claude -p "/usage"`. Texte parseable par parseUsageText. */
if (prompt.trim() === "/usage") {
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result:
        "You are currently using your subscription to power your Claude Code usage\n\n" +
        "Current session: 4% used · resets Jul 20, 12:00am (Europe/Paris)\n" +
        "Current week (all models): 5% used · resets Jul 26, 11pm (Europe/Paris)",
      total_cost_usd: 0,
      num_turns: 0,
    }),
  );
  process.exit(0);
}

const schemaMatch = prompt.match(/<json_schema>\s*([\s\S]*?)\s*<\/json_schema>/);
let result;
let properties = [];
let structured = false;
if (schemaMatch) {
  structured = true;
  const schema = JSON.parse(schemaMatch[1]);
  properties = Object.keys(schema.properties ?? {});
  result = JSON.stringify(build(schema, "root", config.values));
} else {
  result = typeof config.text === "string" ? config.text : "Réponse du faux claude.";
}

// Journal des appels (pour les assertions du test : nombre, signature de schéma).
let index = 0;
let sameSchemaIndex = 0;
try {
  const lines = readFileSync(CALLS, "utf8").split("\n").filter(Boolean);
  index = lines.length;
  const signature = properties.join(",");
  sameSchemaIndex = lines.filter((l) => {
    try {
      return JSON.parse(l).properties.join(",") === signature;
    } catch {
      return false;
    }
  }).length;
} catch {
  // Pas encore de journal : premier appel.
}
try {
  appendFileSync(
    CALLS,
    JSON.stringify({ index, sameSchemaIndex, properties, model, structured }) + "\n",
  );
} catch {
  // Dossier absent (fake non installé) : on répond quand même.
}

// Tokens et coût non nuls : c'est ce qui alimente le journal de coût et le HUD ;
// un 0 masquerait une régression de comptabilisation. Coût « équivalent » réel
// remonté par Claude Code sur abonnement.
process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result,
    session_id: "00000000-0000-4000-8000-00000000fake",
    total_cost_usd: 0.01,
    usage: { input_tokens: 120, output_tokens: 60 },
    modelUsage: {
      [model]: {
        inputTokens: 120,
        outputTokens: 60,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.01,
      },
    },
  }),
);
process.exit(0);
