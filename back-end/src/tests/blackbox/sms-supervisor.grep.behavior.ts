/**
 * SMS supervisor grep behavior: the shared grep tool definition running on the
 * shared executor (domains/data/grepTool), exercised through the supervisor's
 * own grep tool.
 */
import type { PrismaClient } from '@prisma/client';

import { executeGatelessGrepTool as domainGrepTool } from '../../domains/data/grepTool';
import { GREP_TOOL_STRICT_PARAMETERS } from '../../providers/grepTool';
import { SmsSupervisorToolCallSchema } from '../../providers/smsSupervisor/schema';
import { executeGrepTool } from '../../providers/smsSupervisor/supervisorTools.grep';
import { registerUserDataGrepTool } from '../../providers/userDataSearch';
import {
  captureToken,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

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
        userId,
        channel: 'IMESSAGE',
        from: index % 2 === 0 ? 'me' : phone,
        to: index % 2 === 0 ? phone : 'me',
        timestamp: new Date(Date.now() + index * 1000),
        message: `Metadata page ${index}`,
        externalId: `metadata-page-${userId}-${index}`,
      })),
    });
    registerUserDataGrepTool(domainGrepTool);
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

// The supervisor runs the explore agent's grep: the shared definition on the
// shared executor, so root-only features (several sources, the summary
// inventory, literal retry of a broken regex) work here too.
export async function testGrep_smsRunsTheSharedGrepTool(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const person = await prisma.person.create({
    data: { userId, firstName: 'Shared', lastName: 'Contract' },
  });
  try {
    await prisma.messageRecord.create({
      data: {
        personId: person.id,
        userId,
        channel: 'IMESSAGE',
        from: phone,
        to: 'me',
        timestamp: new Date(),
        message: 'Gate code (rear) is 4471',
        externalId: `shared-contract-${userId}`,
      },
    });
    registerUserDataGrepTool(domainGrepTool);
    const parse = (result: { success: boolean; result: string; error?: string }) => {
      if (!result.success) throw new Error(`Expected grep success: ${result.error}`);
      return JSON.parse(result.result) as Record<string, unknown> & {
        sources: string[];
        matches: Array<{ content: string }>;
      };
    };

    const multi = parse(
      await executeGrepTool({ pattern: 'Gate code', sources: ['messages', 'documents'] }, userId)
    );
    if (multi.sources.join(',') !== 'messages,documents' || multi.matches.length !== 1) {
      throw new Error(`SMS multi-source grep failed: ${JSON.stringify(multi)}`);
    }
    const defaults = parse(await executeGrepTool({ pattern: 'Gate code' }, userId));
    if (
      defaults.sources.join(',') !== 'messages,network,agent_network' ||
      defaults.matches.length !== 1 ||
      !String(defaults.message).includes('no current agent tree')
    ) {
      throw new Error(
        `SMS default grep must search the documented defaults: ${JSON.stringify(defaults)}`
      );
    }
    const summary = parse(await executeGrepTool({ sources: ['summary'] }, userId));
    if (!String(summary.message).startsWith('LOCAL DATA SOURCES:')) {
      throw new Error(`SMS summary source failed: ${JSON.stringify(summary)}`);
    }
    const literal = parse(
      await executeGrepTool({ pattern: 'code (rear', source: 'messages' }, userId)
    );
    if (literal.literal_fallback !== true || literal.matches.length !== 1) {
      throw new Error(
        `SMS grep did not retry a broken regex literally: ${JSON.stringify(literal)}`
      );
    }
    // A strict-form call spells every absent key null, including all 12 per-source
    // filter blocks; null blocks name no source, so this searches the defaults.
    const strictProps = GREP_TOOL_STRICT_PARAMETERS.properties as Record<string, unknown>;
    const filterBranch = (strictProps.filters as { anyOf: Array<{ properties?: object }> })
      .anyOf[0];
    const strictCall = {
      ...Object.fromEntries(Object.keys(strictProps).map((key) => [key, null])),
      pattern: 'Gate code',
      filters: {
        ...Object.fromEntries(Object.keys(filterBranch.properties ?? {}).map((key) => [key, null])),
        since: '30d',
      },
    };
    const strict = parse(await executeGrepTool(strictCall, userId));
    if (
      strict.sources.join(',') !== 'messages,network,agent_network' ||
      strict.matches.length !== 1 ||
      String(strict.message).includes('not connected')
    ) {
      throw new Error(
        `a strict-form default grep must search the defaults: ${JSON.stringify(strict)}`
      );
    }
    // The supervisor dispatches the Zod-parsed call, where those nulls become undefined.
    const parsedCall = SmsSupervisorToolCallSchema.parse({ tool: 'grep', arguments: strictCall });
    const parsed = parse(
      await executeGrepTool(parsedCall.arguments as Record<string, unknown>, userId)
    );
    if (
      parsed.sources.join(',') !== 'messages,network,agent_network' ||
      parsed.matches.length !== 1
    ) {
      throw new Error(
        `a parsed strict-form grep must search the defaults: ${JSON.stringify(parsed)}`
      );
    }
    // No Plaid link: a named unconnected source is skipped with a notice, not searched silently.
    const mixed = parse(
      await executeGrepTool({ pattern: 'Gate code', sources: ['messages', 'transactions'] }, userId)
    );
    if (
      mixed.sources.join(',') !== 'messages' ||
      mixed.matches.length !== 1 ||
      !String(mixed.message).includes('not connected: transactions')
    ) {
      throw new Error(`SMS grep must report the unconnected source: ${JSON.stringify(mixed)}`);
    }
    const onlyUnconnected = parse(
      await executeGrepTool({ pattern: 'amazon', source: 'transactions', since: '30d' }, userId)
    );
    if (
      onlyUnconnected.matches.length !== 0 ||
      !String(onlyUnconnected.message).includes('roselabs.ai/connect/plaid')
    ) {
      throw new Error(
        `SMS grep on an unconnected source must say so: ${JSON.stringify(onlyUnconnected)}`
      );
    }
    const tree = await executeGrepTool({ pattern: 'x', source: 'agent_network' }, userId);
    if (tree.success || !String(tree.error).includes('agent_id is required')) {
      throw new Error(
        `agent_network without an agent tree must fail clearly: ${JSON.stringify(tree)}`
      );
    }
  } finally {
    await prisma.person.deleteMany({ where: { userId } });
    await cleanupSessionScopedUser(prisma, userId);
  }
}

export async function testGrep_priorAgentTrajectoryFromSms(prisma: PrismaClient) {
  const userId = await provisionUserWithPhone(prisma, uniqueSmsPhone());
  const token = captureToken('sms-prior-agent-trajectory');
  try {
    const prior = await prisma.agent.create({
      data: { userId, goal: 'Prior SMS agent decision', source: 'SMS', status: 'COMPLETED' },
    });
    await prisma.message.create({
      data: { agentId: prior.id, role: 'ASSISTANT', text: `Earlier decision ${token}` },
    });
    await prisma.message.create({
      data: { agentId: prior.id, role: 'USER', text: `Earlier request ${token}` },
    });
    await prisma.message.create({
      data: { agentId: prior.id, role: 'SYSTEM', text: `Earlier system ${token}` },
    });
    registerUserDataGrepTool(domainGrepTool);
    const result = await executeGrepTool(
      { pattern: token, source: 'agent_trajectories', filters: { surface: 'SMS' } },
      userId
    );
    if (!result.success) throw new Error(`Expected SMS trajectory grep success: ${result.error}`);
    const payload = JSON.parse(result.result) as {
      matches: Array<{ path: string; content: string }>;
    };
    if (
      payload.matches.length !== 2 ||
      !payload.matches[0].path.startsWith(`agent_trajectories/${prior.id}/`) ||
      !payload.matches[0].content.includes(token)
    ) {
      throw new Error(`SMS supervisor did not retrieve the prior agent message: ${result.result}`);
    }
    const metadataOnly = await executeGrepTool(
      { role: 'USER', record_kind: 'message', surface: 'SMS', trace_path: prior.id },
      userId
    );
    if (!metadataOnly.success) {
      throw new Error(`Expected SMS metadata grep success: ${metadataOnly.error}`);
    }
    const userMessages = JSON.parse(metadataOnly.result) as {
      matches: Array<{ role: string; content: string }>;
    };
    if (
      userMessages.matches.length !== 1 ||
      userMessages.matches[0].role !== 'USER' ||
      !userMessages.matches[0].content.includes(`Earlier request ${token}`)
    ) {
      throw new Error(`SMS metadata grep did not filter by role: ${metadataOnly.result}`);
    }
    const systemRole = await executeGrepTool(
      { role: 'SYSTEM', trace_path: prior.id, pattern: token },
      userId
    );
    if (systemRole.success) throw new Error('SMS grep accepted a SYSTEM role');
    const firstPage = await executeGrepTool(
      {
        source: 'agent_trajectories',
        trace_path: prior.id,
        pattern: token,
        record_kind: 'message',
        order: 'oldest_first',
        head_limit: 1,
      },
      userId
    );
    const firstData = JSON.parse(firstPage.result) as {
      next_page_after: string;
      matches: Array<{ path: string }>;
    };
    const secondPage = await executeGrepTool(
      {
        source: 'agent_trajectories',
        trace_path: prior.id,
        pattern: token,
        record_kind: 'message',
        order: 'oldest_first',
        head_limit: 1,
        page_after: firstData.next_page_after,
      },
      userId
    );
    const secondData = JSON.parse(secondPage.result) as { matches: Array<{ path: string }> };
    if (
      !firstPage.success ||
      !secondPage.success ||
      !firstData.next_page_after ||
      secondData.matches.length !== 1 ||
      firstData.matches[0].path === secondData.matches[0].path
    ) {
      throw new Error(`SMS grep did not advance the trajectory page: ${secondPage.result}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}
