/**
 * Resume recovery cases for claude-code-direct-chat.blackbox.ts (its sandbox,
 * persistence mocks and in-memory Temporal): a failed resume ends the resume in
 * flight without discarding the turns queued behind it, and a resuming turn's
 * attachments reach the resumed run (foreign files refused).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteEphemeral, getEphemeral, putEphemeral } from '../../providers/sharedState';
import { getCurrentAgentQueue } from '../../providers/agentQueuePointer';
import { recordWorkerQueueCapabilities } from '../../providers/workerQueueCapabilities';
import { startupTurnsKey } from '../../providers/codeSessions/startupTurns';
import { codeAgentCliEnvs, cliSettingsEnvOverrides } from '../../providers/codeAgentModels';
import {
  pauseCodeAgentResumeRuns,
  startCodeAgentResumeWorkflow,
  terminateCodeAgentResumeRuns,
} from '../../providers/codeAgentResumeWorkflow';
import { prisma } from '../../providers/database';
import { idempotentMessageId } from '../../providers/messageIdempotency';
import { directTurnMetadata } from '../../domains/claude-code/directChatRows';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';

export interface ResumeRecoveryContext {
  post: (
    path: string,
    body: Record<string, unknown>,
    userId?: string | null
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  closedTurnPath: () => string;
  owner: string;
  stranger: string;
  agentId: string;
  startFinishedOwner: () => Promise<void>;
  resetResumeState: () => Promise<void>;
  resumeStarts: () => Array<{ options: { workflowId: string; args?: unknown[] } }>;
  setResumeEndRow: (row: { id: string } | null) => void;
  setOwner: (status: string, task: Record<string, unknown> | null) => void;
  codeTask: (status: string, wakeable?: boolean) => Record<string, unknown>;
  seedRow: (id: string, row: Record<string, unknown>) => void;
  closedTaskId: string;
}

export function registerResumeRecoveryCases(ctx: ResumeRecoveryContext): void {
  test('a failed resume ends it: the next turn starts a new one and keeps the turn queued behind it', async () => {
    await ctx.startFinishedOwner();
    await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-fail-first',
      text: 'resume',
    });
    const queued = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-fail-queued',
      text: 'queued behind it',
    });
    assert.equal(queued.json.status, 'queued');
    const starts = ctx.resumeStarts().length;
    ctx.setResumeEndRow({ id: 'row-refused' }); // the run posted "Couldn't resume"
    try {
      const next = await ctx.post(ctx.closedTurnPath(), {
        client_message_id: 'cm-fail-next',
        text: 'try again',
      });
      assert.equal(next.status, 200, JSON.stringify(next.json));
      assert.equal(
        ctx.resumeStarts().length,
        starts + 1,
        'a new resume, not a wait for the 2h marker'
      );
    } finally {
      ctx.setResumeEndRow(null);
    }
    const row = await getEphemeral<{ turns: Array<{ key: string }> }>(
      'code-startup-turns',
      startupTurnsKey(ctx.agentId, 'tc-spawn-1')
    );
    assert.deepEqual(
      row?.turns.map((turn) => turn.key),
      ['user:cm-fail-queued'],
      'the turn queued behind the failed resume reaches the new run (never discarded)'
    );
  });

  test('attachments on a resuming turn reach the resumed run; foreign files are refused', async () => {
    await ctx.startFinishedOwner();
    const pointer = {
      id: 'file-r',
      storage_path: `${ctx.owner}/spec.md`,
      original_filename: 'spec.md',
      mime_type: 'text/markdown',
      size_bytes: 2,
      created_at: '2026-11-08T00:00:00Z',
    };
    const res = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-attach-1',
      text: 'use this spec',
      attachments: [pointer],
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(
      (ctx.resumeStarts().at(-1)?.options.args?.[0] as Record<string, unknown>).attachments,
      [pointer]
    );
    await ctx.resetResumeState();
    const startsBefore = ctx.resumeStarts().length;
    const foreign = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-attach-2',
      text: 'use this',
      attachments: [{ ...pointer, storage_path: `${ctx.stranger}/spec.md` }],
    });
    assert.equal(foreign.status, 400);
    assert.equal(ctx.resumeStarts().length, startsBefore, 'nothing started');
  });

  test("the first resuming turn's model / effort / speed reach the resumed CLI's env", async () => {
    await ctx.startFinishedOwner();
    const res = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-settings-1',
      text: 'resume on opus',
      model: 'claude-opus-5-5',
      reasoning_effort: 'high',
      speed: 'fast',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const request = ctx.resumeStarts().at(-1)?.options.args?.[0] as Record<string, unknown>;
    assert.deepEqual(request.cli_settings, {
      model: 'claude-opus-5-5',
      reasoning_effort: 'high',
      speed: 'fast',
    });
    // The create request's cli_settings become the sandbox CLI env (e2b.ts).
    const override = request.cli_settings as Record<string, string>;
    assert.deepEqual(cliSettingsEnvOverrides('claude', override), {
      CLAUDE_CODE_MODEL: 'claude-opus-5-5',
      CLAUDE_CODE_EFFORT: 'high',
      CLAUDE_CODE_SPEED: 'fast',
    });
    assert.deepEqual(
      cliSettingsEnvOverrides('codex', { model: 'gpt-6.1-sol', speed: 'priority' }),
      {
        CODEX_MODEL: 'gpt-6.1-sol',
        CODEX_SPEED: 'priority',
      }
    );
    // Codex names its fast tier `priority`: a person's "fast" pick maps onto it.
    assert.equal(cliSettingsEnvOverrides('codex', { speed: 'fast' }).CODEX_SPEED, 'priority');
    const { envs } = await codeAgentCliEnvs('claude', null, override);
    assert.equal(envs.CLAUDE_CODE_MODEL, 'claude-opus-5-5', 'overrides win over the agent tier');
    assert.equal(envs.CLAUDE_CODE_EFFORT, 'high');
    // e2b.ts sets CODEX_SPEED from speedOverride last, so the agent's stored speed
    // never overwrites the person's resuming-turn pick.
    const codex = await codeAgentCliEnvs('codex', null, { speed: 'fast' });
    assert.equal(codex.speedOverride, 'priority');
    assert.equal((await codeAgentCliEnvs('codex', null, null)).speedOverride, null);
  });

  test("the owner's pause reaches a supervised resume run", async () => {
    await ctx.startFinishedOwner();
    const res = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-pause-1',
      text: 'resume, then I will pause',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const workflowId = ctx.resumeStarts().at(-1)?.options.workflowId ?? '';
    assert.ok((await pauseCodeAgentResumeRuns(ctx.agentId)) >= 1);
    const signals = blackboxTemporalSignals(await getTemporalClient(), workflowId);
    assert.ok(
      signals.some((signal) => signal.name === 'pause'),
      `the run got the pause signal: ${JSON.stringify(signals)}`
    );
  });

  test('no resume past the cost limit or without live credits; a stale status never refuses', async () => {
    const refused = async (clientId: string, code: string, words: string) => {
      const starts = ctx.resumeStarts().length;
      const res = await ctx.post(ctx.closedTurnPath(), {
        client_message_id: clientId,
        text: 'resume',
      });
      assert.equal(res.status, 409, JSON.stringify(res.json));
      assert.equal(res.json.code, code);
      assert.match(String(res.json.error), new RegExp(`^Couldn't resume: .*${words}`));
      assert.equal(ctx.resumeStarts().length, starts, 'nothing may spend');
    };
    await ctx.resetResumeState();
    ctx.setOwner('COST_LIMIT_REACHED', ctx.codeTask('paused'));
    await refused('cm-spend-limit', 'CODE_SESSION_OWNER_COST_LIMIT', 'cost limit');
    // Credits were added after the agent stopped OUT_OF_CREDITS: it resumes.
    await ctx.resetResumeState();
    ctx.setOwner('OUT_OF_CREDITS', ctx.codeTask('paused', false));
    const back = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-spend-back',
      text: 'go',
    });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    // A finished owner whose user has no credits left: refused.
    await ctx.resetResumeState();
    ctx.setOwner('COMPLETED', ctx.codeTask('paused', false));
    const saved = await prisma.credit.findMany({ where: { userId: ctx.owner } });
    await prisma.credit.deleteMany({ where: { userId: ctx.owner } });
    try {
      await refused('cm-spend-none', 'CODE_SESSION_OUT_OF_CREDITS', 'out of credits');
    } finally {
      await prisma.credit.createMany({ data: saved });
    }
  });

  test('a start that crashed after its row: the resend starts it again; later turns are not stuck', async () => {
    await ctx.startFinishedOwner();
    const key = startupTurnsKey(ctx.agentId, 'tc-spawn-1');
    // The marker of a resume whose run never started (its process died after the row).
    await putEphemeral(
      'code-agent-resume',
      key,
      { messageId: 'row-crashed', since: new Date(Date.now() - 5 * 60_000).toISOString() },
      60 * 60_000
    );
    const starts = ctx.resumeStarts().length;
    const next = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-after-crash',
      text: 'go',
    });
    assert.equal(next.status, 200, JSON.stringify(next.json));
    assert.equal(
      ctx.resumeStarts().length,
      starts + 1,
      'a new resume, not queued behind the dead one'
    );
    // The resend of a turn whose row exists but whose run never started: started again.
    await ctx.resetResumeState();
    const metadata = {
      ...directTurnMetadata(ctx.closedTaskId, 'cm-stalled', 'claude', 'tc-spawn-1'),
      resume_requested: true,
    };
    const id = idempotentMessageId({ agentId: ctx.agentId, role: 'TOOL', metadata }) ?? '';
    ctx.seedRow(id, {
      id,
      agentId: ctx.agentId,
      role: 'TOOL',
      text: 'run me',
      metadata,
      timestamp: new Date(),
    });
    const before = ctx.resumeStarts().length;
    const again = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-stalled',
      text: 'run me',
    });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.message_id, id, 'the persisted turn');
    assert.equal(ctx.resumeStarts().length, before + 1, 'its run is started again');
    assert.equal(ctx.resumeStarts().at(-1)?.options.workflowId, `code-resume:${ctx.agentId}:${id}`);
  });

  test('deleting the owner ends its resume runs', async () => {
    await ctx.startFinishedOwner();
    const res = await ctx.post(ctx.closedTurnPath(), {
      client_message_id: 'cm-delete-1',
      text: 'go',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const workflowId = ctx.resumeStarts().at(-1)?.options.workflowId ?? '';
    assert.ok((await terminateCodeAgentResumeRuns(ctx.agentId)) >= 1);
    const temporal = await getTemporalClient();
    const described = await temporal.workflow.getHandle(workflowId).describe();
    assert.equal(described.status.name, 'TERMINATED');
  });

  test('a resend of a turn whose run already started never runs it twice', async () => {
    await ctx.startFinishedOwner();
    const body = { client_message_id: 'cm-resend-1', text: 'do it once' };
    const first = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const starts = ctx.resumeStarts().length;
    const start = ctx.resumeStarts().at(-1) as unknown as {
      options: { workflowIdReusePolicy?: string };
    };
    assert.equal(start.options.workflowIdReusePolicy, 'ALLOW_DUPLICATE_FAILED_ONLY');
    const again = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.message_id, first.json.message_id);
    assert.equal(again.json.status, 'queued');
    assert.equal(ctx.resumeStarts().length, starts, 'the persisted turn short-circuits');
  });

  test('a resend whose supervised run was terminated by a move that did not restart it starts it again', async () => {
    await ctx.startFinishedOwner();
    const body = { client_message_id: 'cm-revive-1', text: 'pick it back up' };
    const first = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const workflowId = ctx.resumeStarts().at(-1)?.options.workflowId ?? '';
    // A cutover move flagged and terminated it; its restart on the live queue never landed.
    const temporal = await getTemporalClient();
    const stored = await getEphemeral<Record<string, unknown>>(
      'code-agent-resume-requests',
      workflowId
    );
    assert.ok(stored, 'the start stored its request');
    await putEphemeral(
      'code-agent-resume-requests',
      workflowId,
      { ...stored, moved: true },
      60_000
    );
    await temporal.workflow.getHandle(workflowId).terminate('moved to the live agent queue');
    const starts = ctx.resumeStarts().length;
    const again = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.message_id, first.json.message_id, 'the same persisted turn');
    assert.equal(ctx.resumeStarts().length, starts + 1, 'its run starts again');
    assert.equal(ctx.resumeStarts().at(-1)?.options.workflowId, workflowId);
    const described = await temporal.workflow.getHandle(workflowId).describe();
    assert.equal(described.status.name, 'RUNNING');
  });

  test('a run the owner deletion killed is never revived by a resend', async () => {
    await ctx.startFinishedOwner();
    const body = { client_message_id: 'cm-killed-1', text: 'go' };
    const first = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const workflowId = ctx.resumeStarts().at(-1)?.options.workflowId ?? '';
    assert.ok((await terminateCodeAgentResumeRuns(ctx.agentId)) >= 1);
    assert.equal(
      await getEphemeral('code-agent-resume-requests', workflowId),
      undefined,
      'the stored request went before the kill'
    );
    const starts = ctx.resumeStarts().length;
    const again = await ctx.post(ctx.closedTurnPath(), body);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(ctx.resumeStarts().length, starts, 'no restart of a killed run');
    const temporal = await getTemporalClient();
    assert.equal(
      (await temporal.workflow.getHandle(workflowId).describe()).status.name,
      'TERMINATED'
    );
  });

  test("a deploy mid-way (the live queue's workers lack the resume type): 409 with its reason", async () => {
    await ctx.startFinishedOwner();
    const queue = await getCurrentAgentQueue();
    await recordWorkerQueueCapabilities(queue, ['AgentWorkflow']);
    try {
      const starts = ctx.resumeStarts().length;
      const res = await ctx.post(ctx.closedTurnPath(), {
        client_message_id: 'cm-workers-updating',
        text: 'go',
      });
      assert.equal(res.status, 409, JSON.stringify(res.json));
      assert.equal(res.json.code, 'CODE_AGENT_WORKERS_UPDATING', JSON.stringify(res.json));
      assert.match(String(res.json.error), /workers are updating; send again shortly/);
      assert.equal(
        ctx.resumeStarts().length,
        starts,
        'nothing started on a queue that cannot run it'
      );
      // Once its workers register the type, the same message resumes.
      await recordWorkerQueueCapabilities(queue, ['CodeAgentResumeWorkflow']);
      const again = await ctx.post(ctx.closedTurnPath(), {
        client_message_id: 'cm-workers-updated',
        text: 'go',
      });
      assert.equal(again.status, 200, JSON.stringify(again.json));
      assert.equal(ctx.resumeStarts().length, starts + 1);
    } finally {
      await deleteEphemeral('worker-queue-capabilities', queue);
    }
  });

  test('pause reaches every run: concurrent starts, and every agent of the paused tree', async () => {
    const request = (agentId: string, messageId: string) => ({
      agent_id: agentId,
      user_id: ctx.owner,
      model: 'rose-labs/rose-1-ultra',
      tool_call_id: 'tc-spawn-1',
      task_name: null,
      code_session_id: null,
      code_provider: 'claude' as const,
      message: 'go',
      message_id: messageId,
      attachments: [],
    });
    const child = 'agent-direct-chat-child';
    const [a, b, c] = await Promise.all([
      startCodeAgentResumeWorkflow(request(ctx.agentId, 'm-concurrent-a')),
      startCodeAgentResumeWorkflow(request(ctx.agentId, 'm-concurrent-b')),
      startCodeAgentResumeWorkflow(request(child, 'm-child-run')),
    ]);
    await pauseCodeAgentResumeRuns([ctx.agentId, child]);
    const temporal = await getTemporalClient();
    for (const { workflowId } of [a, b, c]) {
      assert.ok(
        blackboxTemporalSignals(temporal, workflowId).some((signal) => signal.name === 'pause'),
        `${workflowId} was paused`
      );
    }
  });
}
