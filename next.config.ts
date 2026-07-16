import { join } from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * `instrumentation.ts` est compilé pour **tous les runtimes** (le middleware
   * impose une passe edge, le dev une passe navigateur), et le bundler suit
   * l'import du worker sans tenir compte du garde `NEXT_RUNTIME === "nodejs"` :
   * il y tire Postgres, `node:child_process`, `node:fs`, `node:crypto` — que
   * l'edge et le navigateur ne savent pas résoudre. La build échoue alors avant
   * même que le garde ne s'exécute.
   *
   * On substitue donc une doublure hors runtime Node. La substitution porte sur
   * le **chemin résolu**, pas sur la requête `@/lib/worker-runtime` : les alias
   * `@/*` du tsconfig sont résolus par un plugin de Next avant que
   * `resolve.alias` ou `IgnorePlugin` ne voient quoi que ce soit — tous deux
   * restent sans effet ici (constaté, pas supposé).
   *
   * Le garde reste la vraie protection : la doublure n'est jamais appelée.
   */
  webpack: (config, { nextRuntime, webpack }) => {
    if (nextRuntime !== "nodejs") {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /lib[\\/]worker-runtime\.ts$/,
          join(process.cwd(), "lib", "worker-runtime.stub.ts"),
        ),
      );
    }
    return config;
  },
};

export default nextConfig;
