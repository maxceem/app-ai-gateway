/**
 * What the MCP server tells an agent about itself: the short `instructions`
 * every client receives with the server's identity, and the long form served
 * as the `agw://guide` resource.
 *
 * Written here, not imported from `docs/`: the Worker never bundles the
 * documentation site, and an agent connected to a self-hosted deployment may
 * have no route to the published docs at all.
 */

export const MCP_INSTRUCTIONS = [
  "This server manages an App AI Gateway account: the AI provider credentials it holds, the apps that call providers through it, their end users, and their usage.",
  "Read before you write: call get_account first, and list or get a resource before proposing a change to it.",
  "Secrets never pass through a tool: provider keys are entered by a person in a browser, and an app key is only ever revealed on a browser page.",
  "A change hands back an operation you poll with get_operation until it completes.",
  "An unclaimed account expires unless a person claims it; get_account says so, and claim_account starts the claim.",
  "Read agw://guide for the full rules.",
].join(" ");

export const MCP_GUIDE_URI = "agw://guide";

export const MCP_GUIDE = `# Working with App AI Gateway over MCP

App AI Gateway sits between a person's applications and AI providers such as
OpenAI, Anthropic and Gemini. The person stores a provider credential once,
and every app they create reaches providers through the gateway with its own
authentication, its own routing and its own limits on its users. This server
lets you read and, as it grows, manage all of that on the person's behalf.

## Who you are acting as

You connected with a credential that belongs to one account, and every tool
acts in that account only. What you may do is the credential's owner's role in
the account and the credential's grant together: a \`read\` credential lists,
inspects and validates, and nothing more. Call \`get_account\` first. It names
the account and the deployment, and says whether the account has a person as
its owner.

On a hosted deployment, an account nobody has claimed yet is temporary: its
free access ends thirty days after it was created, and the account is deleted
when its recovery deadline passes, unless a person claims it. When
\`get_account\` reports an unclaimed account, tell the person, and use \`claim_account\` to start the
claim: it returns a URL the person opens in their own browser. Never open that
URL yourself or act as the person approving it.

## Reading

- \`get_account\`, \`get_capabilities\` — the account, and what the deployment supports.
- \`list_models\` — the priced models an app may allow.
- \`list_providers\`, \`get_provider\`, \`list_provider_gateways\` — the provider
  credentials and provider gateways the account holds, as metadata.
- \`list_apps\`, \`get_app\` — the apps, and one app's whole stored document.
- \`validate_app\` — whether an app document would be accepted, without saving it.
- \`check_app\` — whether an app can serve requests, without sending one.
- \`get_app_snippet\` — the first request an app can send.
- \`list_app_keys\` — a server app's keys, as metadata.
- \`list_app_users\`, \`get_app_user\` — an app's end users.
- \`list_app_events\`, \`list_auth_events\`, \`get_auth_event_summary\`,
  \`list_rejection_events\` — what an app's traffic did, and why requests or
  sign-ins were refused.
- \`get_usage\`, \`get_usage_breakdown\`, \`get_usage_timeseries\` — usage and
  cost, for the account or one app.

Every app tool takes the app's id as \`app\`; \`list_apps\` returns them. Lists
of events are newest first and page backwards: pass the \`next_before_id\` of
one answer as \`before_id\` to the next call. Months are \`YYYY-MM\` and days
\`YYYY-MM-DD\`, in UTC.

## Changing things

Read before you write. List providers and apps first so you use slugs and ids
that exist, read an app with \`get_app\` before proposing a change to it, and
check the change with \`validate_app\` before making it. An app document is
\`{name, config, status?}\`, as \`get_app\` returns it without its id and
revision; the gateway assigns an app's id, which never changes, and an update carries the \`revision\` it was read at, so a document
someone changed since is refused rather than overwritten.

A change is an operation. The tool that asks for it returns the operation, and
\`get_operation\` reports when it has completed. Anything that needs a secret
or a person's approval completes in a browser: the tool returns a URL, you give
it to the person, and you poll \`get_operation\` while they finish. Prefer
reversible changes: disable an app or a provider rather than deleting it unless
the person asked for the deletion.

## Secrets

No secret ever passes through a tool, in either direction. A provider
credential is typed by the person into a browser page, never given to you and
never accepted as a tool argument. A server app's key is revealed once, on a
browser page; tools return only its metadata. Never ask the person to paste a
secret into the conversation, and never print one you come across.

## Errors

A refusal is a tool result marked as an error, not a protocol failure. Its
text is \`<code>: <message>. <what to do next>\`, and its structured content is
\`{error, message, status, next}\`. The code is the gateway's own and stable:
\`app_not_found\` means the id is not one of the account's apps, \`invalid_request\`
means the arguments break a rule the message names, and \`grant_insufficient\`
means the credential may read but not change. \`next\` names the tool to call or
the browser step to take. An \`internal_error\` is the gateway's failure, not
yours; try again later.

## Rules

1. Never send a request through an app to test it unless the person asks:
   every one reaches a provider and costs them money. \`check_app\` and
   \`get_app_snippet\` send nothing.
2. Changes take up to a minute to reach live traffic.
3. Report what you did with ids and names, never with a credential.
`;
