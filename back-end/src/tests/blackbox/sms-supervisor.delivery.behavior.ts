import type { PrismaClient } from '@prisma/client';

import { grep as userDataGrep } from '../../domains/data/service';
import { executeGrepTool } from '../../providers/smsSupervisor/supervisorTools.grep';
import { registerUserDataGrep } from '../../providers/userDataSearch';
import {
  BASE_URL,
  assertStatus,
  captureToken,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
  findSurgeCallForReply,
  provisionUserWithPhone,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';

export async function testSendUserMessage_continuesUntilSubstantiveResult(prisma: PrismaClient) {
  const probe = await request(`${BASE_URL}/api/test/captures`);
  if (probe.status !== 200) return;
  const cursor = (probe.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-progress-then-result');
  const progress = "I'll check now.";
  const result = 'I checked the thread. The plan changed after the follow-up message.';

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify([
        {
          reasoning: 'send progress without ending the run',
          tool_calls: [{ tool: 'send_user_message', arguments: { message: progress } }],
        },
        {
          reasoning: 'send the substantive result and then stop',
          tool_calls: [
            { tool: 'send_user_message', arguments: { message: result } },
            { tool: 'attempt_completion', arguments: {} },
          ],
        },
      ])
    );
    const response = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Please check the thread and explain what changed.',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(response.status, 200, response.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, progress));
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, result));
    const assistantMessages = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (session === null) return null;
      const messages = JSON.parse(session.messages) as Array<{ role?: string; content?: string }>;
      const assistants = messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content);
      return assistants.length === 2 ? assistants : null;
    });
    if (assistantMessages[0] !== progress || assistantMessages[1] !== result) {
      throw new Error(
        `Expected progress then substantive result in one run, got ${JSON.stringify(assistantMessages)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testGrep_fanOutPaginationMetadataAligns(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const person = await prisma.person.create({
    data: { userId, firstName: 'Pager', lastName: 'Fixture' },
  });

  try {
    await prisma.messageRecord.createMany({
      data: [1, 2, 3].map((index) => ({
        personId: person.id,
        channel: 'IMESSAGE',
        from: index % 2 === 0 ? 'me' : phone,
        to: index % 2 === 0 ? phone : 'me',
        timestamp: new Date(Date.now() + index * 1000),
        message: `Metadata page ${index}`,
        externalId: `metadata-page-${userId}-${index}`,
      })),
    });
    registerUserDataGrep(userDataGrep);
    const toolResult = await executeGrepTool(
      {
        pattern: 'Metadata page',
        source: null,
        '-B': null,
        '-A': null,
        '-C': null,
        context: null,
        '-n': null,
        '-i': null,
        head_limit: 1,
        offset: 1,
        multiline: null,
        filters: null,
        person: null,
        since: null,
      },
      userId
    );
    if (!toolResult.success) throw new Error(`Expected grep success: ${toolResult.error}`);
    const payload = JSON.parse(toolResult.result) as {
      applied_offset: number;
      returned: number;
      has_more: boolean;
      next_offset: number | null;
    };
    if (
      payload.applied_offset !== 1 ||
      payload.returned !== 1 ||
      payload.has_more !== true ||
      payload.next_offset !== 2
    ) {
      throw new Error(`Expected aligned fan-out pagination metadata, got ${toolResult.result}`);
    }
  } finally {
    await prisma.person.deleteMany({ where: { userId } });
    await cleanupSessionScopedUser(prisma, userId);
  }
}

export function smsDeliveryBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'grep -- mixed-source pagination metadata stays aligned',
      fn: () => testGrep_fanOutPaginationMetadataAligns(prisma),
    },
    {
      name: 'send -- progress SMS continues to a later substantive result',
      fn: () => testSendUserMessage_continuesUntilSubstantiveResult(prisma),
    },
  ];
}
