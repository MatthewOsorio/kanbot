import { createDb } from "@kanbot/shared/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { TEST_DATABASE_URL } from "../playwright.config";

/** Creates the e2e database if missing and brings it to the latest migration. */
export default async function globalSetup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new Client({
    connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).href,
  });
  await admin.connect();
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (!rowCount) await admin.query(`create database "${dbName}"`);
  await admin.end();

  const db = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: "../../packages/shared/drizzle" });
  await db.$client.end();
}
