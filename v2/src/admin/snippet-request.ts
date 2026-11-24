/**
 * An example request as a person reads and runs it: as a curl command, or
 * described line by line. Plain functions with no Worker code (`./app-snippet.ts`
 * builds the requests), so a test can run the commands in a real shell.
 *
 * The commands take the form provider docs use: the key in a header, read
 * from an environment variable (`-H "Authorization: Bearer $APP_AI_GATEWAY_KEY"`).
 * How a person keeps their own key on the machine that runs the command is
 * theirs to decide (owner decision). An issuer app's example first exchanges
 * the key and the user's token, both from environment variables, for a
 * gateway token, kept in a shell variable for the request after it.
 *
 * Every value the app's settings control (a URL, a model, a header) is one
 * single-quoted shell word, so none of it runs as shell code.
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
 * The request as a curl command, the credential in a header from its
 * environment variable. The header's name and scheme are the gateway's own
 * constants, so the double quotes, which let the variable expand, hold
 * nothing else. With `exchange`, a command before it exchanges for a gateway
 * token and keeps it in a variable, which the request then sends.
 */
export function curlCommand(request: SnippetRequest, credential: SnippetCredential, exchange?: TokenExchange): string {
  const send = [
    `curl ${shellWord(request.url)}`,
    `-H "${credential.header}: ${credential.scheme} $${credential.variable}"`,
    ...requestArguments(request),
  ].join(" \\\n  ");
  if (exchange === undefined) return send;
  const token = [
    `curl --silent --show-error --fail ${shellWord(exchange.url)}`,
    `-H 'Content-Type: application/json'`,
    `-d "{\\"api_key\\":\\"$${exchange.keyVariable}\\",\\"issuer_token\\":\\"$${exchange.tokenVariable}\\"}"`,
    `| sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p'`,
  ].join(" \\\n    ");
  return `${exchange.into}="$(${token})"\n${send}`;
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
