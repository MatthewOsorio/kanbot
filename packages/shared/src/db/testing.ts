import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { createDb } from "./index";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://kanbot:kanbot@localhost:5432/kanbot_test";

/** Creates the test database if missing and brings it to the latest migration (e2e and worker tests). */
export async function prepareTestDatabase(url = TEST_DATABASE_URL) {
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const admin = new Client({
    connectionString: Object.assign(new URL(u), { pathname: "/postgres" }).href,
  });
  await admin.connect();
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (!rowCount) await admin.query(`create database "${dbName}"`);
  await admin.end();

  const db = createDb(url);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  await db.$client.end();
}
