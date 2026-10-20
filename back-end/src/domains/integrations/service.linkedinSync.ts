/**
 * LinkedIn export sync: the agent-driven phases (plan row I4).
 *
 *   [no run] --startLinkedInSync(agent, account?)--> starting       row SYNCING
 *   starting --agent: export_requested (eta?)-----> export_requested
 *   export_requested --agent: waiting_for_export--> waiting_for_export (repeatable)
 *   any agent phase --agent: failed(error)--------> failed         row SYNC_FAILED
 *   any agent phase --agent ends / never started--> reads failed   (read time only)
 *   any agent phase --upload arrives--------------> uploading … (service.linkedinImport)
 *
 * A report naming another account moves the run there (the account the
 * browser is signed into is only known once the agent is on linkedin.com).
 * The export agent is an ordinary agent; the row only remembers which agent
 * owns the run so every client and every refresh reads the same state.
 */

import * as repo from './repo.linkedinSync';
import { IntegrationStatus } from './types';
import {
  agentRunId,
  isTerminalLinkedInPhase,
  LINKEDIN_PROVIDER,
  normalizeLinkedInAccountId,
  type LinkedInPhase,
  type LinkedInPhaseReport,
  type LinkedInRunState,
} from './linkedinSyncContract';
import {
  advance,
  configWith,
  configWithoutRun,
  isAgentPhase,
  mirrorAgentPhase,
  newRunState,
  restoredStatus,
  runStateOf,
  syncAgentIdOf,
} from './service.linkedinRun';
import { toWireAccountId, type AccountsByProvider } from './syncAccountsContract';

export const LINKEDIN_INTEGRATION_NAME = LINKEDIN_PROVIDER;

/** Agent states in which the export can still arrive. */
const LIVE_AGENT_STATUSES = new Set(['STARTING_UP', 'ACTIVE', 'PAUSED']);

/**
 * A new agent is a chat agent until its router escalates (seconds). One that
 * still has no workflow after this window answered in chat or failed there,
 * and an idle chat agent stays ACTIVE forever — it will never upload.
 */
export const LINKEDIN_SYNC_START_GRACE_MS = 2 * 60_000;

export const AGENT_ENDED_REASON = 'The LinkedIn export agent ended before uploading the export';

type AgentLifecycle = NonNullable<Awaited<ReturnType<typeof repo.findOwnedAgentLifecycle>>>;

function canStillUpload(agent: AgentLifecycle | null, now: number): boolean {
  if (agent === null || agent.deletedAt !== null || !LIVE_AGENT_STATUSES.has(agent.status)) {
    return false;
  }
  return (
    agent.temporalWorkflowId !== null ||
    now - agent.createdAt.getTime() < LINKEDIN_SYNC_START_GRACE_MS
  );
}

export class LinkedInSyncAlreadyRunningError extends Error {
  constructor(public readonly agentId: string) {
    super(`LinkedIn sync already running with agent ${agentId}`);
    this.name = 'LinkedInSyncAlreadyRunningError';
  }
}

export class LinkedInSyncAgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = 'LinkedInSyncAgentNotFoundError';
  }
}

/** No LinkedIn run of this user belongs to the reporting agent. */
export class LinkedInSyncNotFoundError extends Error {
  constructor(agentId: string) {
    super(`No LinkedIn sync is recorded for agent ${agentId}`);
    this.name = 'LinkedInSyncNotFoundError';
  }
}

export type LinkedInPhaseErrorCode = 'PHASE_OUT_OF_ORDER' | 'SYNC_FINISHED' | 'UPLOAD_IN_PROGRESS';

export class LinkedInPhaseError extends Error {
  constructor(
    public readonly code: LinkedInPhaseErrorCode,
    public readonly current: LinkedInPhase
  ) {
    super(`LinkedIn sync is at ${current}; that report is not accepted (${code})`);
    this.name = 'LinkedInPhaseError';
  }
}

/** True while another live export agent owns the row's run. */
async function blockedByOtherAgent(
  userId: string,
  row: repo.LinkedInRow | null,
  agentId: string | null
): Promise<string | null> {
  if (row?.status !== IntegrationStatus.SYNCING) return null;
  const running = syncAgentIdOf(row.config);
  if (running === null || running === agentId) return null;
  const state = runStateOf(row.config);
  if (state !== null && !isAgentPhase(state.phase)) return null;
  const lifecycle = await repo.findOwnedAgentLifecycle(running, userId);
  return canStillUpload(lifecycle, Date.now()) ? running : null;
}

/** Record `agentId` as the export agent of `account` (default account when omitted). */
export async function startLinkedInSync(userId: string, agentId: string, rawAccountId?: string) {
  const agent = await repo.findOwnedAgentLifecycle(agentId, userId);
  if (agent === null) throw new LinkedInSyncAgentNotFoundError(agentId);
  const accountId = rawAccountId === undefined ? '' : normalizeLinkedInAccountId(rawAccountId);
  const runId = agentRunId(agentId);
  const now = new Date();
  const { row, state } = await repo.withLinkedInLock(userId, async (tx) => {
    // A retried start replays the agent's run wherever it lives (a report may have moved it).
    for (const owned of await repo.listAccountRows(tx, userId)) {
      const ownedState = runStateOf(owned.config);
      if (ownedState?.runId === runId) return { row: owned, state: ownedState };
    }
    const existing = await repo.findAccountRow(tx, userId, accountId);
    const running = await blockedByOtherAgent(userId, existing, agentId);
    if (running !== null) throw new LinkedInSyncAlreadyRunningError(running);
    const fresh = newRunState({
      runId,
      agentId,
      createdRow: existing === null,
      previousStatus: existing?.status ?? null,
      first: { phase: 'starting' },
      now,
    });
    const data = { status: IntegrationStatus.SYNCING, config: configWith(existing?.config, fresh) };
    return {
      row:
        existing === null
          ? await repo.createAccountRow(tx, userId, accountId, data)
          : await repo.updateAccountRow(tx, existing.id, data),
      state: fresh,
    };
  });
  // A replayed start re-mirrors only a phase the agent still drives; an upload
  // in flight owns its own counts.
  if (isAgentPhase(state.phase)) await mirrorAgentPhase(userId, row.accountId, state, now);
  return {
    integration_id: row.id,
    status: row.status,
    agent_id: agentId,
    account_id: toWireAccountId(row.accountId),
    run_id: runId,
    phase: state.phase,
  };
}

const NEXT_FROM: Record<LinkedInPhaseReport['phase'], readonly LinkedInPhase[]> = {
  export_requested: ['starting', 'export_requested'],
  waiting_for_export: ['export_requested', 'waiting_for_export'],
  failed: ['starting', 'export_requested', 'waiting_for_export'],
};

function judgeReport(state: LinkedInRunState, report: LinkedInPhaseReport): 'apply' | 'replay' {
  if (isTerminalLinkedInPhase(state.phase)) {
    const last = state.phases[state.phases.length - 1];
    if (report.phase === 'failed' && state.phase === 'failed' && last?.error === report.error) {
      return 'replay';
    }
    throw new LinkedInPhaseError('SYNC_FINISHED', state.phase);
  }
  if (!isAgentPhase(state.phase)) throw new LinkedInPhaseError('UPLOAD_IN_PROGRESS', state.phase);
  if (!NEXT_FROM[report.phase].includes(state.phase)) {
    throw new LinkedInPhaseError('PHASE_OUT_OF_ORDER', state.phase);
  }
  return 'apply';
}

/**
 * Move a not-yet-uploaded run to `target`. A row this run created moves with
 * it; a row that already held an import is handed back in its earlier state.
 */
async function moveRun(
  tx: repo.Tx,
  userId: string,
  from: repo.LinkedInRow,
  state: LinkedInRunState,
  target: string
): Promise<{ row: repo.LinkedInRow; state: LinkedInRunState }> {
  const existing = await repo.findAccountRow(tx, userId, target);
  const running = await blockedByOtherAgent(userId, existing, state.agentId);
  if (running !== null) throw new LinkedInSyncAlreadyRunningError(running);
  if (existing === null && state.createdRow) {
    const row = await repo.updateAccountRow(tx, from.id, { accountId: target });
    await repo.moveRunProgress(tx, userId, from.accountId, target, state.runId);
    return { row, state };
  }
  const moved = {
    ...state,
    createdRow: existing === null,
    previousStatus: existing?.status ?? null,
  };
  const data = { status: IntegrationStatus.SYNCING, config: configWith(existing?.config, moved) };
  const row =
    existing === null
      ? await repo.createAccountRow(tx, userId, target, data)
      : await repo.updateAccountRow(tx, existing.id, data);
  if (state.createdRow) await repo.deleteAccountRowTx(tx, from.id);
  else {
    await repo.updateAccountRow(tx, from.id, {
      status: restoredStatus(state.previousStatus, from.lastSuccessfulSyncAt),
      config: configWithoutRun(from.config),
    });
  }
  await repo.moveRunProgress(tx, userId, from.accountId, target, state.runId);
  return { row, state: moved };
}

/** Apply one export-agent report (export_requested, waiting_for_export or failed). */
export async function reportLinkedInAgentPhase(userId: string, report: LinkedInPhaseReport) {
  const now = new Date();
  const runId = agentRunId(report.agent_id);
  const result = await repo.withLinkedInLock(userId, async (tx) => {
    const rows = await repo.listAccountRows(tx, userId);
    let row = rows.find((r) => runStateOf(r.config)?.runId === runId);
    let current = row === undefined ? null : runStateOf(row.config);
    if (row === undefined || current === null) throw new LinkedInSyncNotFoundError(report.agent_id);
    if (judgeReport(current, report) === 'replay') return { row, state: current };
    if (report.account_id !== undefined) {
      const target = normalizeLinkedInAccountId(report.account_id);
      if (target !== row.accountId) {
        ({ row, state: current } = await moveRun(tx, userId, row, current, target));
      }
    }
    const readyBy =
      report.eta_sec === undefined || report.eta_sec === null
        ? current.readyBy
        : new Date(now.getTime() + report.eta_sec * 1000).toISOString();
    const state = advance(
      { ...current, readyBy: report.phase === 'failed' ? null : readyBy },
      report.phase === 'failed'
        ? { phase: 'failed', error: report.error }
        : { phase: report.phase },
      now
    );
    const failed = report.phase === 'failed';
    row = await repo.updateAccountRow(tx, row.id, {
      config: configWith(row.config, state),
      ...(failed && {
        status: IntegrationStatus.SYNC_FAILED,
        failureReason: report.error,
        lastSyncAt: now,
        lastFailedSyncAt: now,
      }),
    });
    return { row, state };
  });
  const outcome = await mirrorAgentPhase(userId, result.row.accountId, result.state, now);
  return {
    account_id: toWireAccountId(result.row.accountId),
    run_id: runId,
    phase: result.state.phase,
    progress: outcome.snapshot.progress,
  };
}

/**
 * A running LinkedIn sync whose export agent already ended (finished, failed,
 * archived, or never left chat) without uploading reads as SYNC_FAILED, so the
 * row stops showing "Connecting" and the user can start a new export. A run
 * whose upload has begun belongs to that upload request, not to the agent.
 */
export async function settleLinkedInSync<
  T extends {
    name: string;
    status: IntegrationStatus;
    config: unknown;
    failureReason: string | null;
  },
>(userId: string, integrations: T[]): Promise<T[]> {
  return Promise.all(
    integrations.map(async (integration) => {
      if (
        integration.name !== LINKEDIN_INTEGRATION_NAME ||
        integration.status !== IntegrationStatus.SYNCING
      ) {
        return integration;
      }
      const state = runStateOf(integration.config);
      if (state !== null && !isAgentPhase(state.phase)) return integration;
      const agentId = syncAgentIdOf(integration.config);
      if (agentId === null) return integration;
      const agent = await repo.findOwnedAgentLifecycle(agentId, userId);
      if (canStillUpload(agent, Date.now())) return integration;
      return {
        ...integration,
        status: IntegrationStatus.SYNC_FAILED,
        failureReason: AGENT_ENDED_REASON,
      };
    })
  );
}

/**
 * The account view of a settled row: its progress row still says `syncing`
 * (nothing was written when the agent died), so present it as failed with the
 * row's reason and no ETA. Same derivation for the list and the delta poll.
 */
export function settleLinkedInAccounts(
  view: AccountsByProvider,
  rows: Array<{ name: string; accountId: string; status: string; failureReason: string | null }>
): AccountsByProvider {
  const accounts = view[LINKEDIN_PROVIDER];
  if (accounts === undefined) return view;
  const failed = new Map(
    rows
      .filter((r) => r.name === LINKEDIN_PROVIDER && r.status === IntegrationStatus.SYNC_FAILED)
      .map((r) => [toWireAccountId(r.accountId), r.failureReason])
  );
  return {
    ...view,
    [LINKEDIN_PROVIDER]: accounts.map((account) =>
      account.state === 'syncing' && failed.has(account.accountId)
        ? {
            ...account,
            state: 'failed' as const,
            lastError: failed.get(account.accountId) ?? null,
            progress: { ...account.progress, eta_sec: null },
          }
        : account
    ),
  };
}
