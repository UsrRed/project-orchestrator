/**
 * Connexion PostgreSQL (Drizzle + postgres.js).
 *
 * En dev, on réutilise un singleton pour éviter d'ouvrir une nouvelle connexion
 * à chaque hot-reload de Next.js.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/drizzle/schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL n'est pas défini (voir .env.example).");
}

const globalForDb = globalThis as unknown as {
  client: ReturnType<typeof postgres> | undefined;
};

const client = globalForDb.client ?? postgres(connectionString, { max: 1 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.client = client;
}

export const db = drizzle(client, { schema });
export { schema };
