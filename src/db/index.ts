import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function database(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type Database = ReturnType<typeof database>;
