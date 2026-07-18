import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLI_AGENTS,
  UNKNOWN_MODEL,
  cliAgentInfo,
  isCliAgentId,
} from "@/lib/cli-agents";
import { parseUsageText } from "@/lib/claude-usage";
import { decrypt, encrypt, maskSecret } from "@/lib/crypto";
import { buildEnv, runProcess } from "@/lib/process";
import { workspacePathFor } from "@/lib/workspace";
import {
  canManageRepos,
  parseRepoInput,
  slugifyRepoName,
} from "@/lib/github";
import { validateGitHubClientId } from "@/lib/oauth-config";
import { parseWidget } from "@/lib/widgets";
import { panelKeyFor } from "@/lib/phase-panel";
import { runNotes } from "@/lib/conversation";

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

describe("progression d'un run : notes du bon run, et rien d'autre", () => {
  const msg = (
    kind: string,
    content: string,
    data?: unknown,
  ): Parameters<typeof runNotes>[0][number] =>
    ({
      id: content,
      role: "assistant",
      content,
      kind,
      data,
      createdAt: new Date(0),
    }) as Parameters<typeof runNotes>[0][number];

  it("ne renvoie que les étapes du run demandé", () => {
    const all = [
      msg("auto_step", "run A étape 1", { runId: "A" }),
      msg("auto_step", "run B étape 1", { runId: "B" }),
      msg("auto_step", "run A étape 2", { runId: "A" }),
    ];
    expect(runNotes(all, "A").map((m) => m.content)).toEqual([
      "run A étape 1",
      "run A étape 2",
    ]);
  });

  it("exclut le plan et les avis de service", () => {
    const all = [
      msg("auto_plan", "Plan du run…", { runId: "A" }),
      msg("auto_notice", "Tâche introuvable", { runId: "A" }),
      msg("artifact", "Artefact produit", { runId: "A" }),
      msg("text", "message utilisateur"),
      msg("auto_step", "vrai travail", { runId: "A" }),
    ];
    expect(runNotes(all, "A").map((m) => m.content)).toEqual(["vrai travail"]);
  });

  it("exclut les notes sans identifiant de run (runs antérieurs)", () => {
    expect(runNotes([msg("auto_step", "vieille note")], "A")).toEqual([]);
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

// --- Agent CLI (Claude Code) ---------------------------------------------

/**
 * Sorties réelles capturées sur le binaire installé (sonde du 2026-07-16),
 * volontairement pas reconstituées à la main : c'est ce qui donne leur valeur à
 * ces tests — un changement de format du CLI doit les faire échouer.
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

/**
 * Sortie réelle de `claude -p --output-format json`. `modelUsage` ventile par
 * modèle : une invocation unique a traversé DEUX modèles, et `usage.input_tokens`
 * vaut 2 alors que ~26 000 tokens ont réellement été traités (reste = cache).
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

/**
 * Texte réel de `claude -p "/usage"`, tronqué après les limites — la suite
 * (« What's contributing… ») est du statistique local.
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
    expect(a.percentUsed - b.percentUsed).toBe(5);
  });

  it("dégrade sans jeter : format inconnu, texte vide, décimales", () => {
    expect(parseUsageText("")).toEqual([]);
    expect(parseUsageText("Bienvenue dans Claude Code")).toEqual([]);
    expect(parseUsageText("You are using the Anthropic API")).toEqual([]);

    const decimal = parseUsageText("Current session: 12.5% used");
    expect(decimal[0]!.percentUsed).toBe(12.5);
    expect(decimal[0]!.resetsAt).toBeNull();
  });
});

describe("registre de l'agent CLI (Claude Code)", () => {
  it("n'expose plus que claude", () => {
    expect(CLI_AGENTS.map((c) => c.id)).toEqual(["claude"]);
    expect(isCliAgentId("claude")).toBe(true);
    expect(isCliAgentId("gemini")).toBe(false);
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
    expect(first).not.toContain("--dangerously-skip-permissions");
    expect(first.join(" ")).toContain("--permission-mode acceptEdits");

    const next = claude.buildArgs("continue", {
      runId: "run-uuid",
      resumeSessionId: "sess-abc",
    });
    expect(next.join(" ")).toContain("--resume sess-abc");
    expect(next.join(" ")).not.toContain("--session-id");
  });

  it("claude : extrait texte, coût réel et session", () => {
    const out = cliAgentInfo("claude")!.parseOutcome(CLAUDE_JSON);
    expect(out.text).toBe("OK");
    expect(out.costUsd).toBeCloseTo(0.172316, 6);
    expect(out.sessionId).toBe("5366007b-2a07-4e00-b9bc-9614b696ad3c");
  });

  it("claude : ventile les tokens par modèle, cache compris", () => {
    const out = cliAgentInfo("claude")!.parseOutcome(CLAUDE_JSON_MULTI);
    const byModel = Object.fromEntries(out.usage.map((u) => [u.model, u]));
    expect(Object.keys(byModel).sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
    ]);
    // 2 (non caché) + 18 573 (lu en cache) + 7 597 (écrit en cache) = 26 172.
    expect(byModel["claude-fable-5"]!.inputTokens).toBe(26172);
    expect(byModel["claude-fable-5"]!.outputTokens).toBe(20);
    expect(byModel["claude-fable-5"]!.costUsd).toBeCloseTo(0.171533, 6);
    expect(byModel["claude-haiku-4-5-20251001"]!.inputTokens).toBe(523);
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

  it("parse : dégrade sans jeter sur une sortie illisible ou tronquée", () => {
    const claude = cliAgentInfo("claude")!;
    expect(claude.parseOutcome("texte libre, pas du JSON").text).toBe(
      "texte libre, pas du JSON",
    );
    expect(claude.parseOutcome("texte libre, pas du JSON").usage).toEqual([]);
    expect(claude.parseOutcome("").costUsd).toBe(0);
    expect(() => claude.parseOutcome('{"result": tronq')).not.toThrow();
  });

  it("claude : ignore les lignes parasites avant le JSON", () => {
    const noisy = `Avertissement: mise à jour disponible\n${CLAUDE_JSON}`;
    expect(cliAgentInfo("claude")!.parseOutcome(noisy).text).toBe("OK");
  });

  it("sortie comprise mais sans message final : ne recrache pas le flux brut", () => {
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
    const nu = await mkdtemp(join(process.cwd(), ".workspace-test-"));
    try {
      const top = await runProcess({
        bin: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: nu,
        timeoutMs: 10_000,
      });
      expect(top.stdout.trim()).toBe(process.cwd());

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

describe("environnement de l'agent CLI", () => {
  it("n'expose aucune clé LLM du worker", () => {
    // Enjeu réel : une ANTHROPIC_API_KEY transmise ferait basculer Claude Code
    // sur la facturation à la clé au lieu de l'abonnement de l'utilisateur.
    const env = buildEnv(
      {},
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        ANTHROPIC_API_KEY: "sk-secret",
        OPENAI_API_KEY: "o-secret",
        DATABASE_URL: "postgres://…",
        ENCRYPTION_MASTER_KEY: "master",
        XDG_CONFIG_HOME: "/home/u/.config",
      },
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    // Claude Code lit son login dans XDG_CONFIG_HOME : indispensable.
    expect(env.XDG_CONFIG_HOME).toBe("/home/u/.config");
    for (const leaked of [
      "ANTHROPIC_API_KEY",
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
