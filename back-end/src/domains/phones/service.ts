/**
 * Attached phones: Mac presence + exclusive control (one holder at a time).
 *
 *   Mac app ──POST /register (every ~20s)──► PhoneDevice row (online, lastSeenAt)
 *
 *   Holder state machine (per PhoneDevice row, CAS on leaseId):
 *
 *        ┌──────── agent acquire (online) ────────┐
 *        │                                        ▼
 *     [free] ◄── agent release / lease lapse ── [agent A]
 *      │  ▲                                       │
 *      │  └──── user release (resumeAgent=A) ──┐  │ user take-control
 *      │                                       │  ▼   (resumeAgent = A)
 *      └──────── user take-control ─────────► [user] ── renew (re-post) ──┐
 *                                               ▲ ◄───────────────────────┘
 *
 *   While the user holds a phone, agent A's heartbeat/acquire fail fast with
 *   PHONE_CONTROL_TAKEN; after the user releases, A may acquire again. A lease
 *   is liveness-only: holders renew it by heartbeat (agents) or by re-posting
 *   take-control (the UI); a lapsed lease reads as free.
 *
 * 10k-agent behaviour: every operation touches exactly one PhoneDevice row
 * (indexed by id + owner) plus at most two Agent label reads; there is no
 * per-user fan-in, broadcast topic or global lock. Mac presence is O(Macs).
 */
import { randomUUID } from '../../providers/crypto';
import { AGENT_TITLE_MAX_CHARS, DEVICE_STALE_MS, USER_LEASE_TTL_MS } from './config';
import * as repo from './repo';
import { latestFrame, streamDemand } from './service.frames';
import type {
  PhoneControlErrorCode,
  PhoneHolder,
  PhoneState,
  PhoneStreamDemand,
  RegisterPhoneBody,
} from './types';

export class PhoneControlError extends Error {
  constructor(
    readonly code: PhoneControlErrorCode,
    message: string,
    readonly status: number = 409
  ) {
    super(message);
  }
}

/** Bounded retries for losing a compare-and-set race to a concurrent call. */
export const CAS_ATTEMPTS = 5;

export type LiveHolder =
  | { kind: 'agent'; agentId: string; leaseId: string; expiresAt: Date }
  | { kind: 'user'; leaseId: string; expiresAt: Date };

export function liveHolder(row: repo.PhoneDeviceRow, now: Date): LiveHolder | null {
  if (row.leaseId === null || row.leaseExpiresAt === null) return null;
  if (row.leaseExpiresAt.getTime() <= now.getTime()) return null;
  if (row.holderKind === 'user') {
    return { kind: 'user', leaseId: row.leaseId, expiresAt: row.leaseExpiresAt };
  }
  if (row.holderKind === 'agent' && row.holderAgentId !== null) {
    return {
      kind: 'agent',
      agentId: row.holderAgentId,
      leaseId: row.leaseId,
      expiresAt: row.leaseExpiresAt,
    };
  }
  return null;
}

export function isOnline(row: repo.PhoneDeviceRow, now: Date): boolean {
  return row.online && now.getTime() - row.lastSeenAt.getTime() <= DEVICE_STALE_MS;
}

export function agentLabel(
  agent: { title: string | null; goal: string } | undefined
): string | null {
  if (!agent) return null;
  const label = (agent.title ?? '').trim() || agent.goal.trim();
  if (label === '') return null;
  return label.length > AGENT_TITLE_MAX_CHARS
    ? `${label.slice(0, AGENT_TITLE_MAX_CHARS - 1)}…`
    : label;
}

async function toStates(
  userId: string,
  rows: repo.PhoneDeviceRow[],
  now: Date
): Promise<PhoneState[]> {
  const holders = rows.map((row) => liveHolder(row, now));
  const agentIds = new Set<string>();
  rows.forEach((row, i) => {
    const holder = holders[i];
    if (holder?.kind === 'agent') agentIds.add(holder.agentId);
    if (row.resumeAgentId !== null) agentIds.add(row.resumeAgentId);
  });
  const labels = new Map(
    (await repo.findAgentLabels(userId, [...agentIds])).map((a) => [a.id, agentLabel(a)])
  );
  return rows.map((row, i) => {
    const live = holders[i];
    let holder: PhoneHolder = { kind: null };
    if (live?.kind === 'user')
      holder = { kind: 'user', leaseExpiresAt: live.expiresAt.toISOString() };
    if (live?.kind === 'agent') {
      holder = {
        kind: 'agent',
        agentId: live.agentId,
        agentTitle: labels.get(live.agentId) ?? null,
        leaseExpiresAt: live.expiresAt.toISOString(),
      };
    }
    const resumeAgentId =
      row.resumeAgentId !== null && !(live?.kind === 'agent' && live.agentId === row.resumeAgentId)
        ? row.resumeAgentId
        : null;
    const frame = latestFrame(row.id, undefined, now.getTime());
    return {
      id: row.id,
      name: row.name,
      model: row.model,
      kind: 'iphone_mirroring',
      macDeviceId: row.macDeviceId,
      online: isOnline(row, now),
      lastSeenAt: row.lastSeenAt.toISOString(),
      holder,
      resumeAgent:
        resumeAgentId === null
          ? null
          : { agentId: resumeAgentId, agentTitle: labels.get(resumeAgentId) ?? null },
      frame: frame
        ? {
            seq: frame.seq,
            capturedAt: new Date(frame.capturedAt).toISOString(),
            width: frame.width,
            height: frame.height,
          }
        : null,
    };
  });
}

async function toState(userId: string, row: repo.PhoneDeviceRow, now: Date): Promise<PhoneState> {
  return (await toStates(userId, [row], now))[0];
}

export async function requirePhone(userId: string, phoneId: string): Promise<repo.PhoneDeviceRow> {
  const row = await repo.findPhone(userId, phoneId);
  if (!row) throw new PhoneControlError('PHONE_NOT_FOUND', 'Phone not found', 404);
  return row;
}

// ── Mac presence ────────────────────────────────────────────────────────────

export async function registerPhone(
  userId: string,
  body: RegisterPhoneBody
): Promise<{ phone: PhoneState; stream: PhoneStreamDemand }> {
  const now = new Date();
  const row = await repo.upsertPhonePresence({
    userId,
    macDeviceId: body.macDeviceId,
    name: body.name,
    model: body.model ?? null,
    kind: body.kind,
    online: body.online,
    now,
  });
  return { phone: await toState(userId, row, now), stream: streamDemand(row.id, now.getTime()) };
}

export async function listPhones(userId: string): Promise<{ phones: PhoneState[] }> {
  const now = new Date();
  return { phones: await toStates(userId, await repo.listPhones(userId), now) };
}

export async function getPhone(userId: string, phoneId: string): Promise<PhoneState> {
  return toState(userId, await requirePhone(userId, phoneId), new Date());
}

/** Owner check for relay routes; returns the row or throws PHONE_NOT_FOUND. */
export async function requireOwnedPhone(userId: string, phoneId: string): Promise<void> {
  await requirePhone(userId, phoneId);
}

// ── User control ────────────────────────────────────────────────────────────

/**
 * The user takes control (preempting an agent) or renews their lease.
 * Idempotent: repeating it while in control only extends the lease.
 */
export async function takeControl(userId: string, phoneId: string): Promise<PhoneState> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await requirePhone(userId, phoneId);
    const now = new Date();
    const live = liveHolder(row, now);
    const expiresAt = new Date(now.getTime() + USER_LEASE_TTL_MS);
    const data =
      live?.kind === 'user'
        ? { leaseExpiresAt: expiresAt }
        : {
            holderKind: 'user',
            holderAgentId: null,
            leaseId: randomUUID(),
            leaseExpiresAt: expiresAt,
            resumeAgentId: live?.kind === 'agent' ? live.agentId : row.resumeAgentId,
          };
    if (await repo.compareAndSetHolder(userId, phoneId, row.leaseId, data)) {
      return getPhone(userId, phoneId);
    }
  }
  throw new PhoneControlError(
    'PHONE_CONTROL_CONFLICT',
    'Phone control changed concurrently; retry'
  );
}

/** The user hands the phone back. No-op unless the user holds it. */
export async function releaseUserControl(userId: string, phoneId: string): Promise<PhoneState> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await requirePhone(userId, phoneId);
    const now = new Date();
    if (liveHolder(row, now)?.kind !== 'user') return toState(userId, row, now);
    const released = await repo.compareAndSetHolder(userId, phoneId, row.leaseId, {
      holderKind: null,
      holderAgentId: null,
      leaseId: null,
      leaseExpiresAt: null,
    });
    if (released) return getPhone(userId, phoneId);
  }
  return getPhone(userId, phoneId);
}
