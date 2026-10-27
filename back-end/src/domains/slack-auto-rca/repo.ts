/**
 * Slack auto-RCA persistence. Every query is keyed by a unique or indexed
 * column (event id, signature+window, agent id, channel+ts), so webhook cost
 * stays O(1) per Slack event regardless of how many agents exist.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { SlackAutoRcaEventKind, SlackAutoRcaIncidentRow } from './types';

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Insert the incident for this signature window, or return the existing one.
 * `skipDuplicates` is ON CONFLICT DO NOTHING, so concurrent cards with one
 * signature converge on a single row without a unique-violation round trip.
 */
export async function claimIncident(data: {
  signature: string;
  windowStart: Date;
  agentId: string;
  ownerUserId: string;
  slackChannel: string;
  slackThreadTs: string;
}): Promise<{ incident: SlackAutoRcaIncidentRow; created: boolean }> {
  const inserted = await prisma.slackAutoRcaIncident.createMany({
    data: [data],
    skipDuplicates: true,
  });
  const incident = await prisma.slackAutoRcaIncident.findUnique({
    where: {
      signature_windowStart: { signature: data.signature, windowStart: data.windowStart },
    },
  });
  if (incident === null) throw new Error('Slack auto-RCA incident missing after its insert');
  return { incident, created: inserted.count > 0 };
}

/** Record a Slack delivery. Returns false when Slack already delivered it. */
export async function claimEvent(data: {
  eventId: string;
  incidentId: string;
  kind: SlackAutoRcaEventKind;
  slackChannel: string;
  slackTs: string;
}): Promise<boolean> {
  const inserted = await prisma.slackAutoRcaEvent.createMany({
    data: [data],
    skipDuplicates: true,
  });
  return inserted.count > 0;
}

/** Undo a claim whose side effect failed so Slack's redelivery can retry it. */
export async function releaseEvent(eventId: string): Promise<void> {
  await prisma.slackAutoRcaEvent.deleteMany({ where: { eventId } });
}

/** The incident whose alert card (original or later occurrence) is this thread. */
export async function findIncidentByAlertMessage(
  slackChannel: string,
  slackTs: string
): Promise<SlackAutoRcaIncidentRow | null> {
  const event = await prisma.slackAutoRcaEvent.findFirst({
    where: { slackChannel, slackTs, kind: { in: ['error', 'occurrence'] } },
    select: { incidentId: true },
  });
  if (event === null) return null;
  return prisma.slackAutoRcaIncident.findUnique({ where: { id: event.incidentId } });
}

export async function findIncidentByAgentId(
  agentId: string
): Promise<SlackAutoRcaIncidentRow | null> {
  return prisma.slackAutoRcaIncident.findUnique({ where: { agentId } });
}

/**
 * True when any listed agent is an auto-RCA agent or belongs to one's tree.
 * Bounded by the caller (a card mentions at most a few agent ids).
 */
export async function anyAgentOwnedByRcaIncident(agentIds: string[]): Promise<boolean> {
  if (agentIds.length === 0) return false;
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds } },
    select: { busId: true },
  });
  const candidates = new Set(agentIds);
  for (const agent of agents) if (agent.busId !== null) candidates.add(agent.busId);
  const owned = await prisma.slackAutoRcaIncident.findFirst({
    where: { agentId: { in: [...candidates] } },
    select: { id: true },
  });
  return owned !== null;
}

/** Start bookkeeping for the abandoned-start check (null when the agent row is missing). */
export async function findAgentStart(
  agentId: string
): Promise<{ status: string; temporalFirstExecutionRunId: string | null; createdAt: Date } | null> {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { status: true, temporalFirstExecutionRunId: true, createdAt: true },
  });
}

export async function agentExists(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  return agent !== null;
}

export async function findUserExists(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { userId }, select: { userId: true } });
  return user !== null;
}

/**
 * Count a later occurrence. Returns true when this occurrence also won one of
 * the bounded append slots (the agent sees at most `maxAppended` repeats).
 */
export async function recordOccurrence(incidentId: string, maxAppended: number): Promise<boolean> {
  const appended = await prisma.slackAutoRcaIncident.updateMany({
    where: { id: incidentId, appendedCount: { lt: maxAppended } },
    data: { occurrenceCount: { increment: 1 }, appendedCount: { increment: 1 } },
  });
  if (appended.count > 0) return true;
  await prisma.slackAutoRcaIncident.update({
    where: { id: incidentId },
    data: { occurrenceCount: { increment: 1 } },
  });
  return false;
}

/** Give back an append slot whose message could not be delivered. */
export async function releaseAppendSlot(incidentId: string): Promise<void> {
  await prisma.slackAutoRcaIncident.updateMany({
    where: { id: incidentId, appendedCount: { gt: 0 } },
    data: { occurrenceCount: { decrement: 1 }, appendedCount: { decrement: 1 } },
  });
}

/** Exactly one caller wins the "RCA started" Slack reply. */
export async function claimStartNotification(incidentId: string): Promise<boolean> {
  const claimed = await prisma.slackAutoRcaIncident.updateMany({
    where: { id: incidentId, startNotifiedAt: null },
    data: { startNotifiedAt: new Date() },
  });
  return claimed.count > 0;
}

/** Give back the start reply claim after Slack refused the post. */
export async function releaseStartNotification(incidentId: string): Promise<void> {
  await prisma.slackAutoRcaIncident.updateMany({
    where: { id: incidentId },
    data: { startNotifiedAt: null },
  });
}

/** Let the agent's owner clone the configured repository in code sessions. */
export async function ensureGithubRepoAccess(userId: string, repoUrl: string): Promise<void> {
  await prisma.githubRepoAccess.upsert({
    where: { userId_repoUrl: { userId, repoUrl } },
    create: { userId, repoUrl },
    update: {},
  });
}

/**
 * Point the incident at a fresh agent id after a failed start, so Slack's
 * redelivery creates a new agent instead of finding the dead row.
 */
export async function rotateIncidentAgent(
  incidentId: string,
  previousAgentId: string,
  nextAgentId: string
): Promise<void> {
  await prisma.slackAutoRcaIncident.updateMany({
    where: { id: incidentId, agentId: previousAgentId },
    data: { agentId: nextAgentId, startNotifiedAt: null },
  });
}

/** A created row whose workflow never started must not look like a live run. */
export async function markAgentStartFailed(agentId: string, message: string): Promise<void> {
  await prisma.agent.updateMany({
    where: {
      id: agentId,
      status: { in: ['STARTING_UP', 'ACTIVE'] },
      temporalFirstExecutionRunId: null,
    },
    data: { status: 'FAILED', statusMessage: message.slice(0, 500) },
  });
}

export async function findAgentOutcome(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      status: true,
      statusMessage: true,
      structuredResponse: true,
      parentAgentId: true,
    },
  });
}
