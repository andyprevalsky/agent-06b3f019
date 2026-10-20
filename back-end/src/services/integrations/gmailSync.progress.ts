/**
 * Per-address progress writer for Gmail syncs: one runId per address per sync
 * run, seq per write, through the shared I0 `reportIntegrationProgress` (which
 * derives pct, keeps a run monotonic and coalesces syncing writes to 1/s).
 *
 * Progress is observability, never a sync dependency: a failed write is logged
 * and the sync continues.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import { reportIntegrationProgress } from '../../domains/integrations/service.progress';
import type {
  ProgressWriteInput,
  ProgressWriteOutcome,
} from '../../domains/integrations/syncAccountsContract';
import { defaultGmailFetcher, type GmailFetcher } from './gmailParser';

const log = createLogger('GmailSync');

export interface GmailProgressEvent {
  accountId: string;
  input: ProgressWriteInput;
  /** null when the write itself failed. */
  outcome: ProgressWriteOutcome | null;
}

/** Injected boundaries of a sync run (Google, the clock, a progress observer). */
export interface GmailSyncDeps {
  fetcher: GmailFetcher;
  now: () => Date;
  /** Awaited after every progress write (tests observe batch-by-batch state here). */
  onProgress?: (event: GmailProgressEvent) => Promise<void> | void;
}

export function resolveGmailSyncDeps(deps: Partial<GmailSyncDeps> = {}): GmailSyncDeps {
  return {
    fetcher: deps.fetcher ?? defaultGmailFetcher,
    now: deps.now ?? (() => new Date()),
    onProgress: deps.onProgress,
  };
}

export type GmailProgressFields = Omit<ProgressWriteInput, 'runId' | 'seq'>;

export class GmailAddressProgress {
  readonly runId = randomUUID();
  private seq = 0;

  constructor(
    private readonly userId: string,
    /** The connected address: the account id of this Gmail account. */
    readonly accountId: string,
    private readonly deps: GmailSyncDeps
  ) {}

  async report(fields: GmailProgressFields): Promise<void> {
    this.seq += 1;
    const input: ProgressWriteInput = { ...fields, runId: this.runId, seq: this.seq };
    let outcome: ProgressWriteOutcome | null = null;
    try {
      outcome = await reportIntegrationProgress({
        userId: this.userId,
        provider: 'gmail',
        accountId: this.accountId,
        input,
        now: this.deps.now(),
      });
    } catch (error) {
      log.warn('Gmail progress write failed', {
        userId: this.userId,
        runId: this.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.deps.onProgress?.({ accountId: this.accountId, input, outcome });
  }
}
