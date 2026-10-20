/**
 * i-message-sync — per-run progress writer (I0 contract).
 *
 *   report(update) ─ syncing inside a 202 hold window? ──yes──► held (no request)
 *        │ no
 *        ├─ seq+1, persisted BEFORE the send (a crash can never reuse a seq)
 *        └─ POST …/accounts/:id/progress { runId, seq, ...update }
 *              200 applied · 202 coalesced → hold for retryAfterMs · 409 stale
 *
 * Terminal states (synced / failed) are transitions and are always sent.
 * At most one request per uploaded batch, fewer while the server coalesces.
 */

import { postProgress } from './repo';
import type { ProgressUpdate } from './types';

export type ReportOutcome = 'applied' | 'held' | 'coalesced' | 'stale' | 'error';

export interface ReporterOptions {
  accountId: string;
  accessToken: string;
  runId: string;
  /** Last seq this run already sent. */
  seq: number;
  /** Write-ahead persistence of the next seq. */
  persistSeq: (seq: number) => void;
  now?: () => number;
}

/** Hold used when a 202 omits retryAfterMs (the server's write interval). */
const DEFAULT_HOLD_MS = 1_000;

export class ProgressReporter {
  private seq: number;
  private holdUntilMs = 0;

  constructor(private readonly options: ReporterOptions) {
    this.seq = options.seq;
  }

  async report(update: ProgressUpdate): Promise<{ outcome: ReportOutcome; detail: string | null }> {
    const now = this.options.now?.() ?? Date.now();
    if (update.state === 'syncing' && now < this.holdUntilMs) {
      return { outcome: 'held', detail: null };
    }
    this.seq += 1;
    this.options.persistSeq(this.seq);
    const result = await postProgress(this.options.accountId, this.options.accessToken, {
      runId: this.options.runId,
      seq: this.seq,
      ...update,
    });
    if (result.status === 202) {
      this.holdUntilMs = now + (result.retryAfterMs ?? DEFAULT_HOLD_MS);
      return { outcome: 'coalesced', detail: null };
    }
    if (result.status === 409) return { outcome: 'stale', detail: result.staleDetail };
    if (result.status >= 200 && result.status < 300) return { outcome: 'applied', detail: null };
    console.warn(`[IMessageSync] Progress write failed (status ${result.status})`);
    return { outcome: 'error', detail: null };
  }
}
