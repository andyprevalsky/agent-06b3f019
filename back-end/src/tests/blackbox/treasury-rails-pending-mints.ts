import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  orgRetryDeadlineAtMs,
  type AgentCardOrgToolCaller,
} from '../../providers/agentcard/org-runtime';
import {
  TRANSFER_PUBLIC_STATUSES,
  deferredUnusedMintVerdict,
  isFullyReclaimedTransfer,
  type MintTransferObservation,
  type DeferredUnusedMintVerdict,
  type PendingUnusedMint,
  type TransferStatusPage,
} from '../../providers/agentcard/unused-mint-settle';

const TRANSFER_PAGE_LIMIT = 100;

type LedgerLine =
  | ({ event: 'pending'; recordedAt: string } & PendingUnusedMint)
  | { event: 'resolved'; cardId: string; verdict: string; detail: string; resolvedAt: string };

/**
 * Append-only JSONL of unused mints a run could not see reclaimed. It lives outside the worktree
 * so later runs from any worktree on this machine check them, including after a merged worktree
 * is deleted.
 */
/**
 * TREASURY_RAILS_SKIP_OVERDUE_RECLAIM=1 reports an earlier mint that is still unreclaimed past the
 * deadline as a loud SKIP instead of failing the run. Use it only while the AgentCard sandbox itself
 * is not reclaiming (an external outage); other provider failures still fail.
 */
export function overdueReclaimSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TREASURY_RAILS_SKIP_OVERDUE_RECLAIM === '1';
}

export function pendingMintLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TREASURY_RAILS_PENDING_MINT_LEDGER?.trim();
  if (override) return override;
  return join(homedir(), '.cache', 'rose-labs', 'treasury-rails-pending-mints.jsonl');
}

function appendLine(ledgerPath: string, line: LedgerLine): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(line)}\n`);
}

export function readOpenPendingMints(ledgerPath: string): PendingUnusedMint[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const open = new Map<string, PendingUnusedMint>();
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let line: LedgerLine;
    try {
      line = JSON.parse(raw) as LedgerLine;
    } catch {
      throw new Error(`${ledgerPath}:${index + 1} is not valid JSON`);
    }
    if (line.event === 'resolved') {
      // Older runs incorrectly closed overdue/failed/unobservable entries.
      // Retain those original obligations until there is actual reclaim proof.
      if (line.verdict === 'settled') open.delete(line.cardId);
      return;
    }
    const { cardId, transferId, cardholderId, mintCents, mintedAt } = line;
    open.set(cardId, { cardId, transferId, cardholderId, mintCents, mintedAt });
  });
  return [...open.values()];
}

export function recordPendingMint(
  ledgerPath: string,
  entry: PendingUnusedMint,
  nowMs = Date.now()
): void {
  appendLine(ledgerPath, { event: 'pending', recordedAt: new Date(nowMs).toISOString(), ...entry });
}

/** Keep an exact closed-card transfer observable when its settlement request fails. */
export async function observePendingUnusedMint<
  T extends (MintTransferObservation & { transferredCents: number }) | undefined,
>(ledgerPath: string, entry: PendingUnusedMint, observe: () => Promise<T>): Promise<T> {
  recordPendingMint(ledgerPath, entry);
  const result = await observe();
  assert.ok(
    result === undefined ||
      (result.transferredCents >= 0 && result.transferredCents <= entry.mintCents),
    `transfer for ${entry.cardId} reported an invalid pool debit ${result?.transferredCents}`
  );
  if (isFullyReclaimedTransfer(result, entry.mintCents)) {
    appendLine(ledgerPath, {
      event: 'resolved',
      cardId: entry.cardId,
      verdict: 'settled',
      detail: `${result.status} ${result.releasedCents}c`,
      resolvedAt: new Date().toISOString(),
    });
  }
  return result;
}

function verdictDetail(verdict: DeferredUnusedMintVerdict): string {
  switch (verdict.kind) {
    case 'settled':
      return `${verdict.status} ${verdict.releasedCents}c`;
    case 'failed':
    case 'unobservable':
      return verdict.reason;
    default:
      return verdict.status;
  }
}

export type DeferredMintCheck = { entry: PendingUnusedMint; verdict: DeferredUnusedMintVerdict };

/**
 * Re-check this org's open entries. Only a verified full reclaim closes an obligation;
 * overdue, failed, and unobservable transfers remain open for later reconciliation.
 * Entries for cardholders outside this org belong to other credentials and are left for them.
 */
export async function checkPendingUnusedMints(options: {
  callOrgTool: AgentCardOrgToolCaller;
  ledgerPath: string;
  cardholderIds: ReadonlySet<string>;
  nowMs?: number;
}): Promise<DeferredMintCheck[]> {
  const open = readOpenPendingMints(options.ledgerPath).filter((entry) =>
    options.cardholderIds.has(entry.cardholderId)
  );
  if (open.length === 0) return [];
  const retryDeadlineAtMs = orgRetryDeadlineAtMs();
  const pages: TransferStatusPage[] = [];
  for (const status of TRANSFER_PUBLIC_STATUSES) {
    const result = (await options.callOrgTool(
      'list_transfers',
      { status, limit: TRANSFER_PAGE_LIMIT },
      retryDeadlineAtMs
    )) as { structuredContent?: { transfers?: Array<Record<string, unknown>> } };
    pages.push({
      status,
      limit: TRANSFER_PAGE_LIMIT,
      rows: result.structuredContent?.transfers ?? [],
    });
  }
  const nowMs = options.nowMs ?? Date.now();
  return open.map((entry) => {
    const verdict = deferredUnusedMintVerdict(entry, pages, nowMs);
    if (verdict.kind === 'settled') {
      appendLine(options.ledgerPath, {
        event: 'resolved',
        cardId: entry.cardId,
        verdict: verdict.kind,
        detail: verdictDetail(verdict),
        resolvedAt: new Date(nowMs).toISOString(),
      });
    }
    return { entry, verdict };
  });
}
