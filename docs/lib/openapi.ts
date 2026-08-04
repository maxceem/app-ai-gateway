import { createOpenAPI } from "fumadocs-openapi/server";
import path from "node:path";

const schemaPath = path.resolve(process.cwd(), "../openapi/openapi.json");

export const openapi = createOpenAPI({
  input: { [schemaPath]: schemaPath },
});
