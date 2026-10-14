import { mkdir, rm, writeFile } from "node:fs/promises";
import { createOpenAPIDocument } from "../../src/contracts/openapi.ts";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const output = new URL("../content/docs/api/", import.meta.url);
const schema = new URL("../public/openapi.json", import.meta.url).pathname;
const document = createOpenAPIDocument({ includeHidden: false });
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(schema, JSON.stringify(document, null, 2) + "\n");

// Search results show a page's meta description, and an operation's own
// description is long, technical, or missing. So every endpoint page gets a
// short one built from what the reader is looking for: the action, the
// endpoint, and the credential it takes. Fumadocs hands the frontmatter hook
// only the title, which is the operation's summary, so operations are found by
// summary, and a summary must name one operation.
const MAX_DESCRIPTION = 155;
const MIN_DESCRIPTION = 70;
const operations = new Map();
for (const [path, item] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(item)) {
    if (!operation?.operationId) continue;
    if (operations.has(operation.summary)) {
      throw new Error(`Two operations share the summary "${operation.summary}"; each endpoint page needs its own title.`);
    }
    operations.set(operation.summary, { method: method.toUpperCase(), path, security: operation.security });
  }
}

function credential(security) {
  const schemes = new Set((security ?? []).flatMap((requirement) => Object.keys(requirement)));
  if (schemes.has("ManagementBearer")) return "Accepts a management key, MCP OAuth token or console session.";
  if (schemes.has("ConsoleSession")) return "Accepts a console session only.";
  if (schemes.has("GatewayBearer")) return "Accepts a gateway token or an app API key.";
  if (schemes.has("CliPollProof")) return "Accepts the CLI's private operation token.";
  // Public operations still prove something in their body or headers, so
  // claiming they need nothing would mislead.
  return undefined;
}

function metaDescription(summary) {
  const operation = operations.get(summary);
  if (!operation) throw new Error(`No operation has the summary "${summary}".`);
  const endpoint = `${summary} (${operation.method} ${operation.path})`;
  let text = `${endpoint} in the App AI Gateway API.`;
  if (text.length > MAX_DESCRIPTION) return `${endpoint}.`;
  const access = credential(operation.security);
  if (access && `${text} ${access}`.length <= MAX_DESCRIPTION) text = `${text} ${access}`;
  if (text.length < MIN_DESCRIPTION) text = `${text} See its request, responses and error codes.`;
  return text;
}

await rm(output, { recursive: true, force: true });
await generateFiles({
  input: createOpenAPI({ input: [schema] }),
  output: output.pathname,
  includeDescription: true,
  frontmatter: (title, _description, context) =>
    context.type === "operation" ? { description: metaDescription(title) } : {},
  groupBy: "tag",
  meta: true,
});

await writeFile(new URL("index.mdx", output), `---
title: API reference
description: App management and integration endpoints from the gateway's OpenAPI 3.1 contract.
---

The endpoint pages cover app management and integration. Download the
[OpenAPI document](/openapi.json) for request and response schemas.

## Endpoint groups

<Cards>
  <Card title="Application authentication" href="/api/application-authentication/createAppAttestChallenge" description="App Attest registration and gateway token exchange." />
  <Card title="Provider proxy" href="/api/provider-proxy/proxyProviderRequest" description="Provider-native requests and streaming responses." />
  <Card title="Admin applications" href="/api/admin-applications/listApps" description="Create, validate, update and delete applications." />
  <Card title="Admin management keys" href="/api/admin-management-keys/createManagementKey" description="Create, list and revoke the keys scripts, CI jobs and agents use." />
  <Card title="Admin operations" href="/api/admin-operations/listAppKeys" description="Keys, credentials, users, usage, and events." />
</Cards>
`);
