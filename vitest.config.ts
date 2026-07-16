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
    },
  },
  test: {
    environment: "node",
    // Les tests d'intégration partagent la même base (truncate) → pas de
    // parallélisme entre fichiers.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
