#!/usr/bin/env tsx
/** Full API and database contract for cross-run agent trajectory grep. */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveTreeRolesAndPaging } from './agent-trajectories.paging';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { archiveJson } from '../../providers/traceArchive';
import type { ScopedDbFixture } from '../../providers/traceArchiveFixture';
import {
  indexArchivedTrace,
  indexArchivedTraceFromR2,
} from '../../providers/traceArchiveSearchIndex';

config();

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';
const ownerId = `trajectory-owner-${randomUUID()}`;
const otherId = `trajectory-other-${randomUUID()}`;

async function proveArchiveCannotTakeOverForeignRow(): Promise<void> {
  const messageId = randomUUID();
  const rootAgentId = randomUUID();
  const foreignRootAgentId = randomUUID();
  const capturedAt = new Date();
  await prisma.agentTrajectorySearch.create({
    data: {
      messageId,
      userId: otherId,
      rootAgentId: foreignRootAgentId,
      agentId: foreignRootAgentId,
      surface: 'WEB',
      role: 'ASSISTANT',
      createdAt: capturedAt,
      searchText: 'Foreign private row',
      agentGoal: 'Private',
      traceKind: 'message',
    },
  });
  try {
    await indexArchivedTrace(
      rootAgentId,
      {
        root_agent_id: rootAgentId,
        user_id: ownerId,
        agent_ids: [rootAgentId],
        captured_at: capturedAt.toISOString(),
        rows: {
          Agent: [{ id: rootAgentId, goal: 'Colliding archive', source: 'SMS' }],
          Message: [{ id: messageId, agentId: rootAgentId, role: 'TOOL', text: 'Collision' }],
        },
      } as ScopedDbFixture,
      []
    );
    const row = await prisma.agentTrajectorySearch.findUniqueOrThrow({ where: { messageId } });
    if (
      row.userId !== otherId ||
      row.rootAgentId !== foreignRootAgentId ||
      row.searchText !== 'Foreign private row'
    ) {
      throw new Error('Archive indexing overwrote another user’s trajectory row');
    }
  } finally {
    await prisma.agentTrajectorySearch.deleteMany({ where: { messageId } });
  }
}

async function proveR2OnlyHistory(): Promise<void> {
  const rootAgentId = randomUUID();
  const archivedMessageId = randomUUID();
  const oldBackend = process.env.TRACE_ARCHIVE_BACKEND;
  const oldDirectory = process.env.TRACE_ARCHIVE_LOCAL_DIR;
  const archiveDirectory =
    process.env.TRACE_ARCHIVE_LOCAL_DIR || join(process.cwd(), '..', '.context');
  process.env.TRACE_ARCHIVE_BACKEND = 'local';
  process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDirectory;
  try {
    const capturedAt = new Date().toISOString();
    const fixture = {
      root_agent_id: rootAgentId,
      user_id: ownerId,
      agent_ids: [rootAgentId],
      captured_at: capturedAt,
      rows: {
        Agent: [{ id: rootAgentId, goal: 'Archived SMS rollout', source: 'SMS' }],
        Message: [
          {
            id: archivedMessageId,
            agentId: rootAgentId,
            role: 'ASSISTANT',
            text: 'Archive-only rollout decision:\nship at 09:15 UTC',
            createdAt: capturedAt,
          },
        ],
      },
    };
    await archiveJson({
      rootAgentId,
      objectPath: 'manifest.json.gz.enc',
      value: {
        root_agent_id: rootAgentId,
        finalized: true,
        correlations: { root_agent_id: rootAgentId, user_id: ownerId },
      },
    });
    await archiveJson({ rootAgentId, objectPath: 'db/end.fixture.json.gz.enc', value: fixture });
    await archiveJson({
      rootAgentId,
      objectPath: 'llm/rollout.json.gz.enc',
      value: {
        root_agent_id: rootAgentId,
        agent_id: rootAgentId,
        ts_ms: Date.now() + 10_000,
        messages: [
          { role: 'system', content: 'Archive-only hidden system token: private-84' },
          { role: 'user', content: '[SYSTEM]: Archive-only hidden system token: private-84' },
          { role: 'tool', content: 'Archive-only tool diagnosis: missing lilac-83' },
          { role: 'assistant', content: fixture.rows.Message[0].text },
        ],
        output: 'Archive-only LLM fix: enabled lilac-83',
      },
    });
    const path = `agent_trajectories/${rootAgentId}`;
    requireResult(
      await grep(otherId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { path },
      }),
      0
    );
    const result = await grep(ownerId, {
      source: 'agent_trajectories',
      pattern: 'Archive-only',
      filters: { path },
    });
    const found = requireResult(result, 2);
    if ((found[0].location as { field?: string } | undefined)?.field === 'message') {
      throw new Error(`An older stored message displaced a newer trace: ${JSON.stringify(found)}`);
    }
    const mixed = requireResult(
      await grep(ownerId, {
        sources: ['agent_trajectories', 'messages'],
        pattern: 'Archive-only',
      }),
      2
    );
    if ((mixed[0].location as { field?: string } | undefined)?.field === 'message') {
      throw new Error(`Mixed-source grep lost chronological order: ${JSON.stringify(mixed)}`);
    }
    const [first] = requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { path, record_kind: 'message' },
        head_limit: 1,
      }),
      1
    );
    if (
      !String(first.path).endsWith(`/ASSISTANT/${archivedMessageId}`) ||
      !String(first.content).includes('ship at 09:15 UTC')
    ) {
      throw new Error(
        `Stored archive message filter returned the wrong hit: ${JSON.stringify(first)}`
      );
    }
    const [modelOutput] = requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { record_kind: 'llm_output' },
      }),
      1
    );
    if (!String(modelOutput.content).includes('enabled lilac-83')) {
      throw new Error(`Model output filter returned the wrong hit: ${JSON.stringify(modelOutput)}`);
    }
    const allRows = requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { path, record_kind: 'all' },
      }),
      3
    );
    const archivedPaths: string[] = [];
    let pageAfter: string | undefined;
    do {
      const page = await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        trace_path: path,
        record_kind: 'all',
        head_limit: 1,
        ...(pageAfter ? { page_after: pageAfter } : {}),
      });
      const [hit] = requireResult(page, 1);
      archivedPaths.push(String(hit.path));
      pageAfter = (page.data as { next_page_after?: string | null }).next_page_after ?? undefined;
    } while (pageAfter !== undefined && archivedPaths.length <= allRows.length);
    if (archivedPaths.join('|') !== allRows.map((row) => row.path).join('|')) {
      throw new Error(`Archived cursor skipped or repeated R2 rows: ${archivedPaths.join(', ')}`);
    }
    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { path, record_kind: 'llm_context' },
      }),
      1
    );
    const [secondPage] = requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'Archive-only',
        filters: { path },
        head_limit: 1,
        offset: 1,
      }),
      1
    );
    if (secondPage.path === found[0].path) {
      throw new Error(`Trajectory pagination repeated the first hit: ${JSON.stringify(found)}`);
    }
    const indexed = await prisma.agentTrajectorySearch.count({ where: { rootAgentId } });
    if (indexed !== 3) throw new Error(`Expected 3 non-SYSTEM archived rows, got ${indexed}`);
    if (!found.every((match) => String(match.pointer).includes('trace-archive'))) {
      throw new Error(`R2-only rows have no archive pointer: ${JSON.stringify(found)}`);
    }
    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'lilac-83',
        filters: {
          path: allRows.find((match) => match.role === 'TOOL')?.path,
          record_kind: 'llm_context',
        },
      }),
      1
    );
    requireResult(
      await grep(otherId, { source: 'agent_trajectories', pattern: 'Archive-only' }),
      0
    );
    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'private-84',
        record_kind: 'all',
      }),
      0
    );
    const rejectedSystem = await grep(ownerId, {
      source: 'agent_trajectories',
      pattern: 'private-84',
      role: 'SYSTEM',
      trace_path: path,
    });
    if (rejectedSystem.status !== 400) {
      throw new Error(`Archived SYSTEM role was accepted: ${JSON.stringify(rejectedSystem)}`);
    }
    const changedFixture = {
      ...fixture,
      rows: {
        ...fixture.rows,
        Message: [{ ...fixture.rows.Message[0], text: 'Incorrect partial update' }],
      },
    } as unknown as ScopedDbFixture;
    let failed = false;
    try {
      await indexArchivedTrace(rootAgentId, changedFixture, ['llm/missing.json.gz.enc']);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error('Missing LLM artifact did not fail indexing');
    const preserved = await prisma.agentTrajectorySearch.findUnique({
      where: { messageId: archivedMessageId },
      select: { searchText: true },
    });
    if (preserved?.searchText !== fixture.rows.Message[0].text) {
      throw new Error('Failed archive update partially changed the search index');
    }
    await indexArchivedTrace(
      rootAgentId,
      {
        ...changedFixture,
        rows: { ...changedFixture.rows, Message: [] },
      },
      []
    );
    const removed = await prisma.agentTrajectorySearch.count({ where: { rootAgentId } });
    if (removed !== 0) throw new Error(`Rebuilt archive retained ${removed} stale rows`);
  } finally {
    await prisma.agentTrajectorySearch.deleteMany({ where: { rootAgentId } });
    rmSync(join(archiveDirectory, 'trace-archive', rootAgentId), { recursive: true, force: true });
    if (oldBackend === undefined) delete process.env.TRACE_ARCHIVE_BACKEND;
    else process.env.TRACE_ARCHIVE_BACKEND = oldBackend;
    if (oldDirectory === undefined) delete process.env.TRACE_ARCHIVE_LOCAL_DIR;
    else process.env.TRACE_ARCHIVE_LOCAL_DIR = oldDirectory;
  }
}

async function provePartialArchiveHistory(): Promise<void> {
  const rootAgentId = randomUUID();
  const childId = randomUUID();
  const oldBackend = process.env.TRACE_ARCHIVE_BACKEND;
  const oldDirectory = process.env.TRACE_ARCHIVE_LOCAL_DIR;
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'trajectory-partial-test-'));
  process.env.TRACE_ARCHIVE_BACKEND = 'local';
  process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDirectory;
  try {
    await prisma.agent.create({
      data: { id: rootAgentId, userId: ownerId, goal: 'Partial archive' },
    });
    const fixture = {
      root_agent_id: rootAgentId,
      user_id: ownerId,
      agent_ids: [rootAgentId],
      captured_at: new Date().toISOString(),
      rows: {
        Agent: [{ id: rootAgentId, goal: 'Partial archive', source: 'WEB' }],
        Message: [
          {
            id: randomUUID(),
            agentId: rootAgentId,
            role: 'USER',
            text: 'Partial archive request for violet-61',
          },
        ],
      },
    };
    await archiveJson({
      rootAgentId,
      objectPath: 'manifest.json.gz.enc',
      value: {
        root_agent_id: rootAgentId,
        finalized: false,
        correlations: { root_agent_id: rootAgentId, user_id: ownerId },
      },
    });
    await archiveJson({ rootAgentId, objectPath: 'db/start.fixture.json.gz.enc', value: fixture });
    await archiveJson({
      rootAgentId,
      objectPath: 'llm/child.json.gz.enc',
      value: {
        root_agent_id: rootAgentId,
        agent_id: childId,
        messages: [{ role: 'tool', content: 'Partial archive child result violet-61' }],
      },
    });
    if ((await indexArchivedTraceFromR2(rootAgentId)) !== 0) {
      throw new Error('An active partial archive became searchable');
    }
    await prisma.agent.delete({ where: { id: rootAgentId } });
    if ((await indexArchivedTraceFromR2(rootAgentId)) !== 2) {
      throw new Error('A stopped partial archive lost its root or child history');
    }
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'violet-61' }), 1);
    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'violet-61',
        filters: { record_kind: 'all' },
      }),
      2
    );
    requireResult(await grep(otherId, { source: 'agent_trajectories', pattern: 'violet-61' }), 0);
  } finally {
    await prisma.agentTrajectorySearch.deleteMany({ where: { rootAgentId } });
    await prisma.agent.deleteMany({ where: { id: rootAgentId } });
    rmSync(archiveDirectory, { recursive: true, force: true });
    if (oldBackend === undefined) delete process.env.TRACE_ARCHIVE_BACKEND;
    else process.env.TRACE_ARCHIVE_BACKEND = oldBackend;
    if (oldDirectory === undefined) delete process.env.TRACE_ARCHIVE_LOCAL_DIR;
    else process.env.TRACE_ARCHIVE_LOCAL_DIR = oldDirectory;
  }
}

async function grep(userId: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/data/grep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-User-Id': userId },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

function matches(data: unknown): Array<Record<string, unknown>> {
  const value = data as { matches?: Array<Record<string, unknown>> };
  if (!Array.isArray(value.matches)) throw new Error(`Missing matches: ${JSON.stringify(data)}`);
  return value.matches;
}

function requireResult(result: { status: number; data: unknown }, expectedCount: number) {
  const found = matches(result.data);
  if (result.status !== 200 || found.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} trajectory hits, got ${JSON.stringify(result)}`);
  }
  return found;
}

async function run(): Promise<void> {
  const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'AgentTrajectorySearch'
  `;
  if (
    !indexes.some((index) => index.indexdef.includes('gin_trgm_ops')) ||
    !indexes.some((index) => index.indexname === 'AgentTrajectorySearch_user_root_time_idx') ||
    !indexes.some((index) => index.indexname === 'AgentTrajectorySearch_user_role_kind_time_idx')
  ) {
    throw new Error(`Trajectory search indexes missing: ${JSON.stringify(indexes)}`);
  }
  await prisma.user.createMany({ data: [{ userId: ownerId }, { userId: otherId }] });
  try {
    const [prior, sms, current, foreign] = await Promise.all([
      prisma.agent.create({
        data: { userId: ownerId, goal: 'prior chat', source: 'WEB', status: 'COMPLETED' },
      }),
      prisma.agent.create({
        data: { userId: ownerId, goal: 'prior SMS', source: 'SMS', status: 'COMPLETED' },
      }),
      prisma.agent.create({ data: { userId: ownerId, goal: 'current task', source: 'WEB' } }),
      prisma.agent.create({ data: { userId: otherId, goal: 'foreign run', source: 'WEB' } }),
    ]);
    const [priorChild, currentChild] = await Promise.all([
      prisma.agent.create({
        data: { userId: ownerId, goal: 'prior Temporal child', parentAgentId: prior.id, depth: 1 },
      }),
      prisma.agent.create({
        data: { userId: ownerId, goal: 'current child', parentAgentId: current.id, depth: 1 },
      }),
    ]);
    const [chatMessage, toolMessage] = await Promise.all([
      prisma.message.create({
        data: { agentId: prior.id, role: 'ASSISTANT', text: 'Orchid rollout code: maple-73' },
      }),
      prisma.message.create({
        data: {
          agentId: priorChild.id,
          role: 'TOOL',
          text: '**Status**: ❌ FAILED\nOrchid deploy error: missing banner_mode',
        },
      }),
    ]);
    await prisma.message.createMany({
      data: [
        { agentId: sms.id, role: 'USER', text: 'Orchid SMS instruction: dispatch at noon' },
        { agentId: currentChild.id, role: 'TOOL', text: 'Orchid current-only decoy' },
        { agentId: foreign.id, role: 'ASSISTANT', text: 'Orchid foreign-only decoy' },
        { agentId: prior.id, role: 'SYSTEM', text: 'Orchid system-only decoy' },
      ],
    });
    const indexedSystem = await prisma.agentTrajectorySearch.count({
      where: { rootAgentId: prior.id, role: 'SYSTEM' },
    });
    if (indexedSystem !== 0) {
      throw new Error(`Live SYSTEM messages were indexed: ${indexedSystem}`);
    }

    const scoped = await grep(ownerId, {
      source: 'agent_trajectories',
      pattern: 'Orchid',
      agent_id: current.id,
    });
    const found = requireResult(scoped, 3);
    const content = JSON.stringify(found);
    if (
      content.includes('current-only') ||
      content.includes('foreign-only') ||
      content.includes('system-only')
    ) {
      throw new Error(`Scope leaked a current, foreign, or system message: ${content}`);
    }
    const tool = found.find((match) => match.role === 'TOOL');
    if (
      !tool ||
      !(tool.path as string).includes(prior.id) ||
      !(tool.path as string).includes(priorChild.id)
    ) {
      throw new Error(`Missing prior child root/agent path: ${JSON.stringify(found)}`);
    }
    if (!String(tool.content).includes('tool_status: ❌ FAILED')) {
      throw new Error(`Tool status was lost from the matching snippet: ${JSON.stringify(tool)}`);
    }
    if (
      !String(tool.content).includes(`trace_path: ${tool.path}\nmessage_role: TOOL\nagent_title:`)
    ) {
      throw new Error(`Message path or role was lost from the citation: ${JSON.stringify(tool)}`);
    }
    requireResult(
      await grep(ownerId, { source: 'agent_trajectories', pattern: 'current-only' }),
      0
    );

    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'banner_mode',
        filters: { path: tool.path, role: 'TOOL', surface: 'WEB' },
        agent_id: current.id,
      }),
      1
    );
    requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'dispatch at noon',
        filters: { surface: 'SMS' },
      }),
      1
    );
    const [userMessage] = requireResult(
      await grep(ownerId, {
        source: 'agent_trajectories',
        pattern: 'dispatch at noon',
        filters: { path: sms.id, role: 'user', record_kind: 'MESSAGE', surface: 'sms' },
      }),
      1
    );
    if (userMessage.role !== 'USER' || !String(userMessage.path).includes(sms.id)) {
      throw new Error(
        `Trajectory role/root filters lost the user's message: ${JSON.stringify(userMessage)}`
      );
    }
    const [typedUserMessage] = requireResult(
      await grep(ownerId, {
        role: 'user',
        record_kind: 'MESSAGE',
        surface: 'sms',
        trace_path: sms.id,
      }),
      1
    );
    if (typedUserMessage.path !== userMessage.path) {
      throw new Error('Typed trajectory parameters did not resolve the original USER message');
    }
    await proveTreeRolesAndPaging(grep, ownerId, otherId, prior.id, priorChild.id, current.id);
    const [mixedUserMessage] = requireResult(
      await grep(ownerId, {
        sources: ['agent_network', 'agent_trajectories'],
        pattern: 'dispatch at noon',
        role: 'USER',
        record_kind: 'message',
        agent_id: current.id,
      }),
      1
    );
    if (mixedUserMessage.path !== userMessage.path) {
      throw new Error('Typed role filter failed in a multi-source search');
    }
    requireResult(
      await grep(ownerId, {
        source: 'agent_network',
        agent_id: current.id,
        pattern: 'Orchid current-only decoy',
        role: 'USER',
      }),
      0
    );
    const invalidRole = await grep(ownerId, { source: 'agent_network', role: 12 });
    if (invalidRole.status !== 400) {
      throw new Error(
        `Malformed role should be rejected as client input: ${JSON.stringify(invalidRole)}`
      );
    }
    requireResult(await grep(otherId, { source: 'agent_trajectories', pattern: 'maple-73' }), 0);
    const forbidden = await grep(ownerId, {
      source: 'agent_trajectories',
      pattern: 'Orchid',
      agent_id: foreign.id,
    });
    if (forbidden.status !== 403)
      throw new Error(`Foreign agent ID accepted: ${JSON.stringify(forbidden)}`);

    await prisma.message.update({
      where: { id: chatMessage.id },
      data: { text: 'Orchid rollout code: maple-74' },
    });
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'maple-73' }), 0);
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'maple-74' }), 1);
    await prisma.agentTrajectorySearch.update({
      where: { messageId: chatMessage.id },
      data: { archivePath: 'db/end.fixture.json.gz.enc' },
    });
    await prisma.message.update({
      where: { id: chatMessage.id },
      data: { text: 'Orchid rollout code: maple-75' },
    });
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'maple-74' }), 1);
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'maple-75' }), 0);
    await prisma.message.delete({ where: { id: toolMessage.id } });
    requireResult(await grep(ownerId, { source: 'agent_trajectories', pattern: 'banner_mode' }), 0);
    await proveR2OnlyHistory();
    await proveArchiveCannotTakeOverForeignRow();
    await provePartialArchiveHistory();
    process.stdout.write('✅ agent_trajectories blackbox passed\n');
  } finally {
    await prisma.agent.deleteMany({
      where: { userId: { in: [ownerId, otherId] }, parentAgentId: { not: null } },
    });
    await prisma.agent.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
