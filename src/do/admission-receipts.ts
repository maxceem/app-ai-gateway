/** Eight days cover the seven-day usage recovery horizon and cleanup margin. */
const RETENTION_MS = 8 * 86_400_000;
export class AdmissionReceipts {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS admission_receipts (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS receipt_expiry ON admission_receipts(expires_at);`);
  }
  read<T>(id: string, fingerprint?: string): T | null {
    const row = this.sql.exec<{ fingerprint: string; result: string }>(
      'SELECT fingerprint, result FROM admission_receipts WHERE id = ?', id,
    ).toArray()[0];
    if (!row) return null;
    if (fingerprint !== undefined && fingerprint !== row.fingerprint) throw new Error('Admission receipt mismatch');
    return JSON.parse(row.result) as T;
  }
  save(id: string, fingerprint: string, result: unknown): void {
    this.sql.exec('DELETE FROM admission_receipts WHERE id IN (SELECT id FROM admission_receipts WHERE expires_at < ? LIMIT 64)', Date.now());
    this.sql.exec('INSERT INTO admission_receipts VALUES (?, ?, ?, ?)', id, fingerprint, JSON.stringify(result), Date.now() + RETENTION_MS);
  }
}
