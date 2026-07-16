import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Charge .env (dev local) sans écraser l'environnement existant (la CI fournit
// DATABASE_URL / ENCRYPTION_MASTER_KEY directement).
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    const key = m?.[1];
    if (key && !process.env[key]) {
      let v = (m?.[2] ?? "").trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[key] = v;
    }
  }
} catch {
  // pas de .env (CI) : variables déjà dans l'environnement.
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` lève hors d'un bundler : on le neutralise pour les tests.
      "server-only": fileURLToPath(new URL("./tests/empty.ts", import.meta.url)),
      // Les Server Actions dépendent du contexte de requête Next (cache,
      // redirection). Ces bouchons le remplacent pour que les tests
      // fonctionnels exercent les vraies actions — pas une copie de leur
      // logique. Cf. tests/stubs/.
      "next/cache": fileURLToPath(
        new URL("./tests/stubs/next-cache.ts", import.meta.url),
      ),
      "next/navigation": fileURLToPath(
        new URL("./tests/stubs/next-navigation.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    /**
     * Identité du « modèle local » figée pour les tests.
     *
     * Sans ça, elle dépend du poste : les niveaux (`LOCAL_AI_LEVEL`) décident du
     * routage, et un `.env` de développeur ferait passer ici ce qui échoue en CI.
     *
     * `LOCAL_AI_BASE_URL` pointe volontairement vers un port mort : par défaut
     * le provider `ollama` viserait `localhost:1234`, c'est-à-dire le vrai
     * LM Studio de la machine — un test appellerait alors un modèle réel, lent,
     * non déterministe, et absent de la CI. Le faux modèle
     * ([fake-llm.ts](tests/fake-llm.ts)) réécrit cette variable vers son propre
     * serveur ; tout appel qui lui échapperait échoue net au lieu de passer
     * inaperçu.
     */
    env: {
      LOCAL_AI_MODEL: "qwen-active",
      LOCAL_AI_LEVEL: "3",
      LOCAL_AI_CONTEXT: "32768",
      LOCAL_AI_BASE_URL: "http://127.0.0.1:1/v1",
    },
    // Les tests d'intégration partagent la même base (truncate) → pas de
    // parallélisme entre fichiers.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
