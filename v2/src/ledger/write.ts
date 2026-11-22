/**
 * Writing charges to the ledger (plan section 4.2, "Writing a charge").
 *
 * - A charge and its open-work rows are written in one D1 batch.
 * - Every insert is `ON CONFLICT(id) DO NOTHING`, never `INSERT OR IGNORE`:
 *   a retried write is skipped as a duplicate, but a row that breaks a CHECK
 *   still fails loudly instead of vanishing.
 * - The rollup trigger runs only for a row really inserted, so a retry never
 *   counts twice.
 * - If the D1 write fails, the rows go to the app's `ChargeStore`, which
 *   retries them. If that fails too, the full charge is logged as
 *   `usage_record_failed`, so it can still be recovered by hand.
 * - The request is never failed or delayed by any of this: callers run it
 *   after the response is sent.
 */
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { ON_TIME_SQL, onTimeCondition } from "./late-booking.ts";
import type { NanoDollars } from "../money.ts";
import type {
  ChargeKind,
  ChargeStatus,
  CorrectionKind,
  Measured,
  OpenWorkKind,
  OwnerType,
  PriceSource,
} from "./labels.ts";

/** One ledger row, as the code builds it. Column names are in `CHARGE_COLUMNS`. */
export interface ChargeRow {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly accountId: string;
  readonly appId: string;
  readonly endUserId: string | null;
  readonly installId: string | null;
  readonly appleAccountId: string | null;
  readonly appKeyId: string | null;
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly seq: number | null;
  readonly providerType: string;
  readonly providerConnectionId: string | null;
  readonly operation: string;
  readonly preset: string | null;
  readonly model: string | null;
  readonly status: ChargeStatus;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  /** NULL means nothing was billed, shown as "—". */
  readonly costNano: NanoDollars | null;
  readonly measured: Measured;
  readonly priceSource: PriceSource;
  readonly priceIsEstimate: boolean;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly unit: string | null;
  readonly units: number | null;
  /** Measures as integers, plus price keys such as `service_mode` as strings (D7). */
  readonly measures: Readonly<Record<string, number | string>>;
  readonly rates: Readonly<Record<string, number>> | null;
  readonly sessionMs: number | null;
  readonly correctionKind: CorrectionKind | null;
  readonly correctsChargeId: string | null;
  readonly latencyMs: number | null;
  readonly appVersion: string | null;
  readonly authMethod: string | null;
  readonly clientTraceId: string | null;
  readonly usedAt: number;
  readonly usageDay: string;
  readonly writtenAt: number;
}

export interface OpenWorkRow {
  readonly id: string;
  readonly kind: OpenWorkKind;
  readonly accountId: string;
  readonly appId: string;
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly chargeId: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly dueAt: number;
  readonly createdAt: number;
}

/** A charge and the open work written with it. */
export interface LedgerEntry {
  readonly charge: ChargeRow;
  readonly openWork: readonly OpenWorkRow[];
}

const CHARGE_COLUMNS: readonly (readonly [column: string, read: (row: ChargeRow) => unknown])[] = [
  ["id", (r) => r.id],
  ["kind", (r) => r.kind],
  ["account_id", (r) => r.accountId],
  ["app_id", (r) => r.appId],
  ["end_user_id", (r) => r.endUserId],
  ["install_id", (r) => r.installId],
  ["apple_account_id", (r) => r.appleAccountId],
  ["app_key_id", (r) => r.appKeyId],
  ["owner_type", (r) => r.ownerType],
  ["owner_id", (r) => r.ownerId],
  ["seq", (r) => r.seq],
  ["provider_type", (r) => r.providerType],
  ["provider_connection_id", (r) => r.providerConnectionId],
  ["operation", (r) => r.operation],
  ["preset", (r) => r.preset],
  ["model", (r) => r.model],
  ["status", (r) => r.status],
  ["http_status", (r) => r.httpStatus],
  ["error_code", (r) => r.errorCode],
  ["cost_nano", (r) => r.costNano],
  ["measured", (r) => r.measured],
  ["price_source", (r) => r.priceSource],
  ["price_is_estimate", (r) => (r.priceIsEstimate ? 1 : 0)],
  ["input_tokens", (r) => r.inputTokens],
  ["cached_input_tokens", (r) => r.cachedInputTokens],
  ["cache_write_tokens", (r) => r.cacheWriteTokens],
  ["output_tokens", (r) => r.outputTokens],
  ["unit", (r) => r.unit],
  ["units", (r) => r.units],
  ["measures_json", (r) => JSON.stringify(r.measures)],
  ["rates_json", (r) => (r.rates === null ? null : JSON.stringify(r.rates))],
  ["session_ms", (r) => r.sessionMs],
  ["correction_kind", (r) => r.correctionKind],
  ["corrects_charge_id", (r) => r.correctsChargeId],
  ["latency_ms", (r) => r.latencyMs],
  ["app_version", (r) => r.appVersion],
  ["auth_method", (r) => r.authMethod],
  ["client_trace_id", (r) => r.clientTraceId],
  ["used_at", (r) => r.usedAt],
  ["usage_day", (r) => r.usageDay],
  ["written_at", (r) => r.writtenAt],
];

/**
 * One charge, under the ledger's late-booking rule (`./late-booking.ts`): its
 * values, then the rule's two parameters. A WHERE clause also keeps SQLite
 * from reading ON CONFLICT as part of the SELECT.
 */
const INSERT_CHARGE = `INSERT INTO charge (${CHARGE_COLUMNS.map(([column]) => column).join(", ")})
  SELECT ${CHARGE_COLUMNS.map(() => "?").join(", ")} WHERE ${ON_TIME_SQL}
  ON CONFLICT(id) DO NOTHING`;

/**
 * An open-work row is written once: a row already there is never changed.
 *
 * - Work attached to a charge is written only with that charge's first
 *   insert: its statement runs before the charge's, in the same batch, and
 *   only while the charge is not there yet. So a replay of a batch that
 *   committed (a lost reply, retried from the failed-write store) never
 *   brings back work the sweep or a settlement has since ended.
 * - A job's row is not written once the job is settled (its
 *   `settle:job:<job>` correction exists).
 *
 * Work for an old owner may still be written: whatever it books later is a
 * charge row, which the late-booking rule judges (`./late-booking.ts`).
 */
const INSERT_OPEN_WORK = `INSERT INTO open_work
  (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?
  WHERE NOT (?5 = 'job' AND EXISTS (SELECT 1 FROM charge WHERE id = 'settle:job:' || ?6))
    AND (?7 IS NULL OR NOT EXISTS (SELECT 1 FROM charge WHERE id = ?7))
  ON CONFLICT(id) DO NOTHING`;

/** The statement that writes one open-work row, once: a row already there is never changed. */
function openWorkStatement(db: D1Database, work: OpenWorkRow): D1PreparedStatement {
  return db
    .prepare(INSERT_OPEN_WORK)
    .bind(
      work.id,
      work.kind,
      work.accountId,
      work.appId,
      work.ownerType,
      work.ownerId,
      work.chargeId,
      work.detail === null ? null : JSON.stringify(work.detail),
      work.dueAt,
      work.createdAt,
    );
}

/**
 * D1's count of rows a batch changed. It includes the rollup triggers' writes,
 * so it is not a count of charges; it is 0 when every row was a repeat whose
 * first write had committed.
 */
function rowsWritten(results: readonly D1Result[]): number {
  return results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
}

/** Writes open-work rows that have no charge (a job's saved figure); returns D1's count of rows changed. Throws when D1 cannot take them. */
export async function writeOpenWork(db: D1Database, rows: readonly OpenWorkRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return rowsWritten(await db.batch(rows.map((row) => openWorkStatement(db, row))));
}

/** The statements that write some entries at `now`, in one batch. */
export function ledgerStatements(db: D1Database, entries: readonly LedgerEntry[], now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const { charge, openWork } of entries) {
    // The work first: it is written only while its charge is not there yet (see INSERT_OPEN_WORK).
    for (const work of openWork) statements.push(openWorkStatement(db, work));
    statements.push(insertChargeStatement(db, charge, now));
  }
  return statements;
}

/**
 * Writes entries to D1 in one batch, at `now`: the time they are written,
 * which judges a replayed entry by its replay (`./late-booking.ts`). Returns
 * D1's count of rows changed, rollups included: 0 when all were repeats.
 * Throws if D1 refuses or fails.
 */
export async function writeToLedger(db: D1Database, entries: readonly LedgerEntry[], now: number): Promise<number> {
  if (entries.length === 0) return 0;
  return rowsWritten(await db.batch(ledgerStatements(db, entries, now)));
}

/** How long `recordLedgerEntry` waits for D1 before the entry goes to the failed-write store. */
export const LEDGER_D1_DEADLINE_MS = 5_000;

/** The UTC day of a time, `YYYY-MM-DD`. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Records an entry: D1 first, then the app's store, then the logs. Never
 * throws. Run it after the response is sent.
 */
export async function recordLedgerEntry(env: Env, entry: LedgerEntry): Promise<void> {
  try {
    // A D1 write that stalls must not outlast the request's waitUntil window:
    // past the deadline the entry (its charge and its open work, together) goes
    // to the store too. Its ids are stable, so a late D1 commit is harmless.
    await withDeadline(writeToLedger(env.DB, [entry], Date.now()), LEDGER_D1_DEADLINE_MS, "writing the charge");
    return;
  } catch (error) {
    log("warn", "ledger_write_failed", { app: entry.charge.appId, charge: entry.charge.id, error: errorFacts(error) });
  }
  try {
    await env.CHARGE_STORE.getByName(entry.charge.appId).keep([entry]);
    return;
  } catch (error) {
    logLostEntry(entry, error);
  }
}

/** The last resort: the whole charge in the logs, so it can be written by hand. Never a secret. */
export function logLostEntry(entry: LedgerEntry, error: unknown): void {
  log("error", "usage_record_failed", {
    app: entry.charge.appId,
    charge: entry.charge as unknown as Record<string, unknown>,
    openWork: entry.openWork as unknown as Record<string, unknown>[],
    error: errorFacts(error),
  });
}

/** A charge row read from D1 (`SELECT * FROM charge`), as the code builds it. */
export function chargeFromRow(row: Record<string, unknown>): ChargeRow {
  const text = (column: string) => (row[column] === null || row[column] === undefined ? null : String(row[column]));
  const num = (column: string) => (row[column] === null || row[column] === undefined ? null : Number(row[column]));
  const json = <T>(column: string): T | null => {
    const value = row[column];
    return typeof value === "string" ? (JSON.parse(value) as T) : null;
  };
  return {
    id: String(row.id),
    kind: row.kind as ChargeKind,
    accountId: String(row.account_id),
    appId: String(row.app_id),
    endUserId: text("end_user_id"),
    installId: text("install_id"),
    appleAccountId: text("apple_account_id"),
    appKeyId: text("app_key_id"),
    ownerType: row.owner_type as OwnerType,
    ownerId: String(row.owner_id),
    seq: num("seq"),
    providerType: String(row.provider_type),
    providerConnectionId: text("provider_connection_id"),
    operation: String(row.operation),
    preset: text("preset"),
    model: text("model"),
    status: row.status as ChargeStatus,
    httpStatus: num("http_status"),
    errorCode: text("error_code"),
    costNano: num("cost_nano") as NanoDollars | null,
    measured: row.measured as Measured,
    priceSource: row.price_source as PriceSource,
    priceIsEstimate: Boolean(row.price_is_estimate),
    inputTokens: num("input_tokens"),
    cachedInputTokens: num("cached_input_tokens"),
    cacheWriteTokens: num("cache_write_tokens"),
    outputTokens: num("output_tokens"),
    unit: text("unit"),
    units: num("units"),
    measures: json<Record<string, number | string>>("measures_json") ?? {},
    rates: json<Record<string, number>>("rates_json"),
    sessionMs: num("session_ms"),
    correctionKind: (row.correction_kind ?? null) as CorrectionKind | null,
    correctsChargeId: text("corrects_charge_id"),
    latencyMs: num("latency_ms"),
    appVersion: text("app_version"),
    authMethod: text("auth_method"),
    clientTraceId: text("client_trace_id"),
    usedAt: Number(row.used_at),
    usageDay: String(row.usage_day),
    writtenAt: Number(row.written_at),
  };
}

/** One charge by id, or null. */
export async function readCharge(db: D1Database, id: string): Promise<ChargeRow | null> {
  const row = await db.prepare("SELECT * FROM charge WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row === null ? null : chargeFromRow(row);
}

/** The statement that inserts one charge at `now`, `ON CONFLICT(id) DO NOTHING`, under the late-booking rule. */
export function insertChargeStatement(db: D1Database, charge: ChargeRow, now: number): D1PreparedStatement {
  return db.prepare(INSERT_CHARGE).bind(...CHARGE_COLUMNS.map(([, read]) => read(charge)), ...onTimeCondition(charge, now).params);
}

/**
 * The statement that inserts one charge whose cost is a SQL expression, such
 * as a difference worked out from other rows in the same batch. `cost` is a
 * SQL fragment with its own parameters, `costParams`, bound in place of the
 * `cost_nano` value. The row is skipped if its id exists, or if it is too
 * late to write at `now` (`./late-booking.ts`).
 */
export function insertChargeWithCostStatement(
  db: D1Database,
  charge: ChargeRow,
  now: number,
  cost: string,
  costParams: readonly unknown[],
  /** A SQL condition the row is inserted under, with its parameters. */
  where: { readonly sql: string; readonly params: readonly unknown[] } = { sql: "true", params: [] },
): D1PreparedStatement {
  const placeholders: string[] = [];
  const params: unknown[] = [];
  for (const [column, read] of CHARGE_COLUMNS) {
    if (column === "cost_nano") {
      placeholders.push(`(${cost})`);
      params.push(...costParams);
    } else {
      placeholders.push("?");
      params.push(read(charge));
    }
  }
  const onTime = onTimeCondition(charge, now);
  // A WHERE clause also keeps SQLite from reading ON CONFLICT as part of the SELECT.
  return db
    .prepare(
      `INSERT INTO charge (${CHARGE_COLUMNS.map(([column]) => column).join(", ")})
       SELECT ${placeholders.join(", ")} WHERE (${where.sql}) AND ${onTime.sql}
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(...params, ...where.params, ...onTime.params);
}
