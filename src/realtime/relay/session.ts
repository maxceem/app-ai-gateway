import { RelayError } from "./errors";
import { log } from "./log";
import { REALTIME_LIMITS as L, REALTIME_MAX_SESSION_SECONDS } from "./limits";
import { SessionJournal } from "./journal";
import { Mailbox, close, frameBytes, send } from "./transport";
import { protocolAdapter } from "./protocols";
import { id, object, invalid } from "./protocols/validation";
import type { Bootstrap, CompletionStatus, SessionGrant, Settlement } from "./contract";
import type { AdapterEffect, Generation, JsonObject, ProtocolAdapter } from "./types";
import type { SessionBackend } from "./backend";

/**
 * One realtime session: the app's socket, the provider's socket, and the
 * frames between them.
 *
 * Everything the gateway decides comes from its {@link SessionGrant}, which
 * the gateway sends again at each check: the provider to call, the limits, and
 * whether the session may go on. This class enforces the frame rules and keeps
 * the journal that makes usage survive a restart. It prices nothing and reads
 * no app settings, so it changes only when those two jobs do.
 */
export class SessionCoordinator {
  /** Held in memory only: it carries the provider credential. */
  private grant: SessionGrant | null = null;
  /** A refusal the gateway gave for a response already sent; it ends the session at its next idle moment. */
  private refusal: RelayError | null = null;
  private adapter: ProtocolAdapter | null = null;
  private client: WebSocket | null = null;
  private upstream: WebSocket | null = null;
  private active: Generation | null = null;
  private ready = false;
  private configuring = true;
  private terminating = false;
  private closed = false;
  private cleaned = false;
  private ordinal = 0;
  private inputBytes = 0;
  private inputStarted: number | null = null;
  /** Client bytes still allowed now: refilled at a steady rate, up to a burst. */
  private clientAllowance: number = L.clientBurstBytes;
  private clientAllowanceAt = Date.now();
  private lastActivity = Date.now();
  private openedAt = Date.now();
  private expiresAt = 0;
  private nextMaintenance = Date.now() + L.revalidateMs;
  private leaseExpiry = 0;
  private pendingAuto: Extract<AdapterEffect, { kind: "pendingAuto" }> | null = null;
  private generationIds = new Map<string, string>();
  private recentIds = new Map<string, string>();
  private terminalResponses = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private configurationAt = Date.now();
  private alarmDue: number | null = null;
  private maintenance: Promise<void> | null = null;
  private flushing: Promise<boolean> | null = null;
  private flushAgain = false;
  private releasing: Promise<void> | null = null;
  private shuttingDown: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private drainUntil = 0;
  private deferredInitial: JsonObject | null = null;
  private mailbox: Mailbox;
  private authHeaders: Headers;
  readonly journal: SessionJournal;

  constructor(
    private backend: SessionBackend,
    private ctx: DurableObjectState,
    readonly bootstrap: Bootstrap,
    headers: Headers,
  ) {
    this.authHeaders = new Headers(headers);
    this.journal = new SessionJournal(ctx.storage);
    this.mailbox = new Mailbox(
      () => this.terminate(new RelayError(413, "payload_too_large", "Realtime queue limit exceeded"), 1009),
      error => this.fail(error),
    );
  }

  private live(): boolean {
    return !this.terminating
      && !this.closed
      && Date.now() < this.expiresAt
      && Date.now() < this.leaseExpiry - L.leaseSafetyMs;
  }

  async start(testUpstream?: WebSocket): Promise<Response> {
    if (this.journal.metadata()) {
      throw new RelayError(409, "conflict", "A realtime object cannot be reopened");
    }
    const grant = await this.backend.grant(this.bootstrap, this.authHeaders, null);
    this.grant = grant;
    this.openedAt = Date.now();
    this.lastActivity = this.openedAt;
    const maxSessionSeconds = Math.min(grant.maxSessionSeconds, REALTIME_MAX_SESSION_SECONDS);
    this.expiresAt = Math.min(
      this.openedAt + maxSessionSeconds * 1000,
      this.bootstrap.identity.expiresAt ?? Infinity,
    );
    this.journal.open(this.bootstrap);
    let finishStarting!: () => void;
    this.starting = new Promise<void>(resolve => {
      finishStarting = resolve;
    });
    try {
      // Schedule crash recovery before external effects. Leases expire independently in their owners.
      await this.ctx.storage.setAlarm(this.openedAt + L.setupMs);
      this.requireStarting();
      const user = await this.backend.capacity(
        this.bootstrap,
        "user",
        "acquire",
        grant.maxSessionsPerIdentity,
      );
      if (!user.allowed) {
        throw new RelayError(429, "realtime_session_limit", "Realtime identity capacity exceeded");
      }
      this.requireStarting();
      const application = await this.backend.capacity(
        this.bootstrap,
        "app",
        "acquire",
        grant.maxSessions,
      );
      if (!application.allowed) {
        throw new RelayError(429, "realtime_session_limit", "Realtime app capacity exceeded");
      }
      this.leaseExpiry = Math.min(user.expiresAt, application.expiresAt);
      this.requireStarting();
      this.adapter = protocolAdapter(grant.protocol, grant.model, grant.outputCap, this.bootstrap.requestedModel);
      if (testUpstream) {
        this.upstream = testUpstream;
      } else {
        const request = new Request(grant.upstream.url, { headers: grant.upstream.headers, redirect: "manual" });
        // The deadline bounds the upgrade only: the socket stays bound to the
        // signal it was opened with, so a timeout signal would close it later.
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), L.setupMs);
        let response: Response;
        try {
          response = await fetch(request, { signal: deadline.signal });
        } finally {
          clearTimeout(timer);
        }
        if (response.status !== 101 || !response.webSocket) {
          throw new RelayError(502, "provider_error", "Realtime provider upgrade failed");
        }
        this.upstream = response.webSocket;
      }
      this.upstream.accept({ allowHalfOpen: true });
      this.requireStarting();
      const pair = new WebSocketPair();
      this.client = pair[1];
      this.client.accept({ allowHalfOpen: true });
      this.attach(this.client, "client");
      this.attach(this.upstream, "server");
      this.configurationAt = Date.now();
      // Cloudflare AI Gateway drops a socket written to before the provider has
      // spoken, so there the configuration waits for the provider's first event.
      const initial = this.adapter.initial();
      if (!grant.waitForProvider) {
        if (initial) send(this.upstream, initial);
      } else {
        this.deferredInitial = initial;
      }
      await this.schedule();
      this.requireStarting();
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "x-gateway-session-id": this.bootstrap.sessionId },
      });
    } catch (error) {
      this.terminating = true;
      close(this.client, 1011);
      close(this.upstream, 1011);
      this.closed = true;
      await this.release();
      await this.schedule();
      throw error;
    } finally {
      finishStarting();
      this.starting = null;
    }
  }

  private requireStarting(): void {
    if (
      this.terminating
      || this.closed
      || Date.now() >= this.expiresAt
      || Date.now() >= this.openedAt + L.setupMs
    ) {
      throw new RelayError(504, "provider_error", "Realtime setup expired");
    }
  }

  /**
   * Turn bounds count only what a turn's input is; silence streamed under VAD
   * is not. This bounds everything a client sends, so no frame type can push
   * the provider connection faster than a live microphone would.
   */
  private allowClient(bytes: number): boolean {
    const now = Date.now();
    const refilled = this.clientAllowance + (now - this.clientAllowanceAt) * L.clientBytesPerSecond / 1000;
    this.clientAllowance = Math.min(L.clientBurstBytes, refilled);
    this.clientAllowanceAt = now;
    if (bytes > this.clientAllowance) return false;
    this.clientAllowance -= bytes;
    return true;
  }

  private attach(socket: WebSocket, source: "client" | "server"): void {
    socket.addEventListener("message", event => {
      if (source === "client" && this.terminating) return;
      if (typeof event.data !== "string") {
        this.terminate(
          new RelayError(400, "realtime_protocol_error", "Binary realtime frames are unsupported"),
          1008,
        );
        return;
      }
      const bytes = frameBytes(event.data);
      const frameLimit = source === "client" ? L.clientFrameBytes : L.providerFrameBytes;
      if (bytes > frameLimit) {
        this.terminate(new RelayError(413, "payload_too_large", "Realtime frame limit exceeded"), 1009);
        return;
      }
      if (source === "client" && !this.allowClient(bytes)) {
        this.terminate(
          new RelayError(400, "realtime_protocol_error", "Realtime input is arriving faster than real time"),
          1008,
        );
        return;
      }
      if (source === "server" && this.active) {
        this.active.outputBytes += bytes;
        if (this.active.outputBytes > L.generationOutputBytes) {
          this.terminate(new RelayError(413, "payload_too_large", "Realtime output limit exceeded"), 1009);
          return;
        }
      }
      const raw = event.data;
      if (source === "server" && this.deferredInitial) {
        send(this.upstream, this.deferredInitial);
        this.deferredInitial = null;
      }
      this.ctx.waitUntil(this.mailbox.push(bytes, async () => {
        if (this.closed || (source === "client" && !this.live())) return;
        let frame: JsonObject;
        try {
          frame = object(JSON.parse(raw));
        } catch {
          return invalid("Invalid realtime JSON frame");
        }
        if (source === "client") {
          if (frame.event_id !== undefined) {
            const eventId = id(frame.event_id);
            const fingerprint = hex(await sha256(raw));
            const previous = this.generationIds.get(eventId) ?? this.recentIds.get(eventId);
            if (previous !== undefined) {
              if (previous !== fingerprint) invalid("Event identifier was reused with different content");
              return;
            }
            // Generation triggers remain protected for the entire connection.
            // Audio and other traffic use a bounded recent window, not a lifetime cap.
            if (frame.type === "response.create") {
              if (this.generationIds.size >= L.generations) invalid("Realtime generation limit exceeded");
              this.generationIds.set(eventId, fingerprint);
            } else {
              this.recentIds.set(eventId, fingerprint);
              if (this.recentIds.size > 4096) {
                const oldest = this.recentIds.keys().next().value!;
                this.recentIds.delete(oldest);
              }
            }
          }
        } else if (frame.type === "response.done") {
          const responseId = id(object(frame.response).id);
          if (this.terminalResponses.has(responseId)) return;
        }
        const state = {
          ready: this.ready,
          configuring: this.configuring,
          active: this.active !== null,
          responseId: this.active?.responseId ?? null,
        };
        const effects = source === "client"
          ? this.adapter!.client(frame, state)
          : this.adapter!.server(frame, state);
        for (const effect of effects) {
          await this.effect(effect, source, bytes, { frame, raw });
        }
        await this.schedule();
      }));
    });
    socket.addEventListener("close", event => {
      // A provider that hangs up says why only here; nothing of it reaches the client.
      if (source === "server" && !this.terminating) {
        log("warn", "realtime_provider_closed", {
          sessionId: this.bootstrap.sessionId,
          code: event.code,
          reason: event.reason.slice(0, 200),
        });
      }
      this.terminate(null, source === "client" ? 1000 : 1011);
    });
    socket.addEventListener("error", () =>
      this.terminate(new RelayError(502, "provider_error", "Realtime transport failed"), 1011),
    );
  }

  /**
   * `received` is the frame as parsed and as it arrived. A provider frame the
   * adapter forwards unchanged goes to the client as its original text, so
   * audio deltas are never serialized a second time. Client frames are always
   * re-serialized: the provider must receive exactly what was validated, never
   * text a different JSON parser could read another way, say by keeping the
   * first of two duplicate keys where this one kept the last.
   */
  private async effect(
    effect: AdapterEffect,
    source: "client" | "server",
    bytes: number,
    received?: { frame: JsonObject; raw: string },
  ): Promise<void> {
    const outgoing = (frame: JsonObject): JsonObject | string =>
      frame === received?.frame ? received.raw : frame;
    switch (effect.kind) {
      case "ready":
        this.ready = true;
        this.configuring = false;
        return;
      case "inputReset":
        this.inputBytes = 0;
        this.inputStarted = null;
        return;
      case "configure":
        this.configuring = true;
        this.ready = false;
        this.configurationAt = Date.now();
        send(this.upstream, effect.frame);
        return;
      case "forward":
        if (source === "client") {
          if (!this.live()) return;
          if (effect.input) {
            this.inputBytes += bytes;
            if (this.inputStarted === null) this.inputStarted = Date.now();
            if (this.inputBytes > L.turnInputBytes) {
              throw new RelayError(413, "payload_too_large", "Realtime turn input limit exceeded");
            }
          }
          if (effect.useful) this.lastActivity = Date.now();
          send(this.upstream, effect.frame);
          if (effect.endInput) this.inputStarted = null;
        } else {
          send(this.client, outgoing(effect.frame));
        }
        return;
      case "generate":
        await this.generate(effect.frame, effect.inputActivity === true);
        return;
      case "pendingAuto":
        // Speech committed while a response runs is all in the provider's
        // conversation already, so one response after it answers every such
        // utterance: a later one joins the pending turn instead of ending the
        // session.
        this.pendingAuto = effect;
        return;
      case "reject":
        // The provider's own error has reached the app; the session ends here.
        return invalid(effect.message);
      case "cancel": {
        const frame = this.adapter!.cancel();
        if (frame) {
          send(this.upstream, frame);
        } else {
          this.terminate(null, 1000);
        }
        return;
      }
      case "created":
        if (!this.active) invalid("Unadmitted response");
        this.active.responseId = effect.responseId;
        this.active.stage = "active";
        this.journal.save(this.active);
        return;
      case "observe":
        if (!this.active) invalid("Unattributed usage");
        this.active.usage = effect.usage;
        this.journal.save(this.active);
        return;
      case "finalize": {
        const generation = this.active;
        if (!generation) invalid("Unadmitted terminal response");
        generation.usage = effect.usage;
        // Stored before the terminal frame is forwarded, then sent to the
        // gateway in the background. Usage the gateway cannot record or read
        // never ends the conversation: it stays in the journal and is retried,
        // and the gateway reports usage it cannot price.
        this.journal.settle(generation, settlement(generation, effect.status, this.terminating));
        this.terminalResponses.add(effect.responseId);
        this.active = null;
        await this.schedule();
        send(this.client, effect.frame);
        this.ctx.waitUntil(this.flush());
        if (this.refusal) {
          this.fail(this.refusal);
          return;
        }
        const pending = this.pendingAuto;
        this.pendingAuto = null;
        if (pending && this.live()) await this.generate(pending.frame);
        return;
      }
    }
  }

  /**
   * Starts one response. It is sent to the provider at once and counted in
   * the background, so no turn waits on the gateway: the gateway checked the
   * session when it opened, and a refusal it gives for this response applies
   * from the next turn (see {@link countInBackground}).
   */
  private async generate(frame: JsonObject, inputActivity = false): Promise<void> {
    if (!this.live()) return;
    if (this.refusal) throw this.refusal;
    if (this.active || this.pendingAuto) invalid("Only one active realtime generation is permitted");
    if (this.ordinal >= L.generations) invalid("Realtime generation limit exceeded");
    const kind = typeof frame.type === "string"
      ? frame.type
      : inputActivity ? "gemini.activityStart" : "gemini.clientContent";
    const intent = { kind, fingerprint: hex(await sha256(JSON.stringify(frame))) };
    if (!this.live()) return;
    const at = Date.now();
    const generation: Generation = {
      intent,
      id: crypto.randomUUID(),
      ordinal: ++this.ordinal,
      at,
      stage: "dispatching",
      responseId: null,
      usage: null,
      outputBytes: 0,
      ticket: this.grant!.ticket,
    };
    // Stored before the request leaves, so a response sent always gets a
    // usage record, even if this object restarts before it answers.
    this.active = generation;
    this.journal.save(generation);
    // Counted even if the send below fails: the provider may have it.
    this.ctx.waitUntil(this.countInBackground(generation));
    send(this.upstream, frame);
    this.inputBytes = 0;
    this.inputStarted = inputActivity ? at : null;
    this.lastActivity = Date.now();
  }

  /**
   * Counts a response already sent, against the app's limits and the
   * account's allowance, without the conversation waiting for it.
   *
   * A refusal (a limit reached, the user blocked, the session's rules or
   * credentials changed) ends the session at its next idle moment: the
   * response it refused finishes, uncounted, and no new one starts. So a limit
   * can be exceeded by one response per open session. A gateway fault is not a
   * refusal: the response stays uncounted, as an HTTP request is during an
   * outage of ours, and the next turn goes ahead.
   */
  private async countInBackground(generation: Generation): Promise<void> {
    // Earlier turns' usage first, briefly, so the budgets checked include it.
    await this.flushWithin(L.settleWaitMs);
    try {
      this.grant = await this.backend.admit(
        this.bootstrap,
        this.authHeaders,
        this.grant!,
        generation.id,
        generation.at,
      );
    } catch (error) {
      if (error instanceof RelayError && error.status < 500) {
        this.refuseNextTurn(error);
        return;
      }
      log("warn", "realtime_response_uncounted", {
        sessionId: this.bootstrap.sessionId,
        generationId: generation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Ends the session now if no response is running, else once it finishes. */
  private refuseNextTurn(error: RelayError): void {
    this.refusal ??= error;
    if (!this.active) this.fail(this.refusal);
  }

  private fail(error: unknown): void {
    const known = error instanceof RelayError
      ? error
      : new RelayError(502, "provider_error", "Realtime session failed");
    const closeCode = known.code === "payload_too_large" ? 1009 : known.status < 500 ? 1008 : 1011;
    this.terminate(known, closeCode);
  }

  terminate(error: RelayError | null, code: number): void {
    if (this.terminating) return;
    this.terminating = true;
    if (error) {
      log("warn", "realtime_session_failed", {
        sessionId: this.bootstrap.sessionId,
        code: error.code,
        message: error.message,
      });
    }
    if (this.timer) clearTimeout(this.timer);
    // Only a response the provider was asked for can still be finishing.
    const dispatched = this.active !== null
      && (this.active.stage === "dispatching" || this.active.stage === "active");
    // Termination is immediate even while the serial mailbox awaits a quota/DB RPC.
    // Install cleanup before best-effort writes to an already failing transport.
    this.drainUntil = Date.now() + (dispatched ? L.drainMs : 0);
    setTimeout(() => {
      close(this.upstream, code);
      this.closed = true;
      this.ctx.waitUntil(this.shutdown());
    }, Math.max(0, this.drainUntil - Date.now()));
    this.ctx.waitUntil(this.schedule());
    try {
      if (error) {
        send(this.client, {
          type: "gateway.error",
          error: { code: error.code, message: error.message, ...retryAfterSeconds(error) },
          session_id: this.bootstrap.sessionId,
          generation_id: this.active?.id ?? null,
        });
      }
    } catch {
      // Reporting must never prevent cleanup.
    }
    close(this.client, code);
    try {
      if (dispatched && this.adapter) {
        const cancel = this.adapter.cancel();
        if (cancel) send(this.upstream, cancel);
      }
    } catch {
      // Cancellation must never prevent closing the provider transport.
    }
  }

  private shutdown(): Promise<void> {
    if (this.cleaned) return Promise.resolve();
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = (async () => {
      try {
        await this.starting;
        // A pending upgrade may have supplied a socket after the first close.
        close(this.upstream, 1011);
        // Capacity cleanup does not wait for an in-flight accounting call.
        await Promise.all([
          this.release(),
          this.mailbox.afterDrain(async () => {
            await this.recover();
            await this.flush();
          }),
        ]);
      } finally {
        await this.schedule();
      }
    })().finally(() => {
      this.shuttingDown = null;
    });
    return this.shuttingDown;
  }

  private release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.releasing = Promise.all(["user", "app"].map(async scope => {
      const name = scope === "user" ? "release:user" : "release:app";
      const task = this.journal.task(name);
      if (task.complete) return;
      if (task.expiresAt === undefined) {
        task.expiresAt = Date.now() + L.outboxRetentionMs;
        this.journal.saveTask(name, task);
      }
      if (Date.now() >= task.expiresAt) {
        log("error", "realtime_lease_cleanup_expired", { sessionId: this.bootstrap.sessionId, scope });
        task.complete = true;
        this.journal.saveTask(name, task);
        return;
      }
      if (task.due > Date.now()) return;
      try {
        await this.backend.capacity(this.bootstrap, scope === "user" ? "user" : "app", "release");
        task.complete = true;
        this.journal.saveTask(name, task);
      } catch {
        this.journal.retryTask(name, task);
      }
    }))
      .then(() => {})
      .finally(() => {
        this.releasing = null;
      });
    return this.releasing;
  }

  /** Sends pending usage, waiting at most `ms` for it. Never fails. */
  private async flushWithin(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([this.flush().catch(() => false), deadline]);
    clearTimeout(timer);
  }

  /**
   * Sends the journal's pending usage to the gateway. A call while a delivery
   * runs joins it, and makes it go round once more, since that delivery may
   * have read the journal before this call's usage was stored.
   */
  private flush(): Promise<boolean> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      let complete: boolean;
      do {
        this.flushAgain = false;
        complete = await this.deliver();
      } while (this.flushAgain);
      return complete;
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async deliver(): Promise<boolean> {
    let complete = true;
    for (const item of this.journal.outbox()) {
      if (Date.now() - item.createdAt >= L.outboxRetentionMs) {
        log("error", "realtime_usage_permanent_failure", {
          sessionId: this.bootstrap.sessionId,
          eventId: item.id,
        });
        this.journal.acknowledged(item.id);
        continue;
      }
      if (item.due > Date.now()) {
        complete = false;
        continue;
      }
      try {
        await this.backend.settle(this.bootstrap, item.settlement);
        this.journal.acknowledged(item.id);
      } catch {
        this.journal.retry(item);
        complete = false;
        log("error", "realtime_usage_retry", { sessionId: this.bootstrap.sessionId, eventId: item.id });
      }
    }
    return complete;
  }

  /**
   * After a restart: every response that was sent and not yet settled is
   * settled as interrupted, so it gets its usage record. Restarts never
   * restore sockets or send anything to the provider.
   */
  async recover(): Promise<void> {
    this.active = null;
    for (const generation of this.journal.generations()) {
      if (generation.stage === "settled") continue;
      this.journal.settle(generation, settlement(generation, "interrupted", true));
    }
  }

  private async maintain(): Promise<void> {
    if (!this.live()) return;
    let outage: unknown = null;
    try {
      this.grant = await this.backend.maintain(this.bootstrap, this.authHeaders, this.grant!, this.active !== null);
    } catch (error) {
      // Admission can complete while maintenance awaits remote availability.
      // Its own checks already authorized the active generation to finish.
      const quotaRefusal = error instanceof RelayError
        && ["billing_request_quota_exceeded", "app_budget_exhausted"].includes(error.code);
      const refusal = error instanceof RelayError && error.status < 500;
      if (refusal && !(this.active && quotaRefusal)) throw error;
      // A gateway fault is not a refusal: the leases are still renewed below,
      // so the session outlasts it, and the check is retried shortly.
      if (!refusal) outage = error;
    }
    if (!this.live()) return;
    const [user, app] = await Promise.all([
      this.backend.capacity(this.bootstrap, "user", "renew"),
      this.backend.capacity(this.bootstrap, "app", "renew"),
    ]);
    if (!this.live() || !user.allowed || !app.allowed) {
      throw new RelayError(429, "realtime_session_limit", "Realtime capacity lease expired");
    }
    this.leaseExpiry = Math.min(user.expiresAt, app.expiresAt);
    if (outage) throw outage;
    this.nextMaintenance = Date.now() + L.revalidateMs;
  }

  private deadline(): number {
    return Math.min(
      this.expiresAt,
      this.leaseExpiry - L.leaseSafetyMs,
      this.configuring ? this.configurationAt + L.setupMs : Infinity,
      this.lastActivity + L.idleMs,
      this.inputStarted === null ? Infinity : this.inputStarted + L.inputMs,
      this.active ? this.active.at + L.responseMs : Infinity,
    );
  }

  private async schedule(): Promise<void> {
    if (this.cleaned) return;
    const now = Date.now();
    const live = !this.closed && !this.terminating;
    let due: number;
    if (live) {
      // The socket path uses only scalar state. Completed generations are never
      // reread for audio deltas, and extending a deadline keeps the earlier alarm.
      due = Math.min(this.deadline(), this.maintenance ? Infinity : this.nextMaintenance);
      if (this.alarmDue !== null && this.alarmDue <= due && this.timer !== null) return;
    } else {
      const pending = this.journal.outbox().map(item =>
        Math.min(item.due, item.createdAt + L.outboxRetentionMs),
      );
      for (const name of ["release:user", "release:app"] as const) {
        const task = this.journal.task(name);
        if (!task.complete) pending.push(Math.min(task.due, task.expiresAt ?? Infinity));
      }
      due = !this.closed
        ? this.drainUntil
        : pending.length ? Math.min(...pending) : now + 60_000;
    }
    due = Math.max(now + 1, due);
    if (this.alarmDue === due) return;
    this.alarmDue = due;
    this.clearTimer();
    await this.ctx.storage.setAlarm(due);
    if (this.alarmDue !== due || !live || this.terminating) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.alarmDue = null;
      this.tick();
      this.ctx.waitUntil(this.schedule());
    }, Math.max(1, due - Date.now()));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.terminating) return;
    if (Date.now() >= this.deadline()) {
      const expired = Date.now() >= this.expiresAt;
      const error = expired
        ? new RelayError(401, "auth_required", "Realtime session expired")
        : new RelayError(408, "realtime_protocol_error", "Realtime deadline exceeded");
      this.terminate(error, expired ? 1000 : 1008);
      return;
    }
    if (!this.maintenance && Date.now() >= this.nextMaintenance) {
      // Usage a failed delivery left in the journal is retried here too.
      this.ctx.waitUntil(this.flush());
      this.maintenance = this.maintain()
        .catch(error => {
          // An outage is not a refusal. While the leases still cover the session
          // it tries again shortly; only a policy answer, or leases about to
          // lapse, end the conversation.
          const transient = !(error instanceof RelayError) || error.status >= 500;
          if (transient && Date.now() + L.maintenanceRetryMs < this.leaseExpiry - L.leaseSafetyMs) {
            log("warn", "realtime_maintenance_retry", {
              sessionId: this.bootstrap.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            this.nextMaintenance = Date.now() + L.maintenanceRetryMs;
            return;
          }
          this.fail(error);
        })
        .finally(() => {
          this.maintenance = null;
          this.ctx.waitUntil(this.schedule());
        });
      this.ctx.waitUntil(this.maintenance);
    }
  }

  async alarm(): Promise<void> {
    if (this.cleaned) return;
    this.alarmDue = null;
    this.clearTimer();
    if (!this.closed && !this.terminating && this.client) {
      this.tick();
      await this.schedule();
      return;
    }
    // A reconstructed object has no sockets or live credentials, and is closed by definition.
    close(this.client, 1000);
    close(this.upstream, 1011);
    this.closed = true;
    this.terminating = true;
    await this.shutdown();
    const pending = this.journal.outbox().length > 0
      || !this.journal.task("release:user").complete
      || !this.journal.task("release:app").complete;
    if (!pending) {
      this.cleaned = true;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.schedule();
  }
}

/** What a settled response reports for its usage record. */
function settlement(generation: Generation, status: CompletionStatus, aborted: boolean): Settlement {
  return {
    generationId: generation.id,
    at: generation.at,
    ticket: generation.ticket,
    usage: generation.usage,
    responseId: generation.responseId,
    status,
    aborted,
    latencyMs: Math.max(0, Date.now() - generation.at),
  };
}

/**
 * Starts hashing `text`. Deliberately not `async`: the caller's own `await`
 * stays the only suspension point, exactly as when the digest was inline.
 */
function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}


/** The `retry_after_seconds` an error frame carries when the error names a `Retry-After`. */
function retryAfterSeconds(error: RelayError): { retry_after_seconds: number } | Record<string, never> {
  const retryAfter = new Headers(error.headers).get("Retry-After");
  return retryAfter ? { retry_after_seconds: Number(retryAfter) } : {};
}
