import type { Bootstrap, Generation } from './types';
import type { UsageEvent } from '../usage/usage-record';
export interface OutboxItem { id: string; event: UsageEvent; attempts: number; due: number; createdAt: number }
export type RecoveryTaskName = 'release:user' | 'release:app' | 'admission';
export interface RecoveryTask { attempts: number; due: number; complete: boolean; expiresAt?: number }
function retryAt(attempts: number): number { return Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 12)); }
/** Only identifiers, counters, prices and outcomes. Never persist socket input or credentials. */
export class SessionJournal {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_metadata (singleton INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_outbox (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }
  metadata(): Bootstrap | null {
    const row = this.storage.sql.exec<{ json: string }>('SELECT json FROM session_metadata WHERE singleton = 1').toArray()[0];
    return row ? JSON.parse(row.json) as Bootstrap : null;
  }
  open(metadata: Bootstrap): void {
    this.storage.sql.exec('INSERT INTO session_metadata VALUES (1, ?)', JSON.stringify(metadata));
  }
  save(generation: Generation): void {
    this.storage.sql.exec('INSERT INTO generations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', generation.id, JSON.stringify(generation));
  }
  generations(): Generation[] {
    return this.storage.sql.exec<{ json: string }>('SELECT json FROM generations').toArray().map(row => JSON.parse(row.json) as Generation);
  }
  settle(generation: Generation, event: UsageEvent): void {
    this.storage.transactionSync(() => {
      generation.stage = 'settled';
      generation.event = event;
      this.save(generation);
      const item: OutboxItem = { id: event.eventId, event, attempts: 0, due: Date.now(), createdAt: Date.now() };
      this.storage.sql.exec('INSERT INTO usage_outbox VALUES (?, ?) ON CONFLICT(id) DO NOTHING', item.id, JSON.stringify(item));
    });
  }
  outbox(): OutboxItem[] {
    return this.storage.sql.exec<{ json: string }>('SELECT json FROM usage_outbox').toArray().map(row => JSON.parse(row.json) as OutboxItem);
  }
  acknowledged(id: string): void { this.storage.sql.exec('DELETE FROM usage_outbox WHERE id = ?', id); }
  task(id: RecoveryTaskName): RecoveryTask {
    const row = this.storage.sql.exec<{ json: string }>('SELECT json FROM recovery_tasks WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.json) as RecoveryTask : { attempts: 0, due: 0, complete: false };
  }
  saveTask(id: RecoveryTaskName, task: RecoveryTask): void {
    this.storage.sql.exec('INSERT INTO recovery_tasks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', id, JSON.stringify(task));
  }
  retryTask(id: RecoveryTaskName, task: RecoveryTask): void {
    task.attempts++; task.due = retryAt(task.attempts); this.saveTask(id, task);
  }
  retry(item: OutboxItem): void {
    item.attempts++;
    item.due = retryAt(item.attempts);
    this.storage.sql.exec('UPDATE usage_outbox SET json = ? WHERE id = ?', JSON.stringify(item), item.id);
  }
}
