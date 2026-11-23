/**
 * `agw support send` (v1's, ported): a message to the deployment's human
 * support, from the person the connection belongs to. Support replies to
 * their email address.
 *
 * Written for an agent acting on a person's request as much as for the
 * person: nothing is sent without `--yes` or a typed confirmation, so an agent
 * has to have shown the person the message and been told to send it. The
 * gateway refuses a message that looks like it carries a credential, and
 * answers a repeat within ten minutes with the first reference instead of a
 * second email.
 */
import type { OperationResponse } from "../../src/contracts/catalog.ts";
import { SUPPORT_MESSAGE_MAX, SUPPORT_TOPICS, SupportMessageKindSchema, type SupportMessageKind } from "../../src/contracts/support.ts";
import { fail, VERSION } from "./common.ts";
import type { Context } from "./context.ts";
import { canPrompt, confirm, prompt } from "./input.ts";
import { flagList, type Flags } from "./parser.ts";

export type SupportResult = OperationResponse<"sendSupportMessage">;

export async function supportCommand(ctx: Context, flags: Flags, readStdin: () => Promise<string>): Promise<SupportResult> {
  const kind = supportKind(flags.type ?? (await prompt("Type (bug, support or feedback)", flags)));
  if (flags.message !== undefined && flags["message-stdin"]) fail("conflicting_flags", "--message and --message-stdin conflict.");
  const message = (flags["message-stdin"] ? await readStdin() : (flags.message ?? (await prompt("Message", flags)))).trim();
  if (!message) fail("invalid_input", "Supply a nonempty message.");
  if (message.length > SUPPORT_MESSAGE_MAX) fail("invalid_input", `The message is longer than ${SUPPORT_MESSAGE_MAX} characters.`);
  const context = supportContext(flagList(flags.context));

  if (!flags.yes) {
    // Without a terminal there is nobody to ask here: whoever runs the command
    // has to have asked the person already, and says so with --yes.
    if (!canPrompt(flags))
      fail(
        "confirmation_required",
        "Sending to human support needs confirmation.",
        "Show the person the exact message, and once they agree run the same command with --yes.",
      );
    ctx.say(preview(kind, message, context));
    await confirm("Send this to human support?", flags);
  }

  const { data } = await ctx.call("sendSupportMessage", {
    body: { kind, message, ...(Object.keys(context).length > 0 ? { context } : {}), client: `agw ${VERSION}` },
  });
  return data;
}

function supportKind(value: string): SupportMessageKind {
  const parsed = SupportMessageKindSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) fail("invalid_input", "--type must be bug, support or feedback.");
  return parsed.data;
}

/** `--context name=value`, repeatable, into the object the gateway takes. */
export function supportContext(entries: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at < 1 || at === entry.length - 1) fail("invalid_input", "--context takes name=value, such as --context app_id=my-app.");
    context[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return context;
}

/** What is about to be sent, exactly, written to stderr before the question. */
function preview(kind: SupportMessageKind, message: string, context: Record<string, string>): string {
  return [`To: human support (${SUPPORT_TOPICS[kind]})`, ...Object.entries(context).map(([name, value]) => `${name}: ${value}`), "", message, ""].join("\n");
}
