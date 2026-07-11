/**
 * Scheduled proactive SMS outreach.
 *
 * Wednesday/Sunday cron -> active subscribers -> no root task in trailing 7d
 * -> inject a synthetic inbound turn into the existing SMS supervisor flow.
 */

import { prisma } from '../database';
import { createLogger } from '../logger';
import { handleSmsSupervisorMessage } from './supervisorHandler';

const log = createLogger('ProactiveSms');

export const PROACTIVE_SMS_CRON_EXPRESSION = '0 10 * * 0,3';
export const PROACTIVE_SMS_TIME_ZONE = 'America/Los_Angeles';
export const PROACTIVE_SMS_OUTREACH_PROMPT = `This is a scheduled proactive check-in. Review the person you support using the context and tools available to you, then respond with a concise SMS suggesting something you believe would be genuinely helpful for them right now. Do not mention this scheduled trigger, their subscription, or their inactivity.`;

const INACTIVITY_DAYS = 7;
const OUTREACH_CONCURRENCY = 5;

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
  const session = await prisma.smsSession.upsert({
    where: { userId: candidate.userId },
    update: {},
    create: { userId: candidate.userId, messages: JSON.stringify([]) },
    select: { lastInboundSeq: true, messages: true },
  });
  if (
    parseStoredMessages(session.messages).some(
      (message) =>
        message.role === 'user' && message.content.includes(`outreach key: ${outreachKey}.`)
    )
  ) {
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
    commitGuard: () => isStillEligible(candidate, asOf),
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
