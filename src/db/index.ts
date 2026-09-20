import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function database(binding: D1Database) {
  // The plain D1 binding is the authoritative primary boundary. Security and
  // management reads use it deliberately: any staleness they tolerate comes
  // from the Worker's bounded caches, never from an unconstrained replica.
  return drizzle(binding, { schema });
}

export type Database = ReturnType<typeof database>;
