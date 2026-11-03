import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export * from "./schema";

export function createDb(url: string) {
  return drizzle(url, { schema });
}

export type Db = ReturnType<typeof createDb>;
