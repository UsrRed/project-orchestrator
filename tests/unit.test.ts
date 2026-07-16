import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  CLI_AGENTS,
  OPENCODE_CLI_MODEL,
  UNKNOWN_MODEL,
  cliAgentInfo,
  isCliAgentId,
} from "@/lib/cli-agents";
import { parseUsageText } from "@/lib/claude-usage";
import { decrypt, encrypt, maskSecret } from "@/lib/crypto";
import { buildEnv, runProcess } from "@/lib/process";
import { workspacePathFor } from "@/lib/workspace";
import {
  resetBreakers,
  runWithFallback,
  selectModelChain,
} from "@/lib/llm-router";
import {
  canManageRepos,
  parseRepoInput,
  slugifyRepoName,
} from "@/lib/github";
import { validateGitHubClientId } from "@/lib/oauth-config";
import { currentUsage, resetRateLimits, tryAcquire } from "@/lib/rate-limit";
import { parseWidget } from "@/lib/widgets";
import { panelKeyFor } from "@/lib/phase-panel";
import {
  credentialHelp,
  defaultMethod,
  isMethodSupported,
} from "@/lib/providers";
import { findFreeModel, findModel, specForModel } from "@/lib/models";
import {
  isFreeModel,
  listCatalogModels,
  listFreeModels,
  getCatalogModel,
  listCatalogModels as allModels,
  pickModelForLevel,
} from "@/lib/model-catalog";
import {
  assessLevel,
  deriveLevel,
  FAMILY_LEVELS,
  levelOf,
  type ModelSignals,
} from "@/lib/intelligence";
import { TIER_MIN_LEVEL } from "@/lib/models";

describe("crypto", () => {
  it("round-trip encrypt/decrypt", () => {
    const secret = "sk-ant-SUPER-secret-1234567890";
    const enc = encrypt(secret);
    expect(decrypt(enc)).toBe(secret);
    expect(enc).not.toContain(secret);
    expect(enc.split(":")).toHaveLength(3);
  });

  it("IV aléatoire : deux chiffrements diffèrent", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("détecte l'altération (auth tag)", () => {
    const enc = encrypt("data");
    expect(() => decrypt(enc.slice(0, -4) + "AAAA")).toThrow();
  });

  it("masque une clé", () => {
    expect(maskSecret("sk-ant-api03-XYZ-6411")).toBe("sk-a…6411");
  });
});

describe("routeur : chaîne de fallback", () => {
  const keys = {
    ollama: { method: "none" as const },
    openai: { method: "api_key" as const, secret: "x" },
  };

  beforeEach(() => {
    resetBreakers();
    resetRateLimits();
  });

  it("ordonne par préférence (ollama d'abord)", () => {
    const chain = selectModelChain("frontier", keys).map((s) => s.provider);
    expect(chain[0]).toBe("ollama");
    expect(chain).toContain("openai");
  });

  it("essaie les modèles gratuits avant les payants", () => {
    const chain = selectModelChain("frontier", {
      opencode: { method: "api_key", secret: "x" },
      anthropic: { method: "api_key", secret: "x" },
    });
    const free = chain.filter((s) => s.inputPerMTok === 0);
    const paid = chain.filter((s) => s.inputPerMTok > 0);
    expect(free.length).toBeGreaterThan(0);
    expect(paid.length).toBeGreaterThan(0);
    // Tous les gratuits passent avant le premier payant.
    expect(chain.indexOf(free[free.length - 1]!)).toBeLessThan(
      chain.indexOf(paid[0]!),
    );
    expect(free[0]!.provider).toBe("opencode");
  });

  it("bascule au provider suivant en cas d'échec", async () => {
    const seen: string[] = [];
    const res = await runWithFallback("frontier", keys, async (_m, spec) => {
      seen.push(spec.provider);
      if (spec.provider === "ollama") throw new Error("panne");
      return { value: "ok", usage: {} };
    });
    expect(res.spec.provider).toBe("openai");
    expect(seen).toEqual(["ollama", "openai"]);
  });

  it("erreur agrégée si tous échouent", async () => {
    await expect(
      runWithFallback("frontier", keys, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/ollama.*openai/s);
  });

  it("timeout → abort → provider suivant", async () => {
    const res = await runWithFallback(
      "frontier",
      keys,
      async (_m, spec, signal) => {
        if (spec.provider === "ollama") {
          return await new Promise((_r, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted"))),
          );
        }
        return { value: "ok", usage: {} };
      },
      { timeoutMs: 50 },
    );
    expect(res.spec.provider).toBe("openai");
  });

  it("circuit-breaker : saute un provider après 3 échecs", async () => {
    for (let i = 0; i < 3; i++) {
      await runWithFallback("frontier", keys, async (_m, spec) => {
        if (spec.provider === "ollama") throw new Error("ko");
        return { value: "ok", usage: {} };
      });
    }
    const seen: string[] = [];
    await runWithFallback("frontier", keys, async (_m, spec) => {
      seen.push(spec.provider);
      return { value: "ok", usage: {} };
    });
    expect(seen).not.toContain("ollama");
    expect(seen).toContain("openai");
  });
});

describe("rate-limiter", () => {
  beforeEach(() => resetRateLimits());

  it("borne à 30 rpm pour groq", () => {
    let ok = 0;
    for (let i = 0; i < 35; i++) if (tryAcquire("groq", 1000)) ok++;
    expect(ok).toBe(30);
    expect(currentUsage("groq", 1000)).toBe(30);
  });

  it("exempte le local (ollama)", () => {
    expect(tryAcquire("ollama", 1000)).toBe(true);
    expect(tryAcquire("ollama", 1000)).toBe(true);
  });

  it("fenêtre glissante : réautorisé après 60s", () => {
    for (let i = 0; i < 30; i++) tryAcquire("groq", 1000);
    expect(tryAcquire("groq", 1000)).toBe(false);
    expect(tryAcquire("groq", 62_000)).toBe(true);
  });
});

describe("widgets : parsing sécurisé", () => {
  it("accepte un comparison_table valide", () => {
    const w = parseWidget({
      type: "comparison_table",
      title: "t",
      columns: ["a", "b"],
      rows: [{ cells: ["1", "2"] }],
    });
    expect(w?.type).toBe("comparison_table");
  });

  it("parse une string JSON", () => {
    expect(parseWidget('{"type":"callout","level":"info","title":"t","body":"b"}')?.type).toBe("callout");
  });

  it("rejette un type non whitelisté (anti-XSS)", () => {
    expect(parseWidget({ type: "script", payload: "<img onerror=x>" })).toBeNull();
  });

  it("rejette un JSON invalide / enum hors schéma", () => {
    expect(parseWidget("{pas json")).toBeNull();
    expect(parseWidget({ type: "callout", level: "danger", title: "t", body: "b" })).toBeNull();
  });
});

describe("config OAuth GitHub", () => {
  it("accepte les formats de client_id d'OAuth App", () => {
    expect(validateGitHubClientId("Ov23liABCDefgh123456")).toBeNull();
    expect(validateGitHubClientId("1234567890abcdef1234")).toBeNull();
  });

  it("rejette les valeurs qui provoqueraient un 404 au login", () => {
    // La valeur d'exemple de la doc GitHub (cas réellement rencontré).
    expect(validateGitHubClientId("Iv1.client_id")).toMatch(/GitHub App/);
    expect(validateGitHubClientId("Iv1.0123456789abcdef")).toMatch(/GitHub App/);
    expect(validateGitHubClientId("")).toMatch(/requis/);
    expect(validateGitHubClientId("trop-court")).toMatch(/invalide/);
    expect(validateGitHubClientId("your_client_id_here_x")).toMatch(/exemple/);
  });
});

describe("rattachement Git des projets", () => {
  it("parseRepoInput : URL https, SSH, ou owner/repo", () => {
    expect(parseRepoInput("https://github.com/UsrRed/mon-depot")).toBe(
      "UsrRed/mon-depot",
    );
    expect(parseRepoInput("https://github.com/UsrRed/mon-depot.git/")).toBe(
      "UsrRed/mon-depot",
    );
    expect(parseRepoInput("git@github.com:UsrRed/mon-depot.git")).toBe(
      "UsrRed/mon-depot",
    );
    expect(parseRepoInput("UsrRed/mon-depot")).toBe("UsrRed/mon-depot");
  });

  it("parseRepoInput : rejette ce qui n'est pas un dépôt GitHub", () => {
    expect(parseRepoInput("")).toBeNull();
    expect(parseRepoInput("https://gitlab.com/moi/depot")).toBeNull();
    // Chemin trop profond (pas un dépôt) ou caractères interdits.
    expect(parseRepoInput("https://github.com/moi/depot/issues/1")).toBeNull();
    expect(parseRepoInput("moi/dep ot")).toBeNull();
    expect(parseRepoInput("../../etc/passwd")).toBeNull();
  });

  it("slugifyRepoName : nom de dépôt valide depuis du texte libre", () => {
    expect(slugifyRepoName("Suivi d'habitudes — été 2026")).toBe(
      "suivi-d-habitudes-ete-2026",
    );
    expect(slugifyRepoName("!!!")).toBe("projet");
    expect(slugifyRepoName("a".repeat(200))).toHaveLength(90);
  });

  it("canManageRepos : exige le scope repo", () => {
    expect(canManageRepos({ token: "t", scopes: ["read:user", "repo"] })).toBe(true);
    expect(canManageRepos({ token: "t", scopes: ["read:user"] })).toBe(false);
    expect(canManageRepos(null)).toBe(false);
  });
});

describe("connecteurs : registre & aide", () => {
  it("méthodes par provider", () => {
    expect(defaultMethod("ollama")).toBe("none");
    expect(isMethodSupported("ollama", "none")).toBe(true);
    expect(isMethodSupported("ollama", "api_key")).toBe(false);
    expect(isMethodSupported("google", "oauth")).toBe(true);
    expect(isMethodSupported("groq", "oauth")).toBe(false);
  });

  it("lien « obtenir la credential » selon la méthode", () => {
    expect(credentialHelp("openai", "api_key")?.url).toContain("platform.openai.com");
    expect(credentialHelp("anthropic", "api_key")?.url).toContain("console.anthropic.com");
    const g = credentialHelp("google", "oauth");
    expect(g?.command).toBe("gcloud auth print-access-token");
    expect(credentialHelp("ollama", "none")).toBeNull();
  });
});

describe("catalogue de modèles (models.dev)", () => {
  it("expose tous les modèles d'un provider avec coûts", () => {
    const anthropic = listCatalogModels("anthropic");
    expect(anthropic.length).toBeGreaterThan(5);
    expect(anthropic.every((m) => m.input > 0 && m.context > 0)).toBe(true);
    expect(listCatalogModels("openrouter").length).toBeGreaterThan(100);
  });

  it("pickModelForLevel : le moins cher qui atteint le niveau", () => {
    const avance = pickModelForLevel("anthropic", 2);
    const expert = pickModelForLevel("anthropic", 3);
    expect(levelOf(avance!)).toBeGreaterThanOrEqual(2);
    expect(levelOf(expert!)).toBeGreaterThanOrEqual(3);
    // Exiger davantage ne peut pas coûter moins cher.
    expect(expert!.input).toBeGreaterThanOrEqual(avance!.input);
  });

  it("pickModelForLevel : boost prend le plus capable, pas le moins cher", () => {
    const normal = pickModelForLevel("anthropic", 3);
    const boosted = pickModelForLevel("anthropic", 3, { boost: true });
    expect(levelOf(boosted!)).toBeGreaterThan(levelOf(normal!));
    expect(levelOf(boosted!)).toBe(4);
    // Le boost ne descend jamais sous le plancher demandé.
    expect(levelOf(boosted!)).toBeGreaterThanOrEqual(3);
  });

  it("pickModelForLevel : undefined plutôt qu'un repli au rabais", () => {
    // Groq n'a aucun modèle de niveau expert : le routeur doit sauter le
    // provider, pas lui substituer un modèle plus faible en silence.
    expect(pickModelForLevel("groq", 4)).toBeUndefined();
  });

  it("findModel : provider cloud depuis le catalogue, local à coût nul", () => {
    const a = findModel("anthropic", "frontier");
    expect(a?.provider).toBe("anthropic");
    expect(a!.inputPerMTok).toBeGreaterThan(0);

    const local = findModel("ollama", "fast");
    expect(local?.provider).toBe("ollama");
    expect(local!.inputPerMTok).toBe(0);
  });

  it("expose les modèles gratuits (OpenCode Zen, OpenRouter :free)", () => {
    const zen = listFreeModels("opencode");
    expect(zen.length).toBeGreaterThan(5);
    expect(zen.every(isFreeModel)).toBe(true);
    expect(zen.map((m) => m.id)).toContain("big-pickle");
    const or = listFreeModels("openrouter");
    expect(or.length).toBeGreaterThan(5);
    expect(or.every((m) => m.id.includes("free"))).toBe(true);
    // Aucun gratuit chez Anthropic → pas de spec gratuit.
    expect(findFreeModel("anthropic", "fast")).toBeUndefined();
  });

  it("findFreeModel : spec à coût nul, capable pour le tier", () => {
    const fast = findFreeModel("opencode", "fast");
    expect(fast?.inputPerMTok).toBe(0);
    expect(fast?.outputPerMTok).toBe(0);

    const frontier = findFreeModel("opencode", "frontier");
    expect(frontier?.inputPerMTok).toBe(0);
    // Un gratuit ne tient le tier frontier qu'avec un grand contexte.
    expect(frontier!.contextWindow).toBeGreaterThanOrEqual(100_000);
  });

  it("specForModel : construit un spec pour un modèle précis du catalogue", () => {
    const anyModel = listCatalogModels("openai")[0]!;
    const spec = specForModel("openai", anyModel.id, "fast");
    expect(spec?.modelId).toBe(anyModel.id);
    expect(spec?.inputPerMTok).toBe(anyModel.input);
    expect(specForModel("openai", "modele-inexistant-xyz", "fast")).toBeUndefined();
  });
});

describe("panneau adaptatif", () => {
  it("mappe le type de phase (accents/casse/sous-chaîne)", () => {
    expect(panelKeyFor("Développement")).toBe("developpement");
    expect(panelKeyFor("Conception & Design")).toBe("design");
    expect(panelKeyFor("RECHERCHE utilisateur")).toBe("recherche");
    expect(panelKeyFor("marketing digital")).toBe("marketing");
    expect(panelKeyFor(null)).toBe("default");
    expect(panelKeyFor("inconnu")).toBe("default");
  });
});

// --- Moteur CLI (agents de code) -----------------------------------------

/**
 * Sorties réelles capturées sur les binaires installés (sondes du 2026-07-16),
 * volontairement pas reconstituées à la main : c'est ce qui donne leur valeur à
 * ces tests — un changement de format des CLI doit les faire échouer.
 */
const CLAUDE_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 7768,
  num_turns: 1,
  result: "OK",
  session_id: "5366007b-2a07-4e00-b9bc-9614b696ad3c",
  total_cost_usd: 0.172316,
  usage: { input_tokens: 2, output_tokens: 21 },
});

const OPENCODE_NDJSON = [
  JSON.stringify({
    type: "step_start",
    sessionID: "ses_09451e019ffeWIMeX56l6hpHGa",
    part: { type: "step-start" },
  }),
  JSON.stringify({
    type: "text",
    sessionID: "ses_09451e019ffeWIMeX56l6hpHGa",
    part: { type: "text", text: "Got it." },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_09451e019ffeWIMeX56l6hpHGa",
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { input: 20, output: 13 },
      cost: 0.0042,
    },
  }),
].join("\n");

const GEMINI_JSON = JSON.stringify({
  response: "OK",
  stats: { models: {} },
});

/**
 * Sortie réelle de `claude -p --output-format json` (sonde du 2026-07-16),
 * réduite aux champs lus. `modelUsage` ventile par modèle : une invocation
 * unique a traversé DEUX modèles, et `usage.input_tokens` vaut 2 alors que
 * ~26 000 tokens ont réellement été traités (le reste est du cache).
 */
const CLAUDE_JSON_MULTI = JSON.stringify({
  type: "result",
  result: "OK",
  session_id: "743b663e-c01c-4f02-a104-729b9b8924af",
  total_cost_usd: 0.172111,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 7597,
    cache_read_input_tokens: 18573,
    output_tokens: 20,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 523,
      outputTokens: 11,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000578,
    },
    "claude-fable-5": {
      inputTokens: 2,
      outputTokens: 20,
      cacheReadInputTokens: 18573,
      cacheCreationInputTokens: 7597,
      costUSD: 0.171533,
    },
  },
});

/** Sortie réelle de `opencode run --format json` (même sonde). */
const OPENCODE_NDJSON_TOKENS = [
  JSON.stringify({
    type: "text",
    sessionID: "ses_x",
    part: { type: "text", text: "OK" },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_x",
    part: {
      type: "step-finish",
      tokens: {
        total: 11432,
        input: 10394,
        output: 4,
        reasoning: 10,
        cache: { write: 0, read: 1024 },
      },
      cost: 0,
    },
  }),
].join("\n");

/**
 * Texte réel de `claude -p "/usage"` (sonde du 2026-07-16), tronqué après les
 * limites — la suite (« What's contributing… ») est du statistique local.
 */
const CLAUDE_USAGE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 6% used · resets Jul 17, 12:50am (Europe/Paris)
Current week (all models): 8% used · resets Jul 19, 11pm (Europe/Paris)
Current week (Fable): 0% used · resets Jul 19, 11pm (Europe/Paris)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.

Last 24h · 1371 requests · 10 sessions
  88% of your usage was at >150k context
  69% of your usage came from sessions active for 8+ hours`;

describe("quota d'abonnement Claude", () => {
  it("extrait les limites du texte réel de /usage", () => {
    const limits = parseUsageText(CLAUDE_USAGE_TEXT);
    expect(limits).toEqual([
      {
        key: "session",
        label: "Current session",
        percentUsed: 6,
        resetsAt: "Jul 17, 12:50am (Europe/Paris)",
      },
      {
        key: "week_all_models",
        label: "Current week (all models)",
        percentUsed: 8,
        resetsAt: "Jul 19, 11pm (Europe/Paris)",
      },
      {
        key: "week_fable",
        label: "Current week (Fable)",
        percentUsed: 0,
        resetsAt: "Jul 19, 11pm (Europe/Paris)",
      },
    ]);
  });

  it("ignore les statistiques locales, qui ne sont pas le quota", () => {
    // « 88% of your usage was at >150k context » ressemble à une limite mais
    // n'en est pas une : sans « used », la ligne ne doit pas être retenue.
    const keys = parseUsageText(CLAUDE_USAGE_TEXT).map((l) => l.key);
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.includes("context"))).toBe(false);
  });

  it("les clés sont stables entre deux relevés : le delta est appariable", () => {
    const before = parseUsageText(CLAUDE_USAGE_TEXT);
    const after = parseUsageText(
      CLAUDE_USAGE_TEXT.replace("Current session: 6%", "Current session: 11%"),
    );
    const b = before.find((l) => l.key === "session")!;
    const a = after.find((l) => l.key === "session")!;
    // Points de pourcentage, pas de variation relative : 6 → 11 consomme 5
    // points de quota, pas « +83 % ».
    expect(a.percentUsed - b.percentUsed).toBe(5);
  });

  it("dégrade sans jeter : format inconnu, texte vide, décimales", () => {
    expect(parseUsageText("")).toEqual([]);
    expect(parseUsageText("Bienvenue dans Claude Code")).toEqual([]);
    // Un compte sur clé API n'affiche pas de quota d'abonnement.
    expect(parseUsageText("You are using the Anthropic API")).toEqual([]);

    const decimal = parseUsageText("Current session: 12.5% used");
    expect(decimal[0]!.percentUsed).toBe(12.5);
    // Sans « resets », la limite reste exploitable.
    expect(decimal[0]!.resetsAt).toBeNull();
  });
});

describe("registre des agents CLI", () => {
  it("expose claude, gemini et opencode", () => {
    expect(CLI_AGENTS.map((c) => c.id)).toEqual([
      "claude",
      "gemini",
      "opencode",
    ]);
    expect(isCliAgentId("claude")).toBe(true);
    expect(isCliAgentId("cursor")).toBe(false);
    expect(cliAgentInfo("inconnu")).toBeUndefined();
  });

  it("claude : impose la session au 1er appel, la reprend ensuite", () => {
    const claude = cliAgentInfo("claude")!;
    const first = claude.buildArgs("fais X", { runId: "run-uuid" });
    expect(first).toContain("-p");
    expect(first).toContain("fais X");
    expect(first.join(" ")).toContain("--session-id run-uuid");
    expect(first.join(" ")).toContain("--output-format json");
    // Le mode permissif intégral ne doit jamais être demandé.
    expect(first).not.toContain("--dangerously-skip-permissions");
    expect(first.join(" ")).toContain("--permission-mode acceptEdits");

    const next = claude.buildArgs("continue", {
      runId: "run-uuid",
      resumeSessionId: "sess-abc",
    });
    expect(next.join(" ")).toContain("--resume sess-abc");
    expect(next.join(" ")).not.toContain("--session-id");
  });

  it("gemini : --skip-trust obligatoire, reprise par « latest »", () => {
    const gemini = cliAgentInfo("gemini")!;
    // Un workspace fraîchement cloné n'est jamais « trusted » : sans ce flag le
    // CLI refuse de démarrer en headless.
    expect(gemini.buildArgs("x", { runId: "r" })).toContain("--skip-trust");
    // `--resume` de gemini ne prend pas d'id de session, mais "latest".
    const next = gemini.buildArgs("x", { runId: "r", resumeSessionId: "s1" });
    expect(next.join(" ")).toContain("--resume latest");
  });

  it("opencode : ne reprend une session que si on lui en donne une", () => {
    const oc = cliAgentInfo("opencode")!;
    const first = oc.buildArgs("fais X", { runId: "r" });
    expect(first[0]).toBe("run");
    expect(first).not.toContain("--session");
    expect(first.at(-1)).toBe("fais X");

    const next = oc.buildArgs("fais X", { runId: "r", resumeSessionId: "ses_1" });
    expect(next.join(" ")).toContain("--session ses_1");
  });

  it("opencode : impose toujours un modèle", () => {
    // Régression : sans `-m`, `opencode run` ne rend jamais la main (0 octet
    // jusqu'au timeout) — le run échouerait en « timeout » sans rien produire.
    const oc = cliAgentInfo("opencode")!;
    expect(oc.buildArgs("x", { runId: "r" }).join(" ")).toContain(
      `-m ${OPENCODE_CLI_MODEL}`,
    );
    expect(
      oc.buildArgs("x", { runId: "r", resumeSessionId: "ses_1" }),
    ).toContain("-m");
  });

  it("claude : extrait texte, coût réel et session", () => {
    const out = cliAgentInfo("claude")!.parseOutcome(CLAUDE_JSON);
    expect(out.text).toBe("OK");
    expect(out.costUsd).toBeCloseTo(0.172316, 6);
    expect(out.sessionId).toBe("5366007b-2a07-4e00-b9bc-9614b696ad3c");
  });

  it("opencode : concatène le texte et somme le coût du flux NDJSON", () => {
    const out = cliAgentInfo("opencode")!.parseOutcome(OPENCODE_NDJSON);
    expect(out.text).toBe("Got it.");
    expect(out.costUsd).toBeCloseTo(0.0042, 6);
    expect(out.sessionId).toBe("ses_09451e019ffeWIMeX56l6hpHGa");
  });

  it("gemini : extrait la réponse, sans coût (il n'en remonte aucun)", () => {
    const out = cliAgentInfo("gemini")!.parseOutcome(GEMINI_JSON);
    expect(out.text).toBe("OK");
    expect(out.costUsd).toBe(0);
    expect(cliAgentInfo("gemini")!.reportsCost).toBe(false);
  });

  it("claude : ventile les tokens par modèle, cache compris", () => {
    const out = cliAgentInfo("claude")!.parseOutcome(CLAUDE_JSON_MULTI);

    // Une invocation, deux modèles : les agréger sous « claude » perdrait
    // justement l'information cherchée.
    const byModel = Object.fromEntries(out.usage.map((u) => [u.model, u]));
    expect(Object.keys(byModel).sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
    ]);

    // 2 (non caché) + 18 573 (lu en cache) + 7 597 (écrit en cache) = 26 172.
    // S'en tenir à `input_tokens` afficherait 2 — faux d'un facteur 13 000.
    expect(byModel["claude-fable-5"]!.inputTokens).toBe(26172);
    expect(byModel["claude-fable-5"]!.outputTokens).toBe(20);
    expect(byModel["claude-fable-5"]!.costUsd).toBeCloseTo(0.171533, 6);
    expect(byModel["claude-haiku-4-5-20251001"]!.inputTokens).toBe(523);

    // La ventilation doit se recoller au total facturé, sinon le coût par
    // modèle et le coût du run raconteraient deux histoires différentes.
    const summed = out.usage.reduce((s, u) => s + u.costUsd, 0);
    expect(summed).toBeCloseTo(out.costUsd, 6);
  });

  it("claude : sans modelUsage, replie sur l'agrégat sans inventer de modèle", () => {
    const out = cliAgentInfo("claude")!.parseOutcome(CLAUDE_JSON);
    expect(out.usage).toHaveLength(1);
    expect(out.usage[0]!.model).toBe(UNKNOWN_MODEL);
    expect(out.usage[0]!.inputTokens).toBe(2);
    expect(out.usage[0]!.outputTokens).toBe(21);
  });

  it("opencode : somme les tokens et les attribue au modèle imposé", () => {
    const out = cliAgentInfo("opencode")!.parseOutcome(OPENCODE_NDJSON_TOKENS);
    expect(out.usage).toHaveLength(1);
    // Le flux ne nomme pas le modèle : c'est celui passé via `-m`.
    expect(out.usage[0]!.model).toBe(OPENCODE_CLI_MODEL);
    // 10 394 + 1 024 (cache lu) + 0 (cache écrit).
    expect(out.usage[0]!.inputTokens).toBe(11418);
    // 4 + 10 (raisonnement, facturé comme de la sortie).
    expect(out.usage[0]!.outputTokens).toBe(14);
  });

  it("gemini : ventile par modèle d'après stats.models (sans coût)", () => {
    const out = cliAgentInfo("gemini")!.parseOutcome(
      JSON.stringify({
        response: "OK",
        stats: {
          models: {
            "gemini-2.5-pro": {
              tokens: { prompt: 1200, cached: 300, candidates: 45, thoughts: 5 },
            },
          },
        },
      }),
    );
    expect(out.usage).toEqual([
      {
        model: "gemini-2.5-pro",
        inputTokens: 1500,
        outputTokens: 50,
        costUsd: 0,
      },
    ]);
  });

  it("aucune consommation exploitable : liste vide, pas de modèle inventé", () => {
    expect(cliAgentInfo("gemini")!.parseOutcome(GEMINI_JSON).usage).toEqual([]);
    for (const cli of CLI_AGENTS) {
      expect(cli.parseOutcome("texte libre, pas du JSON").usage).toEqual([]);
    }
  });

  it("parse : dégrade sans jeter sur une sortie illisible ou tronquée", () => {
    for (const cli of CLI_AGENTS) {
      // Un run par ailleurs réussi ne doit jamais être perdu sur un détail de
      // format : on rend le stdout brut plutôt que de lever.
      expect(cli.parseOutcome("texte libre, pas du JSON").text).toBe(
        "texte libre, pas du JSON",
      );
      expect(cli.parseOutcome("").costUsd).toBe(0);
      expect(() => cli.parseOutcome('{"result": tronq')).not.toThrow();
    }
  });

  it("claude : ignore les lignes parasites avant le JSON", () => {
    const noisy = `Avertissement: mise à jour disponible\n${CLAUDE_JSON}`;
    expect(cliAgentInfo("claude")!.parseOutcome(noisy).text).toBe("OK");
  });

  it("sortie comprise mais sans message final : ne recrache pas le flux brut", () => {
    // Un agent peut n'utiliser que des outils et s'arrêter sans conclure. Le
    // fil de la tâche ne doit pas recevoir 4 Ko d'événements machine pour
    // autant : le coût et la session restent lus, le texte est explicite.
    const noText = [
      JSON.stringify({
        type: "step_start",
        sessionID: "ses_x",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_x",
        part: { type: "step-finish", cost: 0.5 },
      }),
    ].join("\n");

    const out = cliAgentInfo("opencode")!.parseOutcome(noText);
    expect(out.text).not.toContain("step_finish");
    expect(out.text).toContain("pas renvoyé de message final");
    expect(out.costUsd).toBeCloseTo(0.5, 6);
    expect(out.sessionId).toBe("ses_x");

    // Idem pour claude : JSON valide, `result` absent.
    const claudeNoResult = cliAgentInfo("claude")!.parseOutcome(
      JSON.stringify({ type: "result", total_cost_usd: 0.1 }),
    );
    expect(claudeNoResult.text).toContain("pas renvoyé de message final");
    expect(claudeNoResult.costUsd).toBeCloseTo(0.1, 6);
  });
});

describe("workspaces", () => {
  it("n'accepte que des UUID (pas d'échappement de la racine)", () => {
    const uuid = "5366007b-2a07-4e00-b9bc-9614b696ad3c";
    expect(workspacePathFor(uuid).endsWith(uuid)).toBe(true);
    for (const bad of ["../../etc", "/etc/passwd", "", "abc"]) {
      expect(() => workspacePathFor(bad)).toThrow();
    }
  });

  it("un dossier nu sous .workspaces/ appartient au dépôt de l'app", async () => {
    // Régression : c'est précisément ce qui s'est produit. Un workspace sans
    // dépôt propre laisse git remonter jusqu'au dépôt de l'orchestrateur —
    // l'agent croit travailler chez l'utilisateur et pilote le code de l'app.
    // `ensureWorkspace` fait donc un `git init` et vérifie la racine.
    const nu = await mkdtemp(join(process.cwd(), ".workspace-test-"));
    try {
      const top = await runProcess({
        bin: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: nu,
        timeoutMs: 10_000,
      });
      expect(top.stdout.trim()).toBe(process.cwd());

      // Avec un dépôt à sa racine, la frontière devient opaque au parent.
      await runProcess({ bin: "git", args: ["init", "-q"], cwd: nu, timeoutMs: 10_000 });
      const after = await runProcess({
        bin: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: nu,
        timeoutMs: 10_000,
      });
      expect(await realpath(after.stdout.trim())).toBe(await realpath(nu));
    } finally {
      await rm(nu, { recursive: true, force: true });
    }
  });
});

describe("environnement des agents CLI", () => {
  it("n'expose aucune clé LLM du worker", () => {
    // Enjeu réel : une ANTHROPIC_API_KEY transmise ferait basculer Claude Code
    // sur la facturation à la clé au lieu de l'abonnement de l'utilisateur.
    const env = buildEnv(
      {},
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        ANTHROPIC_API_KEY: "sk-secret",
        GEMINI_API_KEY: "g-secret",
        OPENAI_API_KEY: "o-secret",
        DATABASE_URL: "postgres://…",
        ENCRYPTION_MASTER_KEY: "master",
        XDG_CONFIG_HOME: "/home/u/.config",
      },
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    // Les CLI lisent leur login dans XDG_CONFIG_HOME : indispensable.
    expect(env.XDG_CONFIG_HOME).toBe("/home/u/.config");
    for (const leaked of [
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "ENCRYPTION_MASTER_KEY",
    ]) {
      expect(env[leaked]).toBeUndefined();
    }
  });

  it("laisse passer les surcharges explicites", () => {
    const env = buildEnv({ FOO: "bar" }, { PATH: "/usr/bin" });
    expect(env.FOO).toBe("bar");
  });
});

describe("runProcess", () => {
  const cwd = process.cwd();

  it("capture stdout et le code de sortie", async () => {
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", "console.log('hello'); process.exit(0)"],
      cwd,
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.timedOut).toBe(false);
  });

  it("bout en bout : sortie d'un faux claude → CliOutcome", async () => {
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(CLAUDE_JSON)})`],
      cwd,
      timeoutMs: 10_000,
    });
    const out = cliAgentInfo("claude")!.parseOutcome(r.stdout);
    expect(out.text).toBe("OK");
    expect(out.costUsd).toBeCloseTo(0.172316, 6);
  });

  it("remonte un code de sortie non nul comme résultat, pas comme exception", async () => {
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(3)"],
      cwd,
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe("boom");
  });

  it("jette un message lisible si le binaire n'existe pas", async () => {
    await expect(
      runProcess({
        bin: "binaire-qui-nexiste-pas-xyz",
        args: [],
        cwd,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/introuvable/);
  });

  it("tue vraiment le processus au timeout", async () => {
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", "setInterval(() => {}, 1e9)"],
      cwd,
      timeoutMs: 700,
    });
    expect(r.timedOut).toBe(true);
    // Le drapeau ne suffit pas : le processus doit être réellement mort,
    // sinon un run « arrêté » continuerait de tourner sur la machine.
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  it("tue le processus sur annulation (kill switch)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", "setInterval(() => {}, 1e9)"],
      cwd,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("tue toute la descendance, pas seulement le fils", async () => {
    // Un agent CLI lance des sous-process (git, tests, node) : les laisser
    // survivre à un kill switch serait une fuite silencieuse.
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1e9);
    `;
    const controller = new AbortController();
    const p = runProcess({
      bin: process.execPath,
      args: ["-e", script],
      cwd,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 800));
    controller.abort();
    const r = await p;

    const grandchildPid = Number(r.stdout.trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    // kill(pid, 0) ne tue rien : il teste l'existence du processus.
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it("tronque une sortie qui dépasse le plafond", async () => {
    const r = await runProcess({
      bin: process.execPath,
      args: ["-e", "console.log('x'.repeat(50_000))"],
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1_000);
  });

  it("n'attend pas sur stdin", async () => {
    // Régression : `opencode run` reste bloqué tant que stdin est ouvert et ne
    // rend jamais la main (constaté : 0 octet jusqu'au timeout).
    const r = await runProcess({
      bin: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data', () => {}); console.log('pas bloqué');",
      ],
      cwd,
      timeoutMs: 5_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe("pas bloqué");
  });
});

// --- Niveaux d'intelligence ----------------------------------------------

describe("niveaux d'intelligence", () => {
  /** Modèle de test : seuls les signaux comptent. */
  const sig = (over: Partial<ModelSignals> = {}): ModelSignals => ({
    id: "test-model",
    family: null,
    input: 1,
    output: 3,
    context: 128_000,
    reasoning: false,
    release_date: "2026-06-01",
    ...over,
  });
  const NOW = new Date("2026-07-16");

  it("la table prime sur la dérivation", () => {
    const haiku = sig({ id: "claude-haiku-4-5", family: "claude-haiku", input: 1 });
    const a = assessLevel(haiku, NOW);
    expect(a.source).toBe("family");
    expect(a.level).toBe(FAMILY_LEVELS["claude-haiku"]);
  });

  it("une famille inconnue est dérivée, pas rejetée", () => {
    const a = assessLevel(sig({ family: "famille-jamais-vue" }), NOW);
    expect(a.source).toBe("derived");
    expect(a.level).toBeGreaterThanOrEqual(0);
  });

  it("respecte la hiérarchie réelle d'Anthropic (catalogue embarqué)", () => {
    // Le vrai test de la table : l'ordre doit refléter le produit.
    const lvl = (id: string) => levelOf(getCatalogModel("anthropic", id)!, NOW);
    expect(lvl("claude-haiku-4-5")).toBeLessThan(lvl("claude-sonnet-4-6"));
    expect(lvl("claude-sonnet-4-6")).toBeLessThan(lvl("claude-opus-4-8"));
    expect(lvl("claude-opus-4-8")).toBe(4);
  });

  it("le prix seul ne fait pas l'intelligence : plus cher ⇒ niveau ≥", () => {
    expect(deriveLevel(sig({ input: 0.1, output: 0.1 }), NOW)).toBeLessThan(
      deriveLevel(sig({ input: 10, output: 30 }), NOW),
    );
  });

  it("un modèle ancien resté cher est déclassé", () => {
    // Sinon un GPT-4o de 2024 à 5 $ est dérivé « frontière » et gagne le mode
    // boost devant les modèles récents — constaté avant ce correctif.
    const recent = sig({ input: 5, output: 15, release_date: "2026-05-01" });
    const vieux = sig({ input: 5, output: 15, release_date: "2024-05-13" });
    expect(deriveLevel(vieux, NOW)).toBeLessThan(deriveLevel(recent, NOW));
  });

  it("une petite variante est déclassée, même dans une famille curée", () => {
    // `gpt-codex` est curé à 3, mais `-codex-mini` n'est pas son égal.
    const gros = sig({ id: "gpt-5-codex", family: "gpt-codex" });
    const mini = sig({ id: "gpt-5.1-codex-mini", family: "gpt-codex" });
    expect(assessLevel(mini, NOW).level).toBe(
      assessLevel(gros, NOW).level - 1,
    );
  });

  it("ne pénalise pas deux fois une famille qui encode déjà la variante", () => {
    // `gpt-mini` est curé à 2 EN TANT QUE famille de minis : re-pénaliser
    // « gpt-4.1-mini » le ferait tomber à 1 à tort.
    const m = sig({ id: "gpt-4.1-mini", family: "gpt-mini" });
    expect(assessLevel(m, NOW).level).toBe(FAMILY_LEVELS["gpt-mini"]);
  });

  it("un modèle gratuit n'est jamais présumé frontière", () => {
    const free = sig({
      input: 0,
      output: 0,
      reasoning: true,
      context: 1_000_000,
    });
    expect(deriveLevel(free, NOW)).toBeLessThanOrEqual(3);
  });

  it("un contexte minuscule déclasse, quel que soit le prix", () => {
    const petit = sig({ input: 10, output: 30, context: 4_000 });
    const grand = sig({ input: 10, output: 30, context: 200_000 });
    expect(deriveLevel(petit, NOW)).toBeLessThan(deriveLevel(grand, NOW));
  });

  it("reste toujours dans 0..4", () => {
    for (const m of [
      sig({ input: 0, output: 0, context: 1_000 }),
      sig({ input: 999, output: 999, reasoning: true, context: 10_000_000 }),
      sig({ id: "x-mini", input: 0, output: 0, context: 512 }),
    ]) {
      const l = deriveLevel(m, NOW);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(4);
    }
  });
});

describe("catalogue : ce qui est routable", () => {
  const PROVIDERS = [
    "anthropic",
    "openai",
    "google",
    "groq",
    "openrouter",
    "opencode",
  ] as const;

  it("aucun modèle non textuel ni embedding n'est routable", () => {
    // Le catalogue mélange générateurs d'images, audio et embeddings ; la
    // sélection « le plus cher » pouvait élire un modèle d'image.
    for (const p of PROVIDERS) {
      for (const m of allModels(p)) {
        expect(m.maxOutput).toBeGreaterThanOrEqual(256);
        expect(m.context).toBeGreaterThan(0);
        expect(m.id).not.toMatch(/embed/i);
      }
    }
    // Piège : models.dev range la **dimension** des embeddings OpenAI dans
    // `limit.output` (1536, 3072…) et leur déclare une sortie « text » — ils
    // franchissaient donc le seuil numérique. Seul le nom les trahit.
    expect(getCatalogModel("google", "gemini-embedding-001")).toBeUndefined();
    expect(getCatalogModel("openai", "text-embedding-3-large")).toBeUndefined();
  });

  it("le routage respecte le niveau minimum de chaque tier", () => {
    for (const p of PROVIDERS) {
      for (const tier of ["fast", "frontier"] as const) {
        const spec = findModel(p, tier);
        if (!spec) continue; // provider sans modèle assez capable : légitime.
        expect(spec.level).toBeGreaterThanOrEqual(TIER_MIN_LEVEL[tier]);
      }
    }
  });

  it("un gratuit trop faible n'est pas retenu pour une tâche experte", () => {
    for (const p of PROVIDERS) {
      const free = findFreeModel(p, "frontier");
      if (free) expect(free.level).toBeGreaterThanOrEqual(TIER_MIN_LEVEL.frontier);
    }
  });
});

describe("mode boost", () => {
  const keys = {
    opencode: { method: "api_key" as const, secret: "x" },
    anthropic: { method: "api_key" as const, secret: "x" },
  };

  it("boost : la capacité passe devant la gratuité", () => {
    // Sans cette règle, un gratuit atteignant tout juste le plancher gagnerait
    // toujours et « boost » ne monterait jamais plus haut : le mode serait mort.
    const normal = selectModelChain("frontier", keys);
    const boosted = selectModelChain("frontier", keys, { boost: true });

    expect(normal[0]!.inputPerMTok).toBe(0); // normal → gratuit d'abord
    expect(boosted[0]!.level).toBe(4); // boost → le plus capable d'abord
    expect(boosted[0]!.level).toBeGreaterThan(normal[0]!.level);
  });

  it("boost : la chaîne est triée par capacité décroissante", () => {
    const chain = selectModelChain("frontier", keys, { boost: true });
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.level).toBeLessThanOrEqual(chain[i - 1]!.level);
    }
  });

  it("boost : n'abaisse jamais le plancher du tier", () => {
    for (const chain of [
      selectModelChain("fast", keys, { boost: true }),
      selectModelChain("frontier", keys, { boost: true }),
    ]) {
      expect(chain.length).toBeGreaterThan(0);
    }
    for (const s of selectModelChain("frontier", keys, { boost: true })) {
      expect(s.level).toBeGreaterThanOrEqual(TIER_MIN_LEVEL.frontier);
    }
  });
});
