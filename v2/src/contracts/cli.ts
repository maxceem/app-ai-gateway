/**
 * The CLI's tool catalog: the MCP tools as `agw` builds its commands from
 * them, and a call of one (v1's contract, ported). Plain `zod`, so the CLI can
 * import it.
 *
 * Keep it additive, like any contract with installed clients: every field is
 * optional where a CLI may meet it new, and the objects are not strict, so a
 * CLI built before a field existed ignores it.
 */
import { z } from "zod";

/**
 * How `agw` presents one tool's result: a table of the rows at one path, or
 * the fields of the object at one. Paths and keys are dotted; `key=Label`
 * names a column, and `$1`, `$2` are the keys a `*` in `rows` matched.
 */
export const CliToolViewSchema = z.object({
  /** The array a table shows, one row per item; empty for the result itself. */
  rows: z.string().optional(),
  /** The object whose fields are shown one per line; empty for the result itself. */
  record: z.string().optional(),
  /** The keys of each row, or of the record, in this order. */
  columns: z.array(z.string()).optional(),
  /** Lists shown after the table or the fields, one line per entry. */
  notes: z.array(z.string()).optional(),
  /** An object shown whole, as indented JSON, after everything else. */
  document: z.string().optional(),
  /**
   * Text shown as it is, line breaks kept, last: a command to copy, say. Each
   * path names a string, or with `*` every string it reaches.
   */
  blocks: z.array(z.string()).optional(),
  /** Columns shown whole rather than cut to fit the table, by key: a list a person needs in full. */
  wide: z.array(z.string()).optional(),
});

/**
 * Characters no command or request an example shows may hold: control
 * characters, Unicode format characters (such as a zero-width joiner) and
 * halves of a surrogate pair, any of which a terminal or a reader could take
 * for something else. The gateway writes no command holding one (only a
 * note), and `agw` shows none it is sent, rather than rewrite it. A line
 * break between a command's lines is the one exception.
 */
export const UNSAFE_COMMAND_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Where a tool sits among `agw`'s commands, decided by the gateway so a CLI never needs a release to learn one. */
export const CliToolHintSchema = z.object({
  /** The command words, such as `app show`. */
  command: z.string().min(1),
  /** One line for `agw --help`, where the tool's title would read wrong beside its command. */
  summary: z.string().optional(),
  /** The input fields taken as positional arguments, in order. */
  args: z.array(z.string()).optional(),
  /** For a deletion that names what it deletes twice: the field the CLI repeats as `confirm` once the person agreed. */
  confirm: z.string().optional(),
  /** Input fields that are shorthands for a deeper setting, listed first in help. */
  shortcuts: z.array(z.string()).optional(),
  /** Features of the CLI the command cannot work without. A CLI that lacks one leaves the command out. */
  requires: z.array(z.string()).optional(),
  view: CliToolViewSchema.optional(),
});

export const CliToolSchema = z
  .object({
    /** The tool's MCP name, which `POST /v2/cli/tools/{tool}` runs. */
    name: z.string(),
    title: z.string(),
    description: z.string(),
    /** The JSON Schema of the tool's input, as MCP `tools/list` advertises it. */
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.object({
      readOnlyHint: z.boolean(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean(),
      openWorldHint: z.boolean(),
    }),
    cli: CliToolHintSchema,
    /**
     * A digest of what makes running the tool safe: whether it destroys, and
     * what it needs of the CLI. Sent back in `Agw-Tool-Guard`.
     */
    guard: z.string().optional(),
  })
  .meta({ id: "CliTool" });

export const CliToolCatalogResponseSchema = z
  .object({
    /** Changes whenever anything listed here does. Every tool call answers with it in `Agw-Tools-Revision`. */
    revision: z.string(),
    tools: z.array(CliToolSchema),
  })
  .meta({ id: "CliToolCatalogResponse" });

/** A tool call's arguments: the same object an MCP `tools/call` carries. */
export const CliToolCallRequestSchema = z.record(z.string(), z.unknown()).meta({ id: "CliToolCallRequest" });

export const CliToolCallResponseSchema = z
  .object({
    tool: z.string(),
    /** One or two sentences about the result, as MCP returns them beside it. */
    summary: z.string(),
    /** The tool's structured result, as MCP returns it. */
    result: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "CliToolCallResponse" });

export type CliTool = z.infer<typeof CliToolSchema>;
export type CliToolHint = z.infer<typeof CliToolHintSchema>;
export type CliToolCatalogResponse = z.infer<typeof CliToolCatalogResponseSchema>;
export type CliToolCallResponse = z.infer<typeof CliToolCallResponseSchema>;
