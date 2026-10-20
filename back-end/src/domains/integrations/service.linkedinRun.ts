/**
 * LinkedIn run bookkeeping shared by the agent-phase and upload services.
 *
 *   config.linkedinSync (Integration row)        IntegrationSyncProgress row
 *   ─────────────────────────────────────        ───────────────────────────
 *   authoritative phase order + timeline   ──►   mirror of the current phase
 *   (written under the LinkedIn name lock)       (I0 guards: runId, coalescing)
 *
 * The timeline only grows on a phase change (≤ 7 entries per run), so a run
 * costs O(phases) row writes; byte and record counts go to the progress row.
 */

import { type Prisma, IntegrationStatus } from './types';
import {
  LINKEDIN_PROVIDER,
  type LinkedInPhase,
  type LinkedInPhaseEntry,
  type LinkedInRunState,
} from './linkedinSyncContract';
import { reportIntegrationProgress } from './service.progress';
import type { ProgressWriteInput, ProgressWriteOutcome } from './syncAccountsContract';

type Json = Record<string, unknown>;
const MAX_TIMELINE = 12;

export function configObject(config: unknown): Json {
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? (config as Json)
    : {};
}

export function runStateOf(config: unknown): LinkedInRunState | null {
  const raw = configObject(config).linkedinSync;
  if (typeof raw !== 'object' || raw === null) return null;
  const state = raw as Partial<LinkedInRunState>;
  if (typeof state.runId !== 'string' || typeof state.phase !== 'string') return null;
  if (!Array.isArray(state.phases)) return null;
  return state as LinkedInRunState;
}

/** The export agent recorded on a row (legacy rows carry only `syncAgentId`). */
export function syncAgentIdOf(config: unknown): string | null {
  const id = configObject(config).syncAgentId;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function newRunState(params: {
  runId: string;
  agentId: string | null;
  createdRow: boolean;
  previousStatus: string | null;
  first: Omit<LinkedInPhaseEntry, 'at'>;
  now: Date;
}): LinkedInRunState {
  const at = params.now.toISOString();
  return {
    runId: params.runId,
    agentId: params.agentId,
    phase: params.first.phase,
    startedAt: at,
    createdRow: params.createdRow,
    previousStatus: params.previousStatus,
    readyBy: null,
    phases: [{ ...params.first, at }],
    counts: null,
  };
}

/**
 * Record `entry`: a new phase appends to the timeline; the same phase again
 * only refreshes its counts (the time it was first reached is kept).
 */
export function advance(
  state: LinkedInRunState,
  entry: Omit<LinkedInPhaseEntry, 'at'>,
  now: Date
): LinkedInRunState {
  const last = state.phases[state.phases.length - 1];
  const phases =
    last !== undefined && last.phase === entry.phase
      ? [...state.phases.slice(0, -1), { ...last, ...entry, at: last.at }]
      : [...state.phases, { ...entry, at: now.toISOString() }].slice(-MAX_TIMELINE);
  return { ...state, phase: entry.phase, phases };
}

export function configWith(config: unknown, state: LinkedInRunState, extra: Json = {}) {
  return {
    ...configObject(config),
    ...extra,
    syncAgentId: state.agentId,
    startedAt: state.startedAt,
    linkedinSync: state,
  } as unknown as Prisma.InputJsonValue;
}

/** The row's config once a run has moved elsewhere: no sync state left behind. */
export function configWithoutRun(config: unknown): Prisma.InputJsonValue {
  const rest = { ...configObject(config) };
  delete rest.linkedinSync;
  delete rest.startedAt;
  rest.syncAgentId = null;
  return rest as Prisma.InputJsonValue;
}

/** Status a row returns to when the run that marked it SYNCING moves away. */
export function restoredStatus(
  previous: string | null,
  lastSuccessfulSyncAt: Date | null
): IntegrationStatus {
  const keep: string[] = [
    IntegrationStatus.CONNECTED,
    IntegrationStatus.SYNC_FAILED,
    IntegrationStatus.EXPIRED,
    IntegrationStatus.NOT_CONNECTED,
  ];
  if (previous !== null && keep.includes(previous)) return previous as IntegrationStatus;
  return lastSuccessfulSyncAt === null
    ? IntegrationStatus.NOT_CONNECTED
    : IntegrationStatus.CONNECTED;
}

/** Seconds left until LinkedIn's stated ready time; null when it stated none or it passed. */
export function etaOf(state: LinkedInRunState, now: Date): number | null {
  if (state.readyBy === null) return null;
  const left = Math.round((Date.parse(state.readyBy) - now.getTime()) / 1000);
  return left > 0 ? left : null;
}

export async function mirrorProgress(
  userId: string,
  accountId: string,
  runId: string,
  input: Omit<ProgressWriteInput, 'runId'>
): Promise<ProgressWriteOutcome> {
  return reportIntegrationProgress({
    userId,
    provider: LINKEDIN_PROVIDER,
    accountId,
    input: { runId, ...input },
  });
}

/** Mirror an agent-driven phase (no counts exist before the archive arrives). */
export async function mirrorAgentPhase(
  userId: string,
  accountId: string,
  state: LinkedInRunState,
  now: Date
): Promise<ProgressWriteOutcome> {
  if (state.phase === 'failed') {
    const error = state.phases[state.phases.length - 1]?.error ?? 'LinkedIn sync failed';
    return mirrorProgress(userId, accountId, state.runId, { state: 'failed', error });
  }
  return mirrorProgress(userId, accountId, state.runId, {
    state: 'syncing',
    phase: state.phase,
    done: null,
    total: null,
    unit: null,
    eta_sec: etaOf(state, now),
  });
}

export const isAgentPhase = (phase: LinkedInPhase): boolean =>
  phase === 'starting' || phase === 'export_requested' || phase === 'waiting_for_export';
