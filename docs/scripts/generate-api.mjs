import { rm, writeFile } from "node:fs/promises";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const output = new URL("../content/docs/api/", import.meta.url);
const schema = new URL("../../openapi/openapi.json", import.meta.url).pathname;
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
description: Generated from the gateway's checked-in OpenAPI 3.1 contract.
---

The endpoint pages in this section are generated from \`openapi/openapi.json\`.
That document is generated from \`src/contracts/schemas.ts\` and assembled by
\`src/contracts/openapi.ts\`, then
checked for drift by \`pnpm run openapi:check\`.

<Cards>
  <Card title="Application authentication" href="/docs/api/application-authentication/createAppAttestChallenge" description="App Attest registration and gateway token exchange." />
  <Card title="Provider proxy" href="/docs/api/provider-proxy/proxyProviderRequest" description="Provider-native requests and streaming responses." />
  <Card title="Admin applications" href="/docs/api/admin-applications/listApps" description="Create, validate, update, and delete tenant applications." />
  <Card title="Admin operations" href="/docs/api/admin-operations/listAppKeys" description="Keys, credentials, users, usage, and events." />
</Cards>
`);
