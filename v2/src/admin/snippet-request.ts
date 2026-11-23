/**
 * An example request as a person reads and runs it: as a curl command, or
 * described line by line. Plain functions with no Worker code (`./app-snippet.ts`
 * builds the requests), so a test can run the commands in a real shell.
 *
 * A credential never becomes a process argument, and is never logged:
 *
 * - the command reads it from an environment variable and hands it to curl
 *   on stdin as a config line (`printf … | curl --config -`); `printf` is
 *   built into the shell, so the value never shows in the list of processes;
 * - it runs in a subshell with tracing off (`( set +x; … )`), so a shell run
 *   with `set -x` never prints the value;
 * - `--disable`, curl's first argument, stops it reading a `.curlrc`, which
 *   could turn on a trace that writes every header.
 */

/** One request, without any credential. */
export interface SnippetRequest {
  readonly method: string;
  readonly url: string;
  /** Headers that hold no secret, such as the end user's or the content type. */
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body. */
  readonly body?: Readonly<Record<string, unknown>>;
  /** A form's text fields. */
  readonly form?: Readonly<Record<string, string>>;
  /** A file sent: as the form field `field`, or as the raw body when there is no field. */
  readonly file?: { readonly field?: string; readonly name: string; readonly type?: string };
  /** Where an answer that is a file is saved. */
  readonly output?: string;
}

/** A credential a request sends in a header, read from an environment variable. */
export interface SnippetCredential {
  readonly header: string;
  /** What comes before the value, such as `Bearer`. */
  readonly scheme: string;
  readonly variable: string;
}

/** Text as one shell word: single-quoted, with any single quote closed, escaped and reopened. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A printf that writes curl config lines, each `%s` filled from a variable,
 * piped into curl, opening a subshell with tracing off. `closeCommand` ends it.
 */
function configPipe(lines: string, variables: readonly string[]): string {
  return `( set +x; printf ${shellWord(`${lines}\\n`)} ${variables.map((name) => `"$${name}"`).join(" ")} | curl --disable --config -`;
}

/** The command's lines joined, the subshell closed after the last. */
function closeCommand(lines: readonly string[]): string {
  return `${lines.join(" \\\n  ")} )`;
}

/** The request as a curl command, one argument per line; the credential goes in through stdin. */
export function curlCommand(request: SnippetRequest, credential: SnippetCredential): string {
  const start = `${configPipe(`header = "${credential.header}: ${credential.scheme} %s"`, [credential.variable])} ${shellWord(request.url)}`;
  const lines = [start];
  const sendsBody = request.body !== undefined || request.form !== undefined || request.file !== undefined;
  if (request.method !== "POST" || !sendsBody) lines.push(`-X ${request.method}`);
  for (const [name, value] of Object.entries(request.headers)) lines.push(`-H ${shellWord(`${name}: ${value}`)}`);
  if (request.body !== undefined) lines.push(`-d ${shellWord(JSON.stringify(request.body))}`);
  // --form-string: a value starting with @ or < is sent as text, never read as a file.
  for (const [name, value] of Object.entries(request.form ?? {})) lines.push(`--form-string ${shellWord(`${name}=${value}`)}`);
  if (request.file !== undefined) {
    lines.push(request.file.field === undefined ? `--data-binary ${shellWord(`@${request.file.name}`)}` : `-F ${shellWord(`${request.file.field}=@${request.file.name}`)}`);
  }
  if (request.output !== undefined) lines.push(`--output ${shellWord(request.output)}`);
  return closeCommand(lines);
}

/**
 * The request described for a person who sends it another way, such as an
 * iOS app with the Swift SDK: its method and URL, its headers, then its body
 * or what it uploads. `credential` says how the caller proves who it is.
 */
export function requestText(request: SnippetRequest, credential: string): string {
  const lines = [`${request.method} ${request.url}`];
  if (request.form !== undefined || request.file?.field !== undefined) lines.push("Content-Type: multipart/form-data");
  for (const [name, value] of Object.entries(request.headers)) lines.push(`${name}: ${value}`);
  lines.push(credential);
  if (request.body !== undefined) lines.push("", JSON.stringify(request.body, null, 2));
  if (request.form !== undefined || request.file?.field !== undefined) {
    lines.push("");
    for (const [name, value] of Object.entries(request.form ?? {})) lines.push(`${name}: ${value}`);
    if (request.file?.field !== undefined) lines.push(`${request.file.field}: the file ${request.file.name}`);
  } else if (request.file !== undefined) {
    lines.push("", `The bytes of ${request.file.name}`);
  }
  return lines.join("\n");
}

/**
 * Exchanging an app key and a user's issuer token for a gateway token, as one
 * line, both read from variables and handed to curl on stdin.
 */
export function exchangeCommand(url: string, keyVariable: string, tokenVariable: string): string {
  return closeCommand([`${configPipe('data = {"api_key":"%s","issuer_token":"%s"}', [keyVariable, tokenVariable])} ${shellWord(url)}`, `-H 'Content-Type: application/json'`]);
}
