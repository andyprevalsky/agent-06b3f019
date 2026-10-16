import assert from 'node:assert/strict';
import { WorkflowNotFoundError } from '@temporalio/client';
import { startAgentWorkflowExecutionWithClient } from '../../providers/temporal';
import {
  beginQueueRetirement,
  requireQueueRetirementReady,
} from '../../providers/workflowQueueAdmission';
export async function runAbsenceCases(
  test: (name: string, fn: () => Promise<void>) => Promise<void>,
  rows: Map<string, Record<string, unknown>>,
  agent: {
    id: string;
    temporalWorkflowId: string | null;
    temporalFirstExecutionRunId: string | null;
  },
  queue: string,
  getPointer: () => { taskQueue: string; surfaceHash: string },
  setPointer: (value: { taskQueue: string; surfaceHash: string }) => void
) {
  await test('settled immutable physical root latest absence permits fresh identity', async () => {
    const snapshot = structuredClone([...rows.entries()]);
    const prior = { ...agent };
    try {
      for (const [key, row] of rows) if (row.externalId === agent.id) rows.delete(key);
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      const ids: string[] = [];
      const lookups: string[] = [];
      let mode = 'absent';
      const client = {
        withDeadline: async (_d: number, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: (id: string, runId?: string) => ({
            describe: async () => {
              assert.equal(runId, undefined);
              lookups.push(id);
              if (mode === 'foreign-absent')
                throw new WorkflowNotFoundError('foreign absent', 'other-id', undefined);
              if (mode === 'run-absent')
                throw new WorkflowNotFoundError('old run absent', id, 'old-run');
              if (mode === 'transport') throw Error('transport');
              if (mode === 'running' || mode === 'mismatch')
                return {
                  raw: {
                    workflowExecutionInfo: {
                      firstRunId: mode === 'mismatch' ? 'foreign' : 'first',
                    },
                  },
                  status: { name: mode === 'running' ? 'RUNNING' : 'COMPLETED' },
                };
              throw new WorkflowNotFoundError('latest absent', id, undefined);
            },
          }),
          start: async (_t: string, o: { workflowId: string; workflowIdReusePolicy: string }) => {
            assert.equal(o.workflowIdReusePolicy, 'REJECT_DUPLICATE');
            ids.push(o.workflowId);
            return { workflowId: o.workflowId, firstExecutionRunId: 'first' };
          },
        },
      };
      const params = {
        agentId: agent.id,
        userId: 'user',
        goal: 'absence',
        model: 'test',
        reasoningMaxTokens: 2048,
        verifier: { type: 'test' },
        taskQueue: queue,
      };
      const first = await startAgentWorkflowExecutionWithClient(client as never, params);
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      const member = [...rows.values()].find((r) => r.operationType === 'AGENT_QUEUE_START')!;
      const intent = member.request as Record<string, unknown>;
      for (mode of ['transport', 'running', 'mismatch', 'foreign-absent', 'run-absent']) {
        await assert.rejects(startAgentWorkflowExecutionWithClient(client as never, params));
        assert.equal(ids.length, 1);
      }
      mode = 'absent';
      intent.wireCoverage = 'UNKNOWN';
      await assert.rejects(startAgentWorkflowExecutionWithClient(client as never, params));
      assert.equal(ids.length, 1);
      intent.wireCoverage = 'IMMUTABLE_ID';
      intent.rejectDuplicate = false;
      await assert.rejects(startAgentWorkflowExecutionWithClient(client as never, params));
      assert.equal(ids.length, 1);
      intent.rejectDuplicate = true;
      const next = await startAgentWorkflowExecutionWithClient(client as never, params);
      assert.notEqual(next.workflowId, first.workflowId);
      assert.equal(ids.length, 2);
      assert.deepEqual(
        (member.response as { nativeTerminalWitness: unknown }).nativeTerminalWitness,
        { ...first, status: 'ABSENT' }
      );
      lookups.length = 0;
      agent.temporalWorkflowId = null;
      agent.temporalFirstExecutionRunId = null;
      await startAgentWorkflowExecutionWithClient(client as never, params);
      assert.deepEqual(lookups, [next.workflowId], 'saved absence proof was not reused');
    } finally {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      Object.assign(agent, prior);
    }
  });
  await test('qualified settled retirement accepts latest native absence', async () => {
    const snapshot = structuredClone([...rows.entries()]);
    const prior = getPointer();
    try {
      for (const [key, row] of rows)
        if (['AGENT_QUEUE_START', 'AGENT_QUEUE_CONTINUATION'].includes(String(row.operationType)))
          rows.delete(key);
      const accepted = { workflowId: 'retirement-physical', firstExecutionRunId: 'first' };
      const row = {
        operationKey: 'absent-member',
        operationType: 'AGENT_QUEUE_START',
        status: 'COMPLETED',
        request: {
          workflowId: accepted.workflowId,
          queue,
          rejectDuplicate: true,
          wireCoverage: 'IMMUTABLE_ID',
          accepted,
        },
      };
      rows.set(row.operationKey, row);
      const gate = rows.get(`agent-queue-admission:${queue}`)!.request as Record<string, unknown>;
      gate.legacyCertificate = {
        producerTransition: 'qualified',
        cohortManifest: 'exact',
        unresolved: 0,
      };
      setPointer({ taskQueue: 'next-generation', surfaceHash: 'next' });
      await beginQueueRetirement(queue, 'absence-owner');
      const absent = async (ref: { workflowId: string }) => {
        throw new WorkflowNotFoundError('latest absent', ref.workflowId, undefined);
      };
      const retiringGate = rows.get(`agent-queue-admission:${queue}`)!.request as Record<
        string,
        unknown
      >;
      retiringGate.legacyCoverage = 'UNKNOWN';
      await assert.rejects(requireQueueRetirementReady(queue, 'absence-owner', absent));
      retiringGate.legacyCoverage = 'QUALIFIED';
      row.request.wireCoverage = 'UNKNOWN';
      await assert.rejects(requireQueueRetirementReady(queue, 'absence-owner', absent));
      row.request.wireCoverage = 'IMMUTABLE_ID';
      row.status = 'STARTED';
      await assert.rejects(requireQueueRetirementReady(queue, 'absence-owner', absent));
      row.status = 'COMPLETED';
      await assert.rejects(
        requireQueueRetirementReady(queue, 'absence-owner', async () => {
          throw Error('transport');
        })
      );
      row.request.rejectDuplicate = false;
      await assert.rejects(requireQueueRetirementReady(queue, 'absence-owner', absent));
      row.request.rejectDuplicate = true;
      await assert.rejects(
        requireQueueRetirementReady(queue, 'absence-owner', async () => {
          throw new WorkflowNotFoundError('foreign', 'other-id', undefined);
        })
      );
      rows.set('absent-ticket', {
        operationKey: 'absent-ticket',
        operationType: 'AGENT_QUEUE_CONTINUATION',
        request: {
          workflowId: 'continued-chain',
          runId: 'source-run',
          firstExecutionRunId: 'continued-first',
          queue,
          incarnation: 'fresh-1',
        },
      });
      let observations = 0;
      await requireQueueRetirementReady(queue, 'absence-owner', async (ref) => {
        observations++;
        return absent(ref);
      });
      assert.equal(observations, 2, 'incoming continuation absence was not reconciled');
      assert.equal(
        (rows.get(`agent-queue-admission:${queue}`)!.request as { phase: string }).phase,
        'RETIRED'
      );
    } finally {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      setPointer(prior);
    }
  });
}
