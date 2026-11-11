/** Pure persistence boundary: real message idempotency, in-memory Message delegate, no services. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Prisma, type Message } from '@prisma/client';
import { createSessionSchema as claudeSchema } from '../../domains/claude-code/types';
import { createSessionSchema as codexSchema } from '../../domains/codex-code/types';
import {
  codeResumeConfigMessage,
  compatibleResumeCliSettings,
  type CodeAgentResumeConfig,
} from '../../providers/codeAgentResumeConfig';
import {
  persistCodeResumeConfig,
  resumeLaunchCliSettings,
} from '../../providers/codeAgentResumeConfigStore';
import { prisma } from '../../providers/database';
import { idempotentMessageId } from '../../providers/messageIdempotency';

const agentId = '11111111-1111-4111-8111-111111111111';
const config: CodeAgentResumeConfig = {
  spawn_args: {
    type: 'code',
    goal: 'Original raw goal',
    target: 'local',
    task_name: 'coder',
    github_repo_link: 'https://github.com/example/project',
    attachments: ['spec.txt'],
    output_schema: {
      fields: [
        {
          name: 'result',
          type: 'list[object]',
          required: true,
          properties: [{ name: 'report', type: 'file_pointer', nullable: false }],
        },
      ],
    },
  },
  attachments: [
    {
      id: 'file-1',
      storage_path: 'owner/spec.txt',
      original_filename: 'spec.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      created_at: '2026-11-10T00:00:00Z',
    },
  ],
  model: 'rose-labs/rose-1-ultra',
  fast_mode_cache_enabled: true,
};
const envs = {
  CLAUDE_CODE_MODEL: 'claude-opus-5-5',
  CLAUDE_CODE_EFFORT: 'high',
  CLAUDE_CODE_SPEED: 'standard',
  CODEX_MODEL: 'gpt-6.1-sol',
  CODEX_REASONING_EFFORT: 'xhigh',
  CODEX_SPEED: 'priority',
  ANTHROPIC_API_KEY: 'must-not-be-stored',
  CODE_SESSION_TURN_TOKEN: 'must-not-be-stored',
};
const input = (taskId = 'task-1') => ({
  agentId,
  taskId,
  leaseOwner: `tool:${agentId}:tool:with:colons`,
  resumeConfig: config,
  provider: 'claude' as const,
  envs,
});

test('credential provider failover drops only an incompatible model override', () => {
  const original = {
    model: 'claude-opus-5-5',
    reasoning_effort: 'high' as const,
    speed: 'fast' as const,
  };
  assert.deepEqual(compatibleResumeCliSettings('claude', 'claude', original), original);
  assert.deepEqual(compatibleResumeCliSettings('codex', 'claude', original), {
    reasoning_effort: 'high',
    speed: 'fast',
  });
  assert.deepEqual(compatibleResumeCliSettings('claude', 'codex', original), {
    reasoning_effort: 'high',
    speed: 'fast',
  });
  assert.equal(original.model, 'claude-opus-5-5');
});

test('both create APIs accept the exact optional resume configuration', () => {
  for (const schema of [claudeSchema, codexSchema]) {
    const body = {
      agent_id: agentId,
      user_id: agentId,
      goal: 'Wrapped handoff goal',
      lease_owner: input().leaseOwner,
      resume_config: config,
    };
    assert.deepEqual(schema.parse(body).resume_config, config);
    assert.equal(schema.safeParse({ ...body, lease_owner: undefined }).success, false);
    assert.equal(
      schema.safeParse({ ...body, lease_owner: 'tool:another-agent:call' }).success,
      false
    );
    assert.equal(
      schema.safeParse({
        ...body,
        resume_config: { ...config, cli_settings: { model: 'spoofed' } },
      }).success,
      false
    );
    assert.equal(
      schema.safeParse({
        ...body,
        resume_config: {
          ...config,
          spawn_args: {
            ...config.spawn_args,
            github_repo_link: 'https://secret@github.com/org/repo',
          },
        },
      }).success,
      false
    );
    assert.equal(schema.parse({ ...body, resume_config: undefined }).resume_config, undefined);
    assert.equal(schema.safeParse({ ...body, resume_config: { ...config, envs } }).success, false);
    assert.equal(
      schema.safeParse({
        ...body,
        resume_config: {
          ...config,
          spawn_args: { ...config.spawn_args, output_schema: null },
        },
      }).success,
      false
    );
  }
});

test('serialization preserves the raw contract and selects exact launcher settings without secrets', () => {
  const original = JSON.stringify(config);
  for (const provider of ['claude', 'codex'] as const) {
    const message = codeResumeConfigMessage({ ...input(), provider });
    assert.ok(message);
    assert.equal(message.metadata.toolCallId, 'tool:with:colons');
    assert.equal(message.metadata.action_type, 'code_resume_config');
    assert.equal(message.metadata.codeResumeTaskId, 'task-1');
    assert.equal(
      'task_id' in message.metadata,
      false,
      'an unstarted snapshot is not a code-session chip'
    );
    assert.equal(message.metadata.hidden, true);
    assert.equal(message.metadata.excludeFromModel, true);
    assert.equal(message.skipBroadcast, true);
    assert.deepEqual(message.metadata.codeAgentResumeConfig.spawn_args, config.spawn_args);
    assert.deepEqual(message.metadata.codeAgentResumeConfig.attachments, config.attachments);
    assert.deepEqual(
      message.metadata.codeAgentResumeConfig.cli_settings,
      provider === 'claude'
        ? { model: 'claude-opus-5-5', reasoning_effort: 'high', speed: 'standard' }
        : { model: 'gpt-6.1-sol', reasoning_effort: 'xhigh', speed: 'priority' }
    );
    assert.equal(message.metadata.codeAgentResumeConfig.code_provider, provider);
    const execution = {
      github_repo_link: 'https://github.com/example/resolved',
      target: 'cloud' as const,
      code_session_id: agentId,
    };
    const resolved = codeResumeConfigMessage({ ...input(), provider, execution });
    assert.deepEqual(resolved?.metadata.codeAgentResumeConfig.execution, execution);
    assert.deepEqual(resolved?.metadata.codeAgentResumeConfig.spawn_args, config.spawn_args);
    assert.equal(JSON.stringify(message).includes('must-not-be-stored'), false);
    message.metadata.codeAgentResumeConfig.spawn_args.goal = 'mutation of returned snapshot';
    assert.equal(JSON.stringify(config), original, 'the snapshot owns a deep copy');
  }
});

test('missing historical inputs stay absent; a new snapshot requires an owned lease and resolved settings', () => {
  assert.equal(codeResumeConfigMessage({ ...input(), resumeConfig: undefined }), null);
  assert.throws(
    () => codeResumeConfigMessage({ ...input(), leaseOwner: 'tool:other:call' }),
    /owning spawn/
  );
  assert.throws(
    () => codeResumeConfigMessage({ ...input(), leaseOwner: `tool:${agentId}:` }),
    /owning spawn/
  );
  assert.throws(() => codeResumeConfigMessage({ ...input(), envs: {} }));
});

const rows = new Map<string, Message>();
const findUnique = prisma.message.findUnique;
const findFirst = prisma.message.findFirst;
const create = prisma.message.create;
let inserts = 0;
Object.assign(prisma.message, {
  findUnique: async (args: { where: { id: string } }) => rows.get(args.where.id) ?? null,
  create: async (args: { data: Message }) => {
    if (rows.has(args.data.id))
      throw new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      });
    inserts++;
    rows.set(args.data.id, { ...args.data, timestamp: new Date(inserts * 1000) });
    return args.data;
  },
  findFirst: async (args: {
    where: {
      agentId: string;
      AND: Array<{
        metadata: { path: string[]; equals?: string; not?: unknown };
      }>;
    };
  }) => {
    const matches = [...rows.values()].filter(
      (row) =>
        row.agentId === args.where.agentId &&
        args.where.AND.every(({ metadata }) => {
          let value: unknown = row.metadata;
          for (const key of metadata.path) {
            value =
              value !== null && typeof value === 'object'
                ? (value as Record<string, unknown>)[key]
                : undefined;
          }
          return 'not' in metadata
            ? value !== null && value !== undefined
            : value === metadata.equals;
        })
    );
    return matches.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] ?? null;
  },
});
after(() => {
  prisma.message.findUnique = findUnique;
  prisma.message.findFirst = findFirst;
  prisma.message.create = create;
});

test('concurrent/retried writes retain one immutable snapshot per task, independently per owner', async () => {
  const first = input('immutable-task');
  await Promise.all([persistCodeResumeConfig(first), persistCodeResumeConfig(first)]);
  await persistCodeResumeConfig({ ...first, envs: { ...envs, CLAUDE_CODE_EFFORT: 'low' } });
  assert.equal(inserts, 1);
  const message = codeResumeConfigMessage(first);
  assert.ok(message);
  const id = idempotentMessageId(message);
  assert.ok(id);
  const stored = rows.get(id);
  assert.ok(stored);
  assert.equal(JSON.stringify(stored.metadata), JSON.stringify(message.metadata));
  await persistCodeResumeConfig(input('another-task'));
  const otherAgent = '22222222-2222-4222-8222-222222222222';
  await persistCodeResumeConfig({
    ...first,
    agentId: otherAgent,
    leaseOwner: `tool:${otherAgent}:call`,
  });
  assert.equal(inserts, 3);
});

test('owner wakes inherit newest same-spawn settings, merge partial overrides and isolate other spawns', async () => {
  await persistCodeResumeConfig({
    ...input('latest-run'),
    envs: { ...envs, CLAUDE_CODE_MODEL: 'claude-latest', CLAUDE_CODE_EFFORT: 'medium' },
  });
  assert.deepEqual(
    await resumeLaunchCliSettings(agentId, 'claude', input().leaseOwner, { speed: 'fast' }),
    { model: 'claude-latest', reasoning_effort: 'medium', speed: 'fast' }
  );
  assert.deepEqual(
    await resumeLaunchCliSettings(agentId, 'claude', input().leaseOwner, { model: undefined }),
    { model: 'claude-latest', reasoning_effort: 'medium', speed: 'standard' }
  );
  assert.equal(
    await resumeLaunchCliSettings(agentId, 'claude', `tool:${agentId}:different-spawn`, undefined),
    undefined
  );
  assert.equal(
    await resumeLaunchCliSettings(agentId, 'codex', input().leaseOwner, undefined),
    undefined
  );
  assert.equal(
    await resumeLaunchCliSettings(
      'other-agent',
      'claude',
      'tool:other-agent:tool:with:colons',
      undefined
    ),
    undefined
  );
  const latest = [...rows.values()].find(
    (row) => (row.metadata as Record<string, unknown>)?.codeResumeTaskId === 'latest-run'
  );
  assert.ok(latest);
  const metadata = latest.metadata as Record<string, unknown>;
  const saved = metadata.codeAgentResumeConfig as Record<string, unknown>;
  const settings = saved.cli_settings;
  saved.cli_settings = { model: 'incomplete-historical-config' };
  try {
    await assert.rejects(resumeLaunchCliSettings(agentId, 'claude', input().leaseOwner, undefined));
  } finally {
    saved.cli_settings = settings;
  }
});

test('later complete live receipts override launch settings; partial requests and other spawns do not', async () => {
  const base = [...rows.values()][0];
  assert.ok(base);
  const add = (
    id: string,
    toolCallId: string,
    provider: string,
    at: number,
    metadata: Record<string, unknown>
  ) =>
    rows.set(id, {
      ...base,
      id,
      timestamp: new Date(at),
      metadata: {
        action_type: 'user_direct_turn',
        toolCallId,
        code_provider: provider,
        ...metadata,
      } as Prisma.JsonObject,
    });
  const effective = { model: 'live-model', effort: 'xhigh', speed: 'fast' };
  add('live', 'tool:with:colons', 'claude', 6000, { effective_settings: effective });
  add('partial', 'tool:with:colons', 'claude', 9000, { effective_settings: { model: 'partial' } });
  add('requested', 'tool:with:colons', 'claude', 10000, { settings: effective });
  add('foreign-spawn', 'different', 'claude', 11000, { effective_settings: effective });
  add('foreign-provider', 'tool:with:colons', 'codex', 12000, { effective_settings: effective });
  assert.deepEqual(
    await resumeLaunchCliSettings(agentId, 'claude', input().leaseOwner, { speed: 'standard' }),
    { model: 'live-model', reasoning_effort: 'xhigh', speed: 'standard' }
  );
  add('historical', 'historical-call', 'claude', 13000, { effective_settings: effective });
  assert.deepEqual(
    await resumeLaunchCliSettings(agentId, 'claude', `tool:${agentId}:historical-call`, undefined),
    { model: 'live-model', reasoning_effort: 'xhigh', speed: 'fast' }
  );
});
