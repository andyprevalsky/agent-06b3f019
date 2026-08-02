import assert from 'node:assert/strict';
import { defaultPayloadConverter } from '@temporalio/client';
import {
  createBlackboxTemporalClient,
  shouldUseBlackboxTemporalFake,
} from '../../providers/temporalBlackboxFake';

assert.equal(shouldUseBlackboxTemporalFake({}), false);
assert.equal(
  shouldUseBlackboxTemporalFake({
    BLACKBOX_TEST_CAPTURE_OUTBOUND: '1',
    BLACKBOX_TEST_FAKE_TEMPORAL: '1',
    NODE_ENV: 'test',
  }),
  true
);
assert.throws(
  () =>
    shouldUseBlackboxTemporalFake({
      BLACKBOX_TEST_FAKE_TEMPORAL: '1',
      NODE_ENV: 'test',
    }),
  /requires non-production outbound capture mode/
);
assert.throws(
  () =>
    shouldUseBlackboxTemporalFake({
      BLACKBOX_TEST_CAPTURE_OUTBOUND: '1',
      BLACKBOX_TEST_FAKE_TEMPORAL: '1',
      NODE_ENV: 'production',
    }),
  /requires non-production outbound capture mode/
);

async function main(): Promise<void> {
  const client = createBlackboxTemporalClient('blackbox-test');
  const handle = await client.workflow.start('AgentWorkflow', {
    workflowId: 'agent-1',
    taskQueue: 'test',
    args: ['agent-1', 'user-1'],
  });
  assert.equal(handle.workflowId, 'agent-1');
  assert.ok(handle.firstExecutionRunId);

  const description = await client.workflow.getHandle('agent-1').describe();
  assert.equal(description.status.name, 'RUNNING');
  assert.equal(description.raw.workflowExecutionInfo?.firstRunId, handle.firstExecutionRunId);

  const history = await client.workflowService.getWorkflowExecutionHistory({
    namespace: 'blackbox-test',
    execution: { workflowId: 'agent-1' },
    maximumPageSize: 1,
    waitNewEvent: false,
    skipArchival: true,
  });
  const payloads =
    history.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];
  assert.deepEqual(
    payloads.map((payload) => defaultPayloadConverter.fromPayload(payload)),
    ['agent-1', 'user-1']
  );

  await client.workflow.getHandle('agent-1').terminate('test complete');
  assert.equal((await client.workflow.getHandle('agent-1').describe()).status.name, 'TERMINATED');

  process.stdout.write('PASS temporal blackbox fake\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
