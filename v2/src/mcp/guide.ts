/**
 * What the MCP server tells an agent about itself: the short `instructions`
 * every client receives, and the long form served as the `agw://guide`
 * resource (v1's, rewritten for v2).
 *
 * Written here, not imported from the docs: an agent connected to a
 * self-hosted deployment may have no route to the published docs.
 */

export const MCP_INSTRUCTIONS = [
  "This server manages an App AI Gateway account: its AI provider connections, the apps that call providers through it, and their end users.",
  "Read before you write: call get_account first, and list or get a resource before proposing a change to it.",
  "Secrets never pass through a tool: a person enters a provider key, or sees a new app key, on a console page a tool answers.",
  "Read agw://guide for the full rules.",
].join(" ");

export const MCP_GUIDE_URI = "agw://guide";

export const MCP_GUIDE = `# Working with App AI Gateway over MCP

App AI Gateway sits between a person's apps and AI providers such as OpenAI,
Anthropic and Gemini. The person stores a provider key once, as a provider
connection, and every app reaches providers through the gateway with its own
sign-in, its own routing and its own limits on its users. This server lets you
read and manage that on the person's behalf.

## Who you are acting as

You connected with a credential that belongs to one account, and every tool
acts in that account only. What you may do is the credential owner's role in
the account and the credential's grant together: a \`read\` credential lists,
inspects and validates, and nothing more. Call \`get_account\` first. It names
the account, the person, their role and the grant.

## Reading

- \`get_account\`: who you are and the account you act in.
- \`list_models\`: the priced models an app may allow.
- \`list_provider_types\`: every provider type a connection can be added for, and its operations.
- \`list_providers\`, \`get_provider\`: the account's provider connections, as metadata.
- \`list_apps\`, \`get_app\`: the apps, and one app's whole stored document.
- \`validate_app\`: whether an app document would be accepted, without saving it.
- \`check_app\`: whether an app can serve requests, without sending one.
- \`list_app_keys\`: an app-key app's keys, as metadata.
- \`list_app_users\`, \`get_app_user\`: an app's end users and their usage.
- \`get_usage\`: a month's usage, for one app or the whole account.
- \`get_usage_breakdown\`, \`get_usage_timeseries\`: an app's usage by one dimension, or by day.
- \`list_app_charges\`: an app's charges one by one, kept 90 days.
- \`list_app_jobs\`: an app's jobs, and which estimates never settled.
- \`get_auth_event_summary\`: why an app's users cannot sign in or get answers, over the last days.
- \`list_auth_events\`, \`list_rejection_events\`: an app's sign-in attempts and refused requests one by one, kept 90 days.
- \`get_operation\`: where something a creating tool started stands.

## Changing

- \`patch_app\` changes a few settings of an app. \`update_app\` replaces its whole
  document. Both need the revision \`get_app\` returned: a change made by someone
  else since is refused, never overwritten. Check a document with
  \`validate_app\` before you send it. Build it from the app \`get_app\`
  returns by copying \`name\`, \`config\` and \`status\`, and add \`revision\`
  for \`update_app\`: \`id\`, \`created_at\` and \`updated_at\` are refused.
- \`update_provider\` renames a provider connection, changes its pricing, or
  disables it. Disabling pauses it and keeps its key.
- \`remove_app\` and \`remove_provider\` delete for good. Use them only when the
  person asked for the deletion, and pass the id twice, as the id and as
  \`confirm\`. Disabling is usually what the person wants.
- \`revoke_app_key\` revokes an app key for good.
- \`block_app_user\` and \`unblock_app_user\` block or lift a block on one end user.

## Creating

- \`add_provider\` and \`rotate_provider_key\` answer a console link. Give it
  to the person: they open it, enter the provider key there and approve. Then
  call \`get_operation\` with the answer's \`id\` until it completes. Never open
  the link yourself.
- \`add_app\` and \`add_app_key\` take two calls. The first, without
  \`handle\`, checks the request and reserves it: nothing is created. The
  second, with the same arguments and the answer's \`handle\`, creates it
  once. If you lose the second call's answer, send that call again within 15
  minutes: it repeats the answer instead of creating another. After that it is
  refused with \`already_completed\`: read \`get_operation\` with the
  operation's \`id\` for what was created, and check any \`notice\` about an
  identical request before reserving again, since a new reservation can create
  a duplicate. A new key is never in the answer: give the person
  \`reveal_url\`, where they see it once, signed in to the console.

## Secrets

No tool takes or returns a secret. A field named like a credential in your
arguments is refused, and one in a result is shown as \`[redacted]\`, except the
metadata of a key a create made. A key is entered or seen by the person, on a
console page. Never ask the person to paste a key to you.

## Human support

Where the deployment offers human support, \`contact_support\` emails its
support team on the person's behalf: \`kind\` is \`bug\`, \`support\` or
\`feedback\`. It is there so the person can ask you to write in for them; it
is not a way to ask for help yourself.

- Only when the person asked you to contact support. Show them the exact
  message first and send it only once they agree.
- Write it as they would: what happened, what they expected, what was tried.
  Put ids and error codes in \`context\` (\`app_id\`, \`request_id\`,
  \`error_code\`), and never a key, token or password.
- Support replies to the person's own email address. Tell them the reference.

## When a call is refused

A refusal is a tool result marked as an error, with a stable \`error\` code, a
\`message\` and \`next\`, which says what to do. A refused change saved nothing.
`;
