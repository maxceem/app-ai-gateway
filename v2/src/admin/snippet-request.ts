/**
 * An example request as a person reads and runs it: as a curl command, or
 * described line by line. Plain functions with no Worker code (`./app-snippet.ts`
 * builds the requests), so a test can run the commands in a real shell.
 *
 * A credential never becomes a process argument, and is never printed:
 *
 * - the command reads it from an environment variable and hands it to curl
 *   on stdin as a config line (`printf … | curl --config -`); `printf` is
 *   built into the shell, so the value never shows in the list of processes;
 * - it all runs in a subshell with tracing off (`( set +x …)`), so a shell
 *   run with `set -x` never prints a value;
 * - `--disable`, curl's first argument, stops it reading a `.curlrc`, which
 *   could turn on a trace that writes every header;
 * - a gateway token from an issuer exchange is kept in a variable of that
 *   subshell, used for the request after it, and never printed.
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
  /** A file sent as the form field `field`. */
  readonly file?: { readonly field: string; readonly name: string };
}

/** A credential a request sends in a header, read from an environment variable. */
export interface SnippetCredential {
  readonly header: string;
  /** What comes before the value, such as `Bearer`. */
  readonly scheme: string;
  readonly variable: string;
}

/**
 * Exchanging an app key and a user's issuer token, read from two environment
 * variables, for a gateway token, kept in the shell variable `into`.
 */
export interface TokenExchange {
  readonly url: string;
  readonly keyVariable: string;
  readonly tokenVariable: string;
  readonly into: string;
}

/** Text as one shell word: single-quoted, with any single quote closed, escaped and reopened. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** A printf that writes one curl config line, each `%s` filled from a variable, piped into curl with no `.curlrc`. */
function configPipe(line: string, variables: readonly string[]): string {
  return `printf ${shellWord(`${line}\\n`)} ${variables.map((name) => `"$${name}"`).join(" ")} | curl --disable`;
}

/** The request's own curl arguments after its URL: headers, body, form and file. */
function requestArguments(request: SnippetRequest): string[] {
  const lines: string[] = [];
  const sendsBody = request.body !== undefined || request.form !== undefined || request.file !== undefined;
  if (request.method !== "POST" || !sendsBody) lines.push(`-X ${request.method}`);
  for (const [name, value] of Object.entries(request.headers)) lines.push(`-H ${shellWord(`${name}: ${value}`)}`);
  if (request.body !== undefined) lines.push(`-d ${shellWord(JSON.stringify(request.body))}`);
  // --form-string: a value starting with @ or < is sent as text, never read as a file.
  for (const [name, value] of Object.entries(request.form ?? {})) lines.push(`--form-string ${shellWord(`${name}=${value}`)}`);
  if (request.file !== undefined) lines.push(`-F ${shellWord(`${request.file.field}=@${request.file.name}`)}`);
  return lines;
}

/**
 * The request as a curl command in an untraced subshell; the credential goes
 * in through stdin. With `exchange`, the subshell first exchanges for a
 * gateway token, keeps it in a variable, says only that it did, and sends the
 * request with it.
 */
export function curlCommand(request: SnippetRequest, credential: SnippetCredential, exchange?: TokenExchange): string {
  const send = [
    `${configPipe(`header = "${credential.header}: ${credential.scheme} %s"`, [credential.variable])} --config - ${shellWord(request.url)}`,
    ...requestArguments(request),
  ];
  if (exchange === undefined) return `( set +x; ${send.join(" \\\n  ")} )`;
  const token = [
    `${configPipe('data = {"api_key":"%s","issuer_token":"%s"}', [exchange.keyVariable, exchange.tokenVariable])} --silent --show-error --fail --config - ${shellWord(exchange.url)}`,
    `-H 'Content-Type: application/json'`,
    `| sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p'`,
  ].join(" ");
  return [
    "( set +x",
    `  ${exchange.into}="$(${token})"`,
    `  [ -n "$${exchange.into}" ] || { echo "The token exchange failed." >&2; exit 1; }`,
    `  echo "Exchanged the user's token for a gateway token." >&2`,
    `  ${send.join(" \\\n    ")} )`,
  ].join("\n");
}

/**
 * The request described for a person who sends it another way, such as an
 * iOS app with the Swift SDK: its method and URL, its headers, then its body
 * or what it uploads. `credential` says how the caller proves who it is.
 */
export function requestText(request: SnippetRequest, credential: string): string {
  const lines = [`${request.method} ${request.url}`];
  if (request.form !== undefined || request.file !== undefined) lines.push("Content-Type: multipart/form-data");
  for (const [name, value] of Object.entries(request.headers)) lines.push(`${name}: ${value}`);
  lines.push(credential);
  if (request.body !== undefined) lines.push("", JSON.stringify(request.body, null, 2));
  if (request.form !== undefined || request.file !== undefined) {
    lines.push("");
    for (const [name, value] of Object.entries(request.form ?? {})) lines.push(`${name}: ${value}`);
    if (request.file !== undefined) lines.push(`${request.file.field}: the file ${request.file.name}`);
  }
  return lines.join("\n");
}
