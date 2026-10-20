/**
 * LinkedIn archive upload: the phases only the server can witness (plan row I4).
 *
 *   beginLinkedInUpload ─────► uploading {done: request bytes received, total: Content-Length}
 *   run.received(bytes) ─────► same, at most one progress write per second
 *   processLinkedInUpload ───► parsing {done: records saved, total: records}, once per batch
 *                         ───► synced {saved records} | failed {error}
 *   body ends before upload ─► failed (run.abandon from the route's close hook)
 *
 * An upload continues the account's agent run when one is waiting for the
 * archive, otherwise it starts its own run. Every row write first checks that
 * the account's current run is still this one, so an upload superseded by a
 * newer run stops touching that account's sync state.
 */

import { randomUUID } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import {
  importLinkedInContacts,
  prepareLinkedInImport,
  type PreparedLinkedInImport,
} from '../../services/integrations/linkedinParser';
import { removeUploadTempFile } from './config';
import * as repo from './repo.linkedinSync';
import { IntegrationStatus } from './types';
import {
  messageIdPrefix,
  normalizeLinkedInAccountId,
  PARSE_UNIT,
  UPLOAD_UNIT,
  type LinkedInImportCounts,
  type LinkedInPhaseEntry,
  type LinkedInRunState,
} from './linkedinSyncContract';
import {
  advance,
  configObject,
  configWith,
  isAgentPhase,
  mirrorProgress,
  newRunState,
  runStateOf,
} from './service.linkedinRun';
import { toWireAccountId } from './syncAccountsContract';

const log = createLogger('LinkedInImport');
const BYTE_REPORT_INTERVAL_MS = 1_000;

/** Several agent runs await an archive: the upload must name its account. */
export class LinkedInUploadAccountRequiredError extends Error {
  constructor(readonly accounts: string[]) {
    super(
      `Several LinkedIn syncs are waiting for an archive; pass account_id (${accounts.join(', ')})`
    );
    this.name = 'LinkedInUploadAccountRequiredError';
  }
}

type RowData = Parameters<typeof repo.updateAccountRow>[2];

export class LinkedInUploadRun {
  private bytes = 0;
  private lastReportAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private receivedAll = false;
  private finished = false;

  constructor(
    readonly userId: string,
    readonly accountId: string,
    readonly runId: string,
    readonly totalBytes: number | null
  ) {}

  /** Request body bytes received so far (called on every chunk). */
  received(bytes: number): void {
    this.bytes = bytes;
    if (this.receivedAll || this.finished) return;
    const wait = BYTE_REPORT_INTERVAL_MS - (Date.now() - this.lastReportAt);
    if (wait <= 0) this.reportBytes();
    else this.timer ??= setTimeout(() => this.reportBytes(), wait);
  }

  private reportBytes(): void {
    this.timer = null;
    this.lastReportAt = Date.now();
    const done = this.bytes;
    void this.enqueue(() => this.mirror({ state: 'syncing', phase: 'uploading', done }));
  }

  private enqueue(write: () => Promise<unknown>): Promise<unknown> {
    this.chain = this.chain.then(write).catch((error: unknown) => {
      log.warn('LinkedIn progress write failed', { runId: this.runId, error: String(error) });
    });
    return this.chain;
  }

  private async mirror(input: Parameters<typeof mirrorProgress>[3]) {
    return mirrorProgress(this.userId, this.accountId, this.runId, {
      total: this.totalBytes,
      unit: UPLOAD_UNIT,
      eta_sec: null,
      ...input,
    });
  }

  /** Append `entries` to this run and apply `data`, unless a newer run owns the account. */
  private async writeRun(
    entries: Array<Omit<LinkedInPhaseEntry, 'at'>>,
    data: (config: unknown) => RowData = () => ({}),
    extra: (state: LinkedInRunState) => LinkedInRunState = (state) => state
  ): Promise<boolean> {
    return repo.withLinkedInLock(this.userId, async (tx) => {
      const row = await repo.findAccountRow(tx, this.userId, this.accountId);
      const current = row === null ? null : runStateOf(row.config);
      if (row === null || current?.runId !== this.runId) return false;
      const now = new Date();
      const state = extra(entries.reduce((s, entry) => advance(s, entry, now), current));
      const rowData = data(row.config);
      await repo.updateAccountRow(tx, row.id, {
        ...rowData,
        config: configWith(rowData.config ?? row.config, state),
      });
      return true;
    });
  }

  /** The whole request body arrived. */
  async uploaded(): Promise<void> {
    this.receivedAll = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.chain;
    const done = this.bytes;
    const entry = { phase: 'uploading' as const, done, total: this.totalBytes, unit: UPLOAD_UNIT };
    if (await this.writeRun([entry]))
      await this.enqueue(() => this.mirror({ state: 'syncing', phase: 'uploading', done }));
  }

  async parsing(total: number, files: Record<string, number>): Promise<boolean> {
    const entry = { phase: 'parsing' as const, done: 0, total, unit: PARSE_UNIT };
    const current = await this.writeRun([entry], undefined, (state) => ({
      ...state,
      counts: { files, contacts: 0, messages: 0 },
    }));
    if (current) {
      await this.mirror({ state: 'syncing', phase: 'parsing', done: 0, total, unit: PARSE_UNIT });
    }
    return current;
  }

  /** One import batch finished; coalescing (I0) absorbs batches inside one second. */
  async parsed(done: number, total: number): Promise<void> {
    await this.mirror({ state: 'syncing', phase: 'parsing', done, total, unit: PARSE_UNIT });
  }

  async succeed(prepared: PreparedLinkedInImport, counts: LinkedInImportCounts, fileName: string) {
    this.finished = true;
    const now = new Date();
    const saved = counts.contacts + counts.messages;
    const unit = PARSE_UNIT;
    const total = prepared.records;
    const written = await this.writeRun(
      [
        { phase: 'parsing', done: total, total, unit },
        { phase: 'synced', done: saved, total, unit },
      ],
      (config) => ({
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: now,
        lastSuccessfulSyncAt: now,
        failureReason: null,
        config: importMetadata(config, prepared, fileName, now),
      }),
      (state) => ({ ...state, counts })
    );
    if (written) {
      await this.mirror({ state: 'synced', phase: null, done: saved, total, unit });
    }
  }

  async fail(error: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.chain;
    const now = new Date();
    const written = await this.writeRun([{ phase: 'failed', error }], () => ({
      status: IntegrationStatus.SYNC_FAILED,
      lastSyncAt: now,
      lastFailedSyncAt: now,
      failureReason: error,
    }));
    if (written) {
      await mirrorProgress(this.userId, this.accountId, this.runId, { state: 'failed', error });
    }
  }

  /** The request closed: only an upload whose body never fully arrived has failed. */
  async abandon(reason: string): Promise<void> {
    if (!this.receivedAll) await this.fail(reason);
  }
}

function importMetadata(
  config: unknown,
  prepared: PreparedLinkedInImport,
  fileName: string,
  now: Date
) {
  const existing = configObject(config);
  const add = (key: string, n: number) => Number(existing[key] ?? 0) + n;
  return {
    ...existing,
    fileName,
    lastUploadedAt: now.toISOString(),
    totalMessagesProcessed: add('totalMessagesProcessed', prepared.messages),
    totalContactsProcessed: add('totalContactsProcessed', prepared.contacts.length),
    batchesReceived: add('batchesReceived', 1),
    profile: prepared.data.profile,
    positions: prepared.data.positions,
  } as unknown as RowData['config'];
}

/** The account an upload without `account_id` belongs to: the one awaiting an archive. */
async function awaitingAccount(tx: repo.Tx, userId: string): Promise<string> {
  const waiting = (await repo.listAccountRows(tx, userId)).filter((row) => {
    const state = runStateOf(row.config);
    return row.status === IntegrationStatus.SYNCING && state !== null && isAgentPhase(state.phase);
  });
  if (waiting.length > 1) {
    throw new LinkedInUploadAccountRequiredError(waiting.map((r) => toWireAccountId(r.accountId)));
  }
  return waiting[0]?.accountId ?? '';
}

/** The first archive bytes arrived: mark the account uploading. */
export async function beginLinkedInUpload(
  userId: string,
  rawAccountId: string | undefined,
  totalBytes: number | null
): Promise<LinkedInUploadRun> {
  const now = new Date();
  const first = { phase: 'uploading' as const, done: 0, total: totalBytes, unit: UPLOAD_UNIT };
  const { accountId, runId } = await repo.withLinkedInLock(userId, async (tx) => {
    const account =
      rawAccountId === undefined
        ? await awaitingAccount(tx, userId)
        : normalizeLinkedInAccountId(rawAccountId);
    const existing = await repo.findAccountRow(tx, userId, account);
    const current = existing === null ? null : runStateOf(existing.config);
    const continues =
      existing?.status === IntegrationStatus.SYNCING &&
      current !== null &&
      isAgentPhase(current.phase);
    const state = continues
      ? advance({ ...current, readyBy: null }, first, now)
      : newRunState({
          runId: `li-upload-${randomUUID()}`,
          agentId: null,
          createdRow: existing === null,
          previousStatus: existing?.status ?? null,
          first,
          now,
        });
    const data = { status: IntegrationStatus.SYNCING, config: configWith(existing?.config, state) };
    if (existing === null) await repo.createAccountRow(tx, userId, account, data);
    else await repo.updateAccountRow(tx, existing.id, data);
    return { accountId: account, runId: state.runId };
  });
  await mirrorProgress(userId, accountId, runId, {
    state: 'syncing',
    phase: 'uploading',
    done: 0,
    total: totalBytes,
    unit: UPLOAD_UNIT,
    eta_sec: null,
  });
  return new LinkedInUploadRun(userId, accountId, runId, totalBytes);
}

/** Parse and import a received archive, reporting parsing → synced | failed. */
export async function processLinkedInUpload(
  run: LinkedInUploadRun,
  filePath: string,
  fileName: string
) {
  log.info('LinkedIn file uploaded', { fileName, userId: run.userId, runId: run.runId });
  try {
    await run.uploaded();
    const prepared = prepareLinkedInImport(filePath, messageIdPrefix(run.accountId));
    await run.parsing(prepared.records, prepared.data.files);
    const saved = await importLinkedInContacts(run.userId, prepared.contacts, run.runId, (done) =>
      run.parsed(done, prepared.records)
    );
    const counts = { files: prepared.data.files, ...saved };
    await run.succeed(prepared, counts, fileName);
    return {
      jobId: run.runId,
      account_id: toWireAccountId(run.accountId),
      run_id: run.runId,
      contacts: saved.contacts,
      messages: saved.messages,
      counts,
    };
  } catch (error: unknown) {
    log.error('LinkedIn parse/import error', { runId: run.runId, error: String(error) });
    await run.fail(error instanceof Error ? error.message : 'Unknown error');
    throw error;
  } finally {
    removeUploadTempFile(filePath);
  }
}

/** Account cleanup hook: exactly this account's imported messages and its row. */
export async function deleteLinkedInAccountData(userId: string, accountId: string) {
  const messages = await repo.deleteAccountMessages(userId, accountId);
  const row = await repo.deleteAccountRow(userId, accountId);
  log.info('LinkedIn account data deleted', { userId, accountId, messages, row });
  return row || messages > 0;
}
