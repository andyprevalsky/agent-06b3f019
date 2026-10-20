/**
 * messaging-whatsapp: per-account history-sync progress reporter (plan row I2)
 *
 *   history batch ─► batch(phase, pct)  ┐
 *   upload saved  ─► saved(n)           ├─► latest state ─► at most ONE write in flight
 *   end / 401     ─► finish(state)      ┘                    │
 *        200 ─► idle (a newer state waits out the 1 s window)│
 *        202 ─► resend the LATEST state after retryAfterMs ◄─┘
 *        409 ─► drop (the server holds a newer run)
 *        err ─► resend after a capped backoff
 *
 * Writes are O(1) per history batch: a batch only replaces the pending state,
 * and bursts collapse into one write per window. `total` is always null (no
 * reliable total exists); `done` counts messages saved in this run.
 */
import crypto from 'crypto';
import {
  WHATSAPP_PROGRESS_MAX_RETRY_MS,
  WHATSAPP_PROGRESS_MIN_INTERVAL_MS,
  WHATSAPP_PROGRESS_RETRY_MS,
  WHATSAPP_PROGRESS_UNIT,
} from './config';
import type { WhatsAppProgressPoster, WhatsAppProgressWrite, WhatsAppSyncState } from './types';

type TerminalState = Exclude<WhatsAppSyncState, 'syncing'>;

interface Run {
  id: string;
  seq: number;
  state: WhatsAppSyncState;
  phase: string | null;
  pct: number | null;
  done: number;
  error?: string;
}

function newRunId(): string {
  return `wa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Clamp Baileys' percent into the contract's 0-100 range; null stays null. */
export function toPct(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null;
  return Math.min(100, Math.max(0, progress));
}

export class WhatsAppHistoryProgress {
  private run: Run | null = null;
  private dirty = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWriteAt = 0;
  private failures = 0;
  private stopped = false;

  constructor(
    readonly accountId: string,
    private readonly post: WhatsAppProgressPoster
  ) {}

  /** True while a history run is reporting `syncing`. */
  isSyncing(): boolean {
    return this.run?.state === 'syncing';
  }

  /** A history batch arrived. Starts a new run when none is active. */
  batch(phase: string | null, pct: number | null): void {
    const run = this.activeRun();
    run.phase = phase;
    run.pct = pct;
    this.request(false);
  }

  /** `count` more messages of this run were saved by the backend. */
  saved(count: number): void {
    if (count <= 0 || this.run?.state !== 'syncing') return;
    this.run.done += count;
    this.request(false);
  }

  /** End the run (`synced` needs an active run; failures may start one to be reported). */
  finish(state: TerminalState, error?: string): void {
    if (state === 'synced' && !this.isSyncing()) return;
    const run = this.activeRun();
    run.state = state;
    if (error !== undefined) run.error = error;
    this.request(true);
  }

  /** Stop all timers (account disconnected); a write already in flight completes. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private activeRun(): Run {
    if (this.run === null || this.run.state !== 'syncing') {
      this.run = { id: newRunId(), seq: 0, state: 'syncing', phase: null, pct: null, done: 0 };
    }
    return this.run;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, delayMs);
  }

  private request(urgent: boolean): void {
    this.dirty = true;
    if (this.stopped || this.inFlight) return;
    const wait = urgent ? 0 : this.lastWriteAt + WHATSAPP_PROGRESS_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      if (this.timer === null) this.schedule(wait);
      return;
    }
    this.clearTimer();
    void this.send();
  }

  private snapshot(run: Run): WhatsAppProgressWrite {
    run.seq += 1;
    return {
      runId: run.id,
      seq: run.seq,
      state: run.state,
      phase: run.phase,
      done: run.done,
      total: null,
      pct: run.state === 'syncing' ? run.pct : null,
      unit: WHATSAPP_PROGRESS_UNIT,
      ...(run.error !== undefined && { error: run.error }),
    };
  }

  private async send(): Promise<void> {
    const run = this.run;
    if (!this.dirty || run === null || this.stopped) return;
    this.dirty = false;
    this.inFlight = true;
    const result = await this.post(this.accountId, this.snapshot(run));
    this.inFlight = false;
    this.lastWriteAt = Date.now();
    if (result.kind === 'coalesced') {
      this.dirty = true;
      this.schedule(result.retryAfterMs);
      return;
    }
    if (result.kind === 'failed') {
      this.dirty = true;
      this.schedule(
        Math.min(WHATSAPP_PROGRESS_MAX_RETRY_MS, WHATSAPP_PROGRESS_RETRY_MS * 2 ** this.failures)
      );
      this.failures += 1;
      return;
    }
    this.failures = 0;
    if (this.dirty) this.request(this.run !== null && this.run.state !== 'syncing');
  }
}
