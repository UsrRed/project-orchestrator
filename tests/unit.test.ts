import { beforeEach, describe, expect, it } from "vitest";

import { decrypt, encrypt, maskSecret } from "@/lib/crypto";
import {
  resetBreakers,
  runWithFallback,
  selectModelChain,
} from "@/lib/llm-router";
import { currentUsage, resetRateLimits, tryAcquire } from "@/lib/rate-limit";
import { parseWidget } from "@/lib/widgets";
import { panelKeyFor } from "@/lib/phase-panel";
import {
  credentialHelp,
  defaultMethod,
  isMethodSupported,
} from "@/lib/providers";

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
