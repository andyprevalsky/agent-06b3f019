/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { Connection, type ConnectionLike } from '@temporalio/client';
import { prisma } from '../../providers/database';
import { startPreparedAgentWorkflowReplacement } from '../../domains/agents/agentRestartService';
import { startAgentMode } from '../../domains/agents/agentControlService';
import { createAgentsBatch } from '../../domains/agents/agentBatchService';
import { commitStartNewAgent } from '../../providers/smsSupervisor/supervisorTools.startAgent';
import { reconcileWorkflowLiveness } from '../../providers/workflowLivenessReconciler';
import { recoverChatHandlerFailure } from '../../providers/chat/chatHandlerFailure';
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { fixture, withFixtureDatabase } from './workflow-queue-admission.fixture';
import { createTestHarness } from './trace-archive-test-utils';
import { isWorkflowStartAdmissionPending } from '../../providers/workflowQueueAdmission';
const { test, finish } = createTestHarness('workflow queue admission actual callers');
let active = fixture();
const service = new Proxy(
  {},
  {
    get(_target, key) {
      const value = Reflect.get(active.service, key);
      return typeof value === 'function' ? value.bind(active.service) : value;
    },
  }
);
const connection = new Proxy({} as ConnectionLike, {
  get(_target, key) {
    if (key === 'workflowService') return service;
    const value = Reflect.get(active.connection, key);
    return typeof value === 'function' ? value.bind(active.connection) : value;
  },
});
function agent(f: ReturnType<typeof fixture>, id: string) {
  f.agent(id);
  Object.assign(f.agents.get(id)!, {
    temporalWorkflowId: null,
    userId: 'user',
    goal: 'Original authored goal',
    model: 'rose-labs/rose-1-ultra',
    reasoningMaxTokens: 2048,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    workflowMaxIterations: null,
    workflowContextGates: null,
    priceLimitCents: 100,
    fastModeCacheEnabled: true,
    memoryEnabled: true,
    worldModelMode: 'real',
    parentAgentId: null,
    parentWorkflowId: null,
    depth: 0,
    busId: null,
    workflowStartPhase: null,
    workflowTaskQueue: null,
    source: 'WEB',
    responseSchema: null,
  });
}
async function main() {
  const originalConnect = Connection.connect;
  const originalAddress = process.env.TEMPORAL_ADDRESS;
  const originalNamespace = process.env.TEMPORAL_NAMESPACE;
  const originalFetch = globalThis.fetch;
  Connection.connect = async () => connection as Connection;
  process.env.TEMPORAL_ADDRESS = '127.0.0.1:9';
  process.env.TEMPORAL_NAMESPACE = 'actual-sdk-test';
  globalThis.fetch = async (input) => {
    assert(String(input).endsWith('/realtime/v1/api/broadcast'));
    return new Response('{}', { status: 202 });
  };
  try {
    for (const site of ['native', 'ack']) {
      await test(
        'manual ' + site + ' failure leaves actual agent active and retryable',
        async () => {
          const f = (active = fixture());
          agent(f, 'manual');
          const error = new Error('actual external ' + site + ' error');
          if (site === 'native')
            f.onStart(async () => {
              throw error;
            });
          else
            f.tx.toolSideEffect.update = async () => {
              throw error;
            };
          await withFixtureDatabase(f, async () => {
            let received: unknown;
            await assert.rejects(startAgentMode('manual', 'user'), (actual) => {
              received = actual;
              return isWorkflowStartAdmissionPending(actual);
            });
            assert.equal(f.agents.get('manual')!.status, 'ACTIVE');
            assert.equal(f.agents.get('manual')!.temporalWorkflowId, null);
            let notice = 0;
            await recoverChatHandlerFailure({
              agentId: 'manual',
              error: received,
              persistNotice: async () => {
                notice++;
              },
            });
            assert.equal(notice, 0, 'pending workflow start manufactured a chat failure turn');
          });
        }
      );
      await test(
        'SMS ' + site + ' failure preserves actual created agent without false FAILED/adoption',
        async () => {
          const f = (active = fixture());
          const error = new Error('actual external ' + site + ' error');
          Object.assign(f.tx.agent, {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              const id = data.id as string;
              agent(f, id);
              Object.assign(f.agents.get(id)!, data, { temporalWorkflowId: null });
              return f.agents.get(id)!;
            },
          });
          Object.assign(f.tx, {
            verifier: { create: async () => ({}) },
            message: { create: async ({ data }: { data: unknown }) => data },
          });
          if (site === 'native')
            f.onStart(async () => {
              throw error;
            });
          else
            f.tx.toolSideEffect.update = async () => {
              throw error;
            };
          await withFixtureDatabase(f, async () => {
            const result = await commitStartNewAgent(
              {
                kind: 'start_new_agent',
                provisionalId: 'sms',
                args: { goal: 'Actual authored SMS goal' },
              },
              'user'
            );
            assert.equal(result.success, false);
            assert.equal(f.agents.get('sms')!.status, 'STARTING_UP');
            assert.equal(f.agents.get('sms')!.temporalWorkflowId, null);
            assert.equal(f.wire.length, 1);
          });
        }
      );
      await test('batch ' + site + ' failure preserves actual pending row', async () => {
        const f = (active = fixture());
        agent(f, 'batch');
        Object.assign(f.agents.get('batch')!, {
          temporalWorkflowId: 'batch',
          temporalWorkflowStartPending: true,
        });
        const error = new Error('actual external ' + site + ' error');
        if (site === 'native')
          f.onStart(async () => {
            throw error;
          });
        else
          f.tx.toolSideEffect.update = async () => {
            throw error;
          };
        await withFixtureDatabase(f, async () => {
          const result = await createAgentsBatch({
            bodies: [
              {
                agent_id: 'batch',
                goal: 'Original authored goal',
                model: 'rose-labs/rose-1-ultra',
                reasoning_max_tokens: 2048,
                source: 'WEB',
                pause_state: false,
                depth: 0,
                price_limit_cents: 100,
              },
            ],
            userId: 'user',
            isInternal: false,
            clientIP: null,
          });
          assert.equal(result[0].status, 'STARTING_UP');
          assert.equal(f.agents.get('batch')!.status, 'ACTIVE');
        });
      });
    }

    await test('actual planned replacement preserves pending outcome and uses immutable native reuse policy', async () => {
      const f = (active = fixture());
      agent(f, 'replacement');
      const physical = 'replacement:planned-immutable-uuid';
      Object.assign(f.agents.get('replacement')!, {
        temporalWorkflowId: physical,
        workflowReplacementToken: 'replace-token',
        statusMessage: 'Original preserved status',
      });
      f.onStart(async () => {
        throw new Error('planned replacement ACK lost');
      });
      await withFixtureDatabase(f, async () => {
        await assert.rejects(
          startPreparedAgentWorkflowReplacement({
            prepared: true,
            agentId: 'replacement',
            userId: 'user',
            deadlineAtMs: Date.now() + 5000,
            claim: {
              agentId: 'replacement',
              token: 'replace-token',
              plannedWorkflowId: physical,
              staleWorkflowId: null,
              staleFirstExecutionRunId: null,
              resumeState: { max_iterations: null, context_gates: null },
            },
          } as never),
          isWorkflowStartAdmissionPending
        );
        assert.equal(f.agents.get('replacement')!.statusMessage, 'Original preserved status');
        assert.equal(f.wire.length, 1);
        assert.equal(f.wire[0].workflowId, physical);
        assert.equal(f.wire[0].workflowIdReusePolicy, 3);
        const prior = f.runs.get(physical)!;
        prior.closed = true;
        await assert.rejects(
          f.service.startWorkflowExecution({
            ...f.wire[0],
            requestId: 'a-late-independent-wire-attempt',
          })
        );
        assert.equal(f.runs.get(physical)!.run, prior.run, 'closed immutable replacement reopened');
      });
    });

    await test('actual liveness terminal CAS cannot race admission during external tool capture', async () => {
      const f = (active = fixture());
      agent(f, 'late-claim');
      Object.assign(f.agents.get('late-claim')!, { messageCount: 0 });
      let atRpc!: () => void;
      const entered = new Promise<void>((resolve) => {
        atRpc = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.onStart(async () => {
        atRpc();
        await held;
      });
      let start: Promise<unknown> | undefined;
      let cleanup = 0;
      await withFixtureDatabase(f, async () => {
        const before = prisma.agent.findMany;
        prisma.agent.findMany = (async ({ where }: { where: { temporalWorkflowId: unknown } }) =>
          where.temporalWorkflowId === null
            ? [{ id: 'late-claim', status: 'ACTIVE', statusMessage: null }]
            : []) as never;
        prisma.message.findMany = (async () => {
          if (!start) {
            start = f.start(f.params('late-claim'));
            await entered;
          }
          return [];
        }) as never;
        try {
          const result = await reconcileWorkflowLiveness({
            finalizeInterruptedTools: async () => {
              cleanup++;
              return { candidates: 0, interrupted: 0 };
            },
            releaseBrowserSessions: async () => {
              cleanup++;
              return 0;
            },
          });
          assert.equal(result.sealed, 0);
          assert.equal(f.agents.get('late-claim')!.status, 'ACTIVE');
          assert.equal(cleanup, 0);
        } finally {
          release();
          if (start) await start;
          prisma.agent.findMany = before;
        }
      });
    });

    await test('stale CLOSED read cannot seal a new fully acknowledged reusable-root chain', async () => {
      const f = (active = fixture());
      agent(f, 'late-ack');
      f.agents.get('late-ack')!.temporalWorkflowId = 'late-ack';
      f.runs.set('late-ack', {
        request: 'earlier-request',
        run: 'earlier-closed-run',
        closed: true,
      });
      let cleanup = 0;
      let started = false;
      await withFixtureDatabase(f, async () => {
        prisma.message.findMany = (async () => {
          if (!started) {
            started = true;
            await f.start(f.params('late-ack'));
          }
          return [];
        }) as never;
        const result = await reconcileWorkflowLiveness({
          describeStatus: async () => 'COMPLETED',
          finalizeInterruptedTools: async () => {
            cleanup++;
            return { candidates: 0, interrupted: 0 };
          },
          releaseBrowserSessions: async () => {
            cleanup++;
            return 0;
          },
        });
        assert.equal(result.sealed, 0);
        assert.equal(f.agents.get('late-ack')!.status, 'ACTIVE');
        assert.equal(cleanup, 0);
        assert.equal(f.runs.get('late-ack')!.closed, false);
        assert.notEqual(f.runs.get('late-ack')!.run, 'earlier-closed-run');
      });
    });
    await test('acknowledged UNKNOWN membership never certifies NOT_FOUND absence', async () => {
      const f = (active = fixture());
      agent(f, 'ack-unknown');
      await withFixtureDatabase(f, async () => {
        await f.start(f.params('ack-unknown'));
        f.agents.get('ack-unknown')!.temporalWorkflowId = 'ack-unknown';
        const result = await reconcileWorkflowLiveness({
          describeStatus: async () => 'NOT_FOUND',
          finalizeInterruptedTools: async () => ({ candidates: 0, interrupted: 0 }),
          releaseBrowserSessions: async () => 0,
        });
        assert.equal(result.sealed, 0);
        assert.equal(f.agents.get('ack-unknown')!.status, 'ACTIVE');
      });
    });
    await test('durable unresolved membership prevents liveness sealing after process-local error is gone', async () => {
      const f = (active = fixture());
      agent(f, 'liveness-pending');
      f.agents.get('liveness-pending')!.temporalWorkflowId = 'liveness-pending';
      f.onStart(async () => {
        f.runs.clear();
        throw new Error('native ACK lost before visibility');
      });
      await withFixtureDatabase(f, async () => {
        await assert.rejects(f.start(f.params('liveness-pending')));
        let descriptions = 0;
        const result = await reconcileWorkflowLiveness({
          describeStatus: async () => {
            descriptions++;
            return 'NOT_FOUND';
          },
          finalizeInterruptedTools: async () => ({ candidates: 0, interrupted: 0 }),
          releaseBrowserSessions: async () => 0,
        });
        assert.equal(result.sealed, 0);
        assert.equal(result.inconclusive, 1);
        assert.equal(descriptions, 0);
        assert.equal(f.agents.get('liveness-pending')!.status, 'ACTIVE');
      });
    });
    await test('real public SDK retains codec/interceptor/native root reuse semantics', async () => {
      const f = (active = fixture());
      agent(f, 'sdk-root');
      await withFixtureDatabase(f, async () => {
        await f.start(f.params('sdk-root'));
      });
      assert.equal(f.wire.length, 1);
      const frame = f.wire[0];
      assert.equal(frame.workflowId, 'sdk-root');
      assert.equal(
        Buffer.from(frame.input!.payloads![2].data!).toString(),
        JSON.stringify('Original authored goal')
      );
      assert.equal(
        Buffer.from(frame.input!.payloads![2].metadata!.existingCodec!).toString(),
        'preserved'
      );
      assert.equal(
        Buffer.from(frame.header!.fields!.existingInterceptor.data!).toString(),
        'preserved'
      );
      assert.notEqual(
        frame.workflowIdReusePolicy,
        3,
        'legacy root must retain completed follow-up reuse'
      );
    });
  } finally {
    await __flushBroadcastQueueForTests();
    Connection.connect = originalConnect;
    globalThis.fetch = originalFetch;
    if (originalAddress === undefined) delete process.env.TEMPORAL_ADDRESS;
    else process.env.TEMPORAL_ADDRESS = originalAddress;
    if (originalNamespace === undefined) delete process.env.TEMPORAL_NAMESPACE;
    else process.env.TEMPORAL_NAMESPACE = originalNamespace;
    await prisma.$disconnect();
  }
  finish();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
