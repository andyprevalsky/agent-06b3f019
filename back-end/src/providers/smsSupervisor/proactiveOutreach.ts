/**
 * Scheduled proactive SMS outreach.
 *
 * Wednesday/Sunday cron -> active subscribers -> no root task in trailing 7d
 * -> inject a synthetic inbound turn into the existing SMS supervisor flow.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../database';
import { createLogger } from '../logger';
import { handleSmsSupervisorMessage } from './supervisorHandler';

const log = createLogger('ProactiveSms');

export const PROACTIVE_SMS_CRON_EXPRESSION = '0 10 * * 0,3';
export const PROACTIVE_SMS_TIME_ZONE = 'America/Los_Angeles';
export const PROACTIVE_SMS_JOB_LEASE_KEY = 'scheduled-job:proactive-sms';
export const PROACTIVE_SMS_OUTREACH_PROMPT = `This is a scheduled proactive check-in. Review the person you support using the context and tools available to you, then respond with a concise SMS suggesting something you believe would be genuinely helpful for them right now. Do not mention this scheduled trigger, their subscription, or their inactivity.`;

const INACTIVITY_DAYS = 7;
const OUTREACH_CONCURRENCY = 5;
const JOB_LEASE_DURATION_MS = 30 * 60 * 1000;
const JOB_LEASE_HEARTBEAT_MS = 60 * 1000;
const JOB_LEASE_OPERATION_TYPE = 'PROACTIVE_SMS_JOB_LEASE';

interface EligibleUser {
  userId: string;
  phone: string;
}

interface StoredSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ProactiveSmsJobOptions {
  now?: Date;
  candidateUserIds?: string[];
}

export interface ProactiveSmsJobSummary {
  considered: number;
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface ProactiveSmsLeasedJobResult {
  acquired: boolean;
  summary: ProactiveSmsJobSummary | null;
}

type OutreachResult = 'sent' | 'skipped' | 'failed';

function inactivityCutoff(asOf: Date): Date {
  return new Date(asOf.getTime() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
}

function proactiveOutreachKey(asOf: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PROACTIVE_SMS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(asOf);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `proactive-sms:${values.year}-${values.month}-${values.day}`;
}

function buildTriggeredInboundMessage(outreachKey: string): string {
  return `${PROACTIVE_SMS_OUTREACH_PROMPT}\n\nInternal scheduled outreach key: ${outreachKey}.`;
}

function parseStoredMessages(raw: unknown): StoredSessionMessage[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredSessionMessage =>
        typeof item === 'object' &&
        item !== null &&
        ((item as Record<string, unknown>).role === 'user' ||
          (item as Record<string, unknown>).role === 'assistant') &&
        typeof (item as Record<string, unknown>).content === 'string' &&
        typeof (item as Record<string, unknown>).timestamp === 'string'
    );
  } catch {
    return [];
  }
}

function containsOutreachKey(raw: unknown, outreachKey: string): boolean {
  return parseStoredMessages(raw).some(
    (message) =>
      message.role === 'user' && message.content.includes(`outreach key: ${outreachKey}.`)
  );
}

async function outreachAlreadyTriggered(userId: string, outreachKey: string): Promise<boolean> {
  const session = await prisma.smsSession.findUnique({
    where: { userId },
    select: { messages: true },
  });
  return containsOutreachKey(session?.messages, outreachKey);
}

async function findEligibleUsers(asOf: Date, candidateUserIds?: string[]): Promise<EligibleUser[]> {
  const uniqueCandidateIds = candidateUserIds ? [...new Set(candidateUserIds)] : undefined;
  if (uniqueCandidateIds?.length === 0) return [];

  const subscriptions = await prisma.subscription.findMany({
    where: {
      currentPeriodEnd: { gt: asOf },
      ...(uniqueCandidateIds ? { userId: { in: uniqueCandidateIds } } : {}),
    },
    select: {
      userId: true,
      user: { select: { phone: true } },
    },
  });
  const subscribedWithPhones = subscriptions.flatMap((subscription) => {
    const phone = subscription.user.phone?.trim();
    return phone ? [{ userId: subscription.userId, phone }] : [];
  });
  if (subscribedWithPhones.length === 0) return [];

  const recentRoots = await prisma.agent.findMany({
    where: {
      userId: { in: subscribedWithPhones.map((candidate) => candidate.userId) },
      parentAgentId: null,
      createdAt: { gte: inactivityCutoff(asOf) },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  const recentlyActiveUserIds = new Set(recentRoots.map((agent) => agent.userId));
  return subscribedWithPhones.filter((candidate) => !recentlyActiveUserIds.has(candidate.userId));
}

async function isStillEligible(candidate: EligibleUser, asOf: Date): Promise<boolean> {
  const [subscription, recentRoot] = await Promise.all([
    prisma.subscription.findFirst({
      where: { userId: candidate.userId, currentPeriodEnd: { gt: asOf } },
      select: { user: { select: { phone: true } } },
    }),
    prisma.agent.findFirst({
      where: {
        userId: candidate.userId,
        parentAgentId: null,
        createdAt: { gte: inactivityCutoff(asOf) },
      },
      select: { id: true },
    }),
  ]);
  return subscription?.user.phone?.trim() === candidate.phone && recentRoot === null;
}

async function runOutreachForUser(
  candidate: EligibleUser,
  asOf: Date,
  outreachKey: string
): Promise<OutreachResult> {
  await prisma.smsSession.createMany({
    data: [{ userId: candidate.userId, messages: JSON.stringify([]) }],
    skipDuplicates: true,
  });
  const session = await prisma.smsSession.findUniqueOrThrow({
    where: { userId: candidate.userId },
    select: { lastInboundSeq: true, messages: true },
  });
  if (containsOutreachKey(session.messages, outreachKey)) {
    log.info('[ProactiveSms] Skipped duplicate scheduled trigger', {
      userId: candidate.userId,
      outreachKey,
    });
    return 'skipped';
  }

  const result = await handleSmsSupervisorMessage({
    userId: candidate.userId,
    phoneNumber: candidate.phone,
    inboundMessage: buildTriggeredInboundMessage(outreachKey),
    mySeq: session.lastInboundSeq,
    commitGuard: async () => {
      const [eligible, duplicate] = await Promise.all([
        isStillEligible(candidate, asOf),
        outreachAlreadyTriggered(candidate.userId, outreachKey),
      ]);
      return eligible && !duplicate;
    },
  });
  if (!result.committed) {
    log.info('[ProactiveSms] Existing SMS flow skipped the triggered turn', {
      userId: candidate.userId,
      outreachKey,
      toolsExecuted: result.toolsExecuted,
    });
    return 'skipped';
  }

  log.info('[ProactiveSms] Existing SMS flow sent its response', {
    userId: candidate.userId,
    outreachKey,
    toolsExecuted: result.toolsExecuted,
  });
  return 'sent';
}

export async function runProactiveSmsOutreachJob(
  options: ProactiveSmsJobOptions = {}
): Promise<ProactiveSmsJobSummary> {
  const asOf = options.now ?? new Date();
  const candidateUserIds = options.candidateUserIds
    ? [...new Set(options.candidateUserIds)]
    : undefined;
  const eligibleUsers = await findEligibleUsers(asOf, candidateUserIds);
  const outreachKey = proactiveOutreachKey(asOf);
  const results: OutreachResult[] = [];

  log.info('[ProactiveSms] Job started', {
    asOf: asOf.toISOString(),
    outreachKey,
    eligible: eligibleUsers.length,
  });

  for (let start = 0; start < eligibleUsers.length; start += OUTREACH_CONCURRENCY) {
    const batch = eligibleUsers.slice(start, start + OUTREACH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (candidate): Promise<OutreachResult> => {
        try {
          return await runOutreachForUser(candidate, asOf, outreachKey);
        } catch (error) {
          log.error('[ProactiveSms] Triggered SMS flow failed', {
            userId: candidate.userId,
            outreachKey,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          return 'failed';
        }
      })
    );
    results.push(...batchResults);
  }

  const summary = {
    considered: candidateUserIds?.length ?? eligibleUsers.length,
    eligible: eligibleUsers.length,
    sent: results.filter((result) => result === 'sent').length,
    skipped: results.filter((result) => result === 'skipped').length,
    failed: results.filter((result) => result === 'failed').length,
  };
  log.info('[ProactiveSms] Job finished', { ...summary, outreachKey });
  return summary;
}

async function acquireJobLease(ownerId: string): Promise<boolean> {
  const now = new Date();
  const liveCutoff = new Date(now.getTime() - JOB_LEASE_DURATION_MS);
  const expiresAt = new Date(now.getTime() + JOB_LEASE_DURATION_MS);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PROACTIVE_SMS_JOB_LEASE_KEY}))`;
    const existing = await tx.toolSideEffect.findUnique({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
      select: { status: true, updatedAt: true },
    });
    if (existing?.status === 'STARTED' && existing.updatedAt > liveCutoff) return false;

    await tx.toolSideEffect.upsert({
      where: { operationKey: PROACTIVE_SMS_JOB_LEASE_KEY },
      create: {
        operationKey: PROACTIVE_SMS_JOB_LEASE_KEY,
        operationType: JOB_LEASE_OPERATION_TYPE,
        status: 'STARTED',
        externalId: ownerId,
        request: { expiresAt: expiresAt.toISOString() },
      },
      update: {
        operationType: JOB_LEASE_OPERATION_TYPE,
        status: 'STARTED',
        externalId: ownerId,
        request: { expiresAt: expiresAt.toISOString() },
        error: null,
      },
    });
    return true;
  });
}

async function renewJobLease(ownerId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + JOB_LEASE_DURATION_MS);
  const result = await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: PROACTIVE_SMS_JOB_LEASE_KEY,
      operationType: JOB_LEASE_OPERATION_TYPE,
      status: 'STARTED',
      externalId: ownerId,
    },
    data: { request: { expiresAt: expiresAt.toISOString() } },
  });
  if (result.count === 0) {
    log.warn('[ProactiveSms] Job lease heartbeat lost ownership', { ownerId });
  }
}

async function releaseJobLease(ownerId: string): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: {
      operationKey: PROACTIVE_SMS_JOB_LEASE_KEY,
      operationType: JOB_LEASE_OPERATION_TYPE,
      status: 'STARTED',
      externalId: ownerId,
    },
    data: {
      status: 'RELEASED',
      response: { releasedAt: new Date().toISOString() },
    },
  });
}

export async function runProactiveSmsOutreachJobWithLease(
  options: ProactiveSmsJobOptions = {}
): Promise<ProactiveSmsLeasedJobResult> {
  const ownerId = randomUUID();
  if (!(await acquireJobLease(ownerId))) {
    log.info('[ProactiveSms] Job skipped because another replica holds the lease');
    return { acquired: false, summary: null };
  }

  const heartbeat = setInterval(() => {
    void renewJobLease(ownerId).catch((error) => {
      log.error('[ProactiveSms] Job lease heartbeat failed', {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, JOB_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return { acquired: true, summary: await runProactiveSmsOutreachJob(options) };
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseJobLease(ownerId);
    } catch (error) {
      log.error('[ProactiveSms] Job lease release failed', {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
