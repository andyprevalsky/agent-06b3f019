/**
 * messaging-telegram service layer — per-run progress reporter.
 *
 *   report(u) ──► idle? send now ─► 200/409: done (send newest pending, if any)
 *       │                       └─► 202 {retryAfterMs}: hold; resend newest after the window
 *       └─ busy/holding: keep only the newest update (latest wins)
 *   finish(u) ──► terminal state: drop any held retry, send at once (transitions are never coalesced)
 *
 * Every write carries the run id and a strictly increasing seq, so the backend
 * judges replays and late writes. Progress is best-effort: a failed write never
 * fails the sync; the next report carries the newer counts.
 */
import type { ProgressBody, ProgressSend, ProgressSendResult, ProgressUpdate } from './types';

export class ProgressReporter {
  private seq = 0;
  private pending: ProgressUpdate | null = null;
  private inFlight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  constructor(
    readonly runId: string,
    private readonly send: ProgressSend
  ) {}

  /**
   * Record a non-terminal observation. Resolves once it was sent, or at once
   * when it is held behind an in-flight write or a 202 retry window, so a sync
   * never waits out the server's coalescing window. Never rejects.
   */
  report(update: ProgressUpdate): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.pending = update;
    if (this.inFlight !== null || this.retryTimer !== null) return Promise.resolve();
    this.inFlight = this.flush();
    return this.inFlight;
  }

  /** Send the terminal observation now and stop reporting. */
  async finish(update: ProgressUpdate): Promise<void> {
    this.finished = true;
    this.pending = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
    await this.deliver(update);
  }

  private async flush(): Promise<void> {
    while (this.pending !== null && !this.finished && this.retryTimer === null) {
      const update = this.pending;
      this.pending = null;
      const result = await this.deliver(update);
      if (result?.kind === 'coalesced' && !this.finished) {
        // Not written: resend the newest counts once the server's window passes.
        this.pending ??= update;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.inFlight === null) this.inFlight = this.flush();
        }, result.retryAfterMs);
      }
    }
    this.inFlight = null;
  }

  private async deliver(update: ProgressUpdate): Promise<ProgressSendResult | null> {
    this.seq += 1;
    const body: ProgressBody = { ...update, runId: this.runId, seq: this.seq };
    try {
      return await this.send(body);
    } catch (error) {
      console.warn('[TelegramProgress] Progress write failed:', error);
      return null;
    }
  }
}
