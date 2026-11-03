/** Existing control calls remain owner/generation-bound; no database or Temporal RPC. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const ID = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const original = {
  id: ID,
  status: 'ACTIVE',
  temporalWorkflowId: ID,
  temporalFirstExecutionRunId: RUN,
};
let mode = '';
let reads = 0;
let updates = 0;
async function findAgent(id: string, user: string) {
  assert.equal(id, ID);
  assert.equal(user, 'owner');
  reads++;
  if (mode === 'wrong-owner') return null;
  if (mode === 'terminal') return { ...original, status: 'FAILED' };
  if (mode === 'missing-run') return { ...original, temporalFirstExecutionRunId: null };
  if (mode === 'user-paused-race' && reads === 2) return { ...original, status: 'PAUSED' };
  if (mode === 'generation-changed' && reads === 2)
    return { ...original, temporalFirstExecutionRunId: 'changed' };
  return original;
}
const client = {
  workflow: {
    getHandle(id: string, run: unknown, options: unknown) {
      assert.equal(id, ID);
      assert.equal(run, undefined);
      assert.deepEqual(options, { firstExecutionRunId: RUN });
      return {
        async executeUpdate(name: string, options: unknown) {
          updates++;
          assert.equal(name, 'stop_at_browser_budget');
          assert.deepEqual(options, { args: [{ budget: 100, first_run_id: RUN }] });
          if (mode === 'rpc-error') throw new Error('offline');
          if (mode.startsWith('pending'))
            return {
              accepted: false,
              pending: true,
              task_id: mode === 'pending-bad-id' ? 'foreign' : TASK,
              run_id: RUN,
              first_run_id: mode === 'pending-wrong-run' ? 'old' : RUN,
              deadline: mode === 'pending-nan' ? Number.NaN : 12345,
              ...(mode === 'pending-extra' ? { ignored: true } : {}),
            };
          return {
            accepted: true,
            task_id: mode === 'bad-receipt' ? 'foreign' : TASK,
            run_id: RUN,
            first_run_id: RUN,
            deadline: 12345,
          };
        },
      };
    },
  },
};

async function main() {
  await mock.module('../../domains/agents/repo', { namedExports: { findAgent } });
  await mock.module('../../providers/temporal', {
    namedExports: {
      getTemporalClient: async () => client,
      withTemporalControlDeadline: (_client: unknown, operation: () => Promise<unknown>) =>
        operation(),
    },
  });
  const { pauseAtBrowserBudgetForUser } =
    await import('../../domains/agents/agentBudgetStopService');
  for (mode of [
    'valid',
    'wrong-owner',
    'terminal',
    'missing-run',
    'malformed',
    'unknown-key',
    'generation-changed',
    'user-paused-race',
    'rpc-error',
    'bad-receipt',
    'pending',
    'pending-bad-id',
    'pending-wrong-run',
    'pending-nan',
    'pending-extra',
  ]) {
    reads = updates = 0;
    const body =
      mode === 'malformed'
        ? { budget: true }
        : mode === 'unknown-key'
          ? { budget: 100, force: true }
          : { budget: 100 };
    const result = await pauseAtBrowserBudgetForUser(ID, 'owner', body);
    assert.equal(result.accepted, mode === 'valid', mode);
    assert.equal('pending' in result && result.pending === true, mode === 'pending', mode);
    if (['wrong-owner', 'terminal', 'missing-run', 'malformed', 'unknown-key'].includes(mode))
      assert.equal(updates, 0, mode);
  }
  process.stdout.write('PASS 15 budget-stop endpoint owner/generation/refusal controls\n');
}
void main();
