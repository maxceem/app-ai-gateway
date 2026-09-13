import { mkdir, rm, writeFile } from "node:fs/promises";
import { createOpenAPIDocument } from "../../src/contracts/openapi.ts";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const output = new URL("../content/docs/api/", import.meta.url);
const schema = new URL("../public/openapi.json", import.meta.url).pathname;
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(schema, JSON.stringify(createOpenAPIDocument({ includeHidden: false }), null, 2) + "\n");
await rm(output, { recursive: true, force: true });
await generateFiles({
  input: createOpenAPI({ input: [schema] }),
  output: output.pathname,
  includeDescription: true,
  groupBy: "tag",
  meta: true,
});

await writeFile(new URL("index.mdx", output), `---
title: API reference
description: App management and integration endpoints from the gateway's OpenAPI 3.1 contract.
---

The endpoint pages cover app management and integration. Download the
[OpenAPI document](/openapi.json) for request and response schemas.

<Cards>
  <Card title="Application authentication" href="/api/application-authentication/createAppAttestChallenge" description="App Attest registration and gateway token exchange." />
  <Card title="Provider proxy" href="/api/provider-proxy/proxyProviderRequest" description="Provider-native requests and streaming responses." />
  <Card title="Admin applications" href="/api/admin-applications/listApps" description="Create, validate, update and delete applications." />
  <Card title="Admin operations" href="/api/admin-operations/listAppKeys" description="Keys, credentials, users, usage, and events." />
</Cards>
`);
