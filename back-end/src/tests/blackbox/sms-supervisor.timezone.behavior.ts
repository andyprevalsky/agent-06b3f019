import { IntegrationStatus, IntegrationType, type PrismaClient } from '@prisma/client';
import { buildSmsContext } from '../../providers/smsSupervisor/contextBuilder';
import { provisionUserWithPhone, uniqueSmsPhone } from './sms-supervisor.helpers';

const INCIDENT_INSTANT = '2026-07-20T20:26:48.771Z';

function assertUnknownTimeZoneGuard(contextUserMessage: string): void {
  const guard = "User time zone: unknown. Do not infer the user's local date or time from UTC.";
  if (!contextUserMessage.includes(guard)) {
    throw new Error(`Unknown-zone SMS state omitted the guardrail: ${contextUserMessage}`);
  }
  for (const forbidden of [
    'unavailable',
    'Current UTC time:',
    'User local date:',
    'User local time:',
    'America/Los_Angeles',
  ]) {
    if (contextUserMessage.includes(forbidden)) {
      throw new Error(`Unknown-zone SMS state included "${forbidden}": ${contextUserMessage}`);
    }
  }
  if (!contextUserMessage.startsWith('Current state (as of ')) {
    throw new Error(`Unknown-zone SMS state omitted its UTC snapshot: ${contextUserMessage}`);
  }
}

export async function testContext_rendersFingerprintTimeZone(prisma: PrismaClient): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const originalDate = globalThis.Date;

  class FrozenDate extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? INCIDENT_INSTANT);
    }

    static now(): number {
      return new originalDate(INCIDENT_INSTANT).getTime();
    }
  }

  try {
    await prisma.integration.create({
      data: {
        userId,
        name: 'browser_fingerprint',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config: {
          fingerprint: {
            timezone: 'America/Los_Angeles',
            collectedAt: INCIDENT_INSTANT,
          },
        },
      },
    });

    globalThis.Date = FrozenDate as DateConstructor;
    const context = await buildSmsContext(userId);

    if (!context.contextUserMessage.includes(`Current UTC time: ${INCIDENT_INSTANT}`)) {
      throw new Error(`SMS state omitted the incident UTC instant: ${context.contextUserMessage}`);
    }
    if (!context.contextUserMessage.includes('User time zone: America/Los_Angeles')) {
      throw new Error(`SMS state omitted the fingerprint IANA zone: ${context.contextUserMessage}`);
    }
    if (!context.contextUserMessage.includes('User local time: 1:26 PM PDT')) {
      throw new Error(`SMS state omitted the incident local clock: ${context.contextUserMessage}`);
    }
  } finally {
    globalThis.Date = originalDate;
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.smsSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

export async function testContext_guardsUnknownTimeZone(prisma: PrismaClient): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);

  try {
    await prisma.user.update({
      where: { userId },
      data: { city: 'San Francisco', state: 'CA', country: 'US' },
    });
    await prisma.integration.create({
      data: {
        userId,
        name: 'browser_fingerprint',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config: { fingerprint: { timezone: 'Pacific/San_Francisco' } },
      },
    });

    const invalidContext = await buildSmsContext(userId);
    assertUnknownTimeZoneGuard(invalidContext.contextUserMessage);

    await prisma.integration.deleteMany({ where: { userId } });
    const missingContext = await buildSmsContext(userId);
    assertUnknownTimeZoneGuard(missingContext.contextUserMessage);
  } finally {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.smsSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

export function smsTimezoneBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'context -- incident UTC instant renders in the fingerprint IANA zone',
      fn: () => testContext_rendersFingerprintTimeZone(prisma),
    },
    {
      name: 'context -- invalid or missing fingerprint zone forbids local-time assumptions',
      fn: () => testContext_guardsUnknownTimeZone(prisma),
    },
  ];
}
