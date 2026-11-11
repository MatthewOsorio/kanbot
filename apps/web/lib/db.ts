import { createDb, type Db } from "@kanbot/shared/server";

const g = globalThis as { kanbotDb?: Db };

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  return url;
}

// One pool per process, kept across dev hot reloads.
export const db = (g.kanbotDb ??= createDb(databaseUrl()));
