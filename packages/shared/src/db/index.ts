import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export * from "./schema";
export * from "./write";
export * from "./ops";

/** `appName` shows in pg_stat_activity; the health check finds the worker by it. */
export function createDb(url: string, appName = "kanbot-web") {
  return drizzle({ connection: { connectionString: url, application_name: appName }, schema });
}

export type Db = ReturnType<typeof createDb>;
