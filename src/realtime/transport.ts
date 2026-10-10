import { REALTIME_LIMITS } from './limits';
/** Orders async effects without blocking immediate termination controls. */
export class Mailbox {
  private queue: { bytes: number; run: () => Promise<void> }[] = [];
  private bytes = 0;
  private draining: Promise<void> | null = null;
  constructor(private overflow: () => void, private failure: (error: unknown) => void) {}
  push(bytes: number, run: () => Promise<void>): Promise<void> {
    if (this.queue.length >= REALTIME_LIMITS.queuedEvents || this.bytes + bytes > REALTIME_LIMITS.queuedBytes) {
      this.overflow(); return this.draining ?? Promise.resolve();
    }
    this.queue.push({ bytes, run }); this.bytes += bytes;
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null; });
    return this.draining;
  }
  /** Shutdown must remain ordered even when the normal frame queue is full. */
  afterDrain(run: () => Promise<void>): Promise<void> { return (this.draining ?? Promise.resolve()).then(run); }
  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queue.shift(); if (!next) return;
      // Includes the currently processed frame in the byte bound across awaits.
      try { await next.run(); } catch (error) { this.failure(error); }
      finally { this.bytes -= next.bytes; }
    }
  }
}
export function send(socket: WebSocket | null, value: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
export function close(socket: WebSocket | null, code: number): void {
  try { socket?.close(code, 'Realtime session closed'); } catch { /* already closed */ }
}
export function frameBytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
