/**
 * How this deployment sends email, whichever way it is configured.
 *
 * Two transports stand behind one `send`: Cloudflare Email Service, through a
 * `send_email` binding named `EMAIL` (or any service binding with the same
 * `send`), and SMTP, through the `SMTP_*` settings, which works with any mail
 * provider and on the Workers Free plan. A deployment configures one of them;
 * one that configures both names the one to use in `EMAIL_SENDER`, so switching
 * is a single setting.
 *
 * Reading the configuration costs nothing — {@link emailSetup} only looks at
 * strings, which is what lets the deployment decide on every request whether
 * addresses are verified. The SMTP client is imported only when an email is
 * actually sent, so it is never on a proxied request's path.
 */

/** Which transport a deployment sends email with. */
export type EmailTransport = "cloudflare" | "smtp";

/** One email, in the shape both transports accept. */
export interface OutgoingEmail {
  /**
   * Also the envelope sender, so bounces and other delivery reports come back
   * to this mailbox, whatever `replyTo` says.
   */
  from: { email: string; name: string };
  /** Where a person's reply goes, when that is not `from`. */
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  readonly transport: EmailTransport;
  /** Hands the email to the transport; throws if it refused it. */
  send(email: OutgoingEmail): Promise<void>;
}

/**
 * The deployment's email configuration, read without sending anything.
 *
 * `off`: no transport configured, so nothing is verified. `misconfigured`: one
 * is meant to be (a binding, an SMTP host or `EMAIL_SENDER` is set) but cannot
 * send; addresses are still verified, so nothing quietly stops being checked,
 * and `problem` names the setting to fix — never a value. `ok`: ready to send.
 */
export type EmailSetup =
  | { state: "off" }
  | { state: "misconfigured"; problem: string }
  | {
      state: "ok";
      transport: EmailTransport;
      from: string;
      /** `EMAIL_REPLY_TO`, or null to let replies go to `from`. */
      replyTo: string | null;
      smtp: SmtpSettings | null;
    };

/** The SMTP settings once checked; the password stays where it is until a send. */
export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
}

/**
 * A bare `local@domain`, as `@maxceem/worker-mailer` accepts one: no display
 * name, brackets, whitespace or control characters. Kept the same as the
 * library's rule, rather than imported from it, so reading the configuration
 * never loads the library; an address it accepted here and the library then
 * refused would report `ok` while every send failed.
 */
const SENDER_ADDRESS = /^[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+@[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+$/;

/** Port 465 is TLS from the first byte; any other port must upgrade with STARTTLS. */
export const SMTP_TLS_PORT = 465;

const TRANSPORTS: readonly EmailTransport[] = ["cloudflare", "smtp"];

/**
 * Every SMTP setting. Setting any one of them means SMTP is intended, so a
 * deployment that set the password and forgot the host is told so, with
 * verification on, rather than read as one that sends no email at all.
 */
const SMTP_SETTINGS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD"] as const;

export function emailSetup(env: Env): EmailSetup {
  const binding = Boolean(env.EMAIL);
  const smtpHost = env.SMTP_HOST?.trim() ?? "";
  const smtpIntended = SMTP_SETTINGS.some((name) => Boolean(env[name]?.trim()));
  const chosen = env.EMAIL_SENDER?.trim().toLowerCase() ?? "";
  if (!binding && !smtpIntended && !chosen) return { state: "off" };

  if (chosen && !TRANSPORTS.includes(chosen as EmailTransport)) {
    return { state: "misconfigured", problem: "EMAIL_SENDER must be `cloudflare` or `smtp`" };
  }
  let transport: EmailTransport;
  if (chosen) transport = chosen as EmailTransport;
  else if (binding && smtpIntended) {
    return {
      state: "misconfigured",
      problem: "Both an EMAIL binding and SMTP settings are set: set EMAIL_SENDER to `cloudflare` or `smtp`",
    };
  } else transport = binding ? "cloudflare" : "smtp";

  let smtp: SmtpSettings | null = null;
  if (transport === "cloudflare") {
    if (!binding) return { state: "misconfigured", problem: "EMAIL_SENDER is `cloudflare` but there is no EMAIL binding" };
  } else {
    const checked = smtpSettings(env, smtpHost);
    if ("problem" in checked) return { state: "misconfigured", problem: checked.problem };
    smtp = checked;
  }

  const from = env.EMAIL_FROM?.trim();
  if (!from || !SENDER_ADDRESS.test(from)) {
    return { state: "misconfigured", problem: "EMAIL_FROM is missing or not an email address" };
  }
  const replyTo = env.EMAIL_REPLY_TO?.trim() || null;
  if (replyTo !== null && !SENDER_ADDRESS.test(replyTo)) {
    return { state: "misconfigured", problem: "EMAIL_REPLY_TO is not an email address" };
  }
  return { state: "ok", transport, from, replyTo, smtp };
}

function smtpSettings(env: Env, host: string): SmtpSettings | { problem: string } {
  if (!host) return { problem: "SMTP_HOST is not set" };
  const rawPort = env.SMTP_PORT?.trim() || String(SMTP_TLS_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { problem: "SMTP_PORT must be a port number, such as 465 or 587" };
  }
  // Workers cannot open port 25 at all, and it is not a submission port.
  if (port === 25) return { problem: "SMTP_PORT 25 is not available to Workers: use 465 or 587" };
  const username = env.SMTP_USERNAME?.trim();
  if (!username) return { problem: "SMTP_USERNAME is not set" };
  if (!env.SMTP_PASSWORD) return { problem: "SMTP_PASSWORD is not set" };
  return { host, port, username };
}

/** The sender to use, or null wherever the setup is not `ok`. */
export function emailSender(env: Env): EmailSender | null {
  const setup = emailSetup(env);
  if (setup.state !== "ok") return null;
  if (setup.transport === "cloudflare") {
    const binding = env.EMAIL!;
    return {
      transport: "cloudflare",
      send: async ({ replyTo, ...email }) => {
        await binding.send(replyTo ? { ...email, replyTo } : email);
      },
    };
  }
  const settings = setup.smtp!;
  return {
    transport: "smtp",
    send: (email) => sendSmtp(settings, env.SMTP_PASSWORD!, email),
  };
}

/**
 * One email over one SMTP connection: connect, sign in, send, close.
 *
 * Port 465 connects with TLS from the start; any other port upgrades with
 * STARTTLS, and the client refuses to sign in if the server does not offer it,
 * so the password never crosses an unencrypted connection. Its own logging is
 * off: at debug level it writes every line it sends, the sign-in among them,
 * and its errors quote addresses. Failures reach the caller as errors, which
 * `sendVerificationEmail` logs without them.
 */
async function sendSmtp(settings: SmtpSettings, password: string, email: OutgoingEmail): Promise<void> {
  const { WorkerMailer, LogLevel } = await import("@maxceem/worker-mailer");
  const tls = settings.port === SMTP_TLS_PORT;
  const mailer = await WorkerMailer.connect({
    host: settings.host,
    port: settings.port,
    secure: tls,
    startTls: !tls,
    credentials: { username: settings.username, password },
    authType: ["plain", "login", "cram-md5"],
    logLevel: LogLevel.NONE,
    socketTimeoutMs: 15_000,
    responseTimeoutMs: 15_000,
  });
  // Closed whatever happens to the send; closing twice is harmless.
  try {
    await mailer.send({
      from: { name: email.from.name, email: email.from.email },
      ...(email.replyTo ? { reply: email.replyTo } : {}),
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  } finally {
    await mailer.close().catch(() => {});
  }
}
