import assert from 'node:assert/strict';
import {
  defaultPayloadConverter,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
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

  await assert.rejects(
    () => client.workflow.getHandle('missing').describe(),
    WorkflowNotFoundError
  );
  await assert.rejects(
    () =>
      client.workflowService.getWorkflowExecutionHistory({
        namespace: 'blackbox-test',
        execution: { workflowId: 'missing' },
        maximumPageSize: 1,
        waitNewEvent: false,
        skipArchival: true,
      }),
    WorkflowNotFoundError
  );
  const listedAfterMissingLookup: string[] = [];
  for await (const execution of client.workflow.list()) {
    listedAfterMissingLookup.push(execution.workflowId);
  }
  assert.equal(listedAfterMissingLookup.includes('missing'), false);

  const duplicate = await client.workflow.start('AgentWorkflow', {
    workflowId: 'duplicate',
    taskQueue: 'test',
    args: ['first'],
  });
  await assert.rejects(
    () =>
      client.workflow.start('AgentWorkflow', {
        workflowId: 'duplicate',
        taskQueue: 'test',
        args: ['rejected'],
      }),
    WorkflowExecutionAlreadyStartedError
  );
  const reused = await client.workflow.start('AgentWorkflow', {
    workflowId: 'duplicate',
    taskQueue: 'test',
    args: ['ignored'],
    workflowIdConflictPolicy: 'USE_EXISTING',
  });
  assert.equal(reused.firstExecutionRunId, duplicate.firstExecutionRunId);

  const replaced = await client.workflow.start('AgentWorkflow', {
    workflowId: 'duplicate',
    taskQueue: 'test',
    args: ['replacement'],
    workflowIdConflictPolicy: 'TERMINATE_EXISTING',
  });
  assert.notEqual(replaced.firstExecutionRunId, duplicate.firstExecutionRunId);
  await client.workflow.getHandle('duplicate').terminate('close replacement');
  await assert.rejects(
    () =>
      client.workflow.start('AgentWorkflow', {
        workflowId: 'duplicate',
        taskQueue: 'test',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      }),
    WorkflowExecutionAlreadyStartedError
  );
  const allowedAfterClose = await client.workflow.start('AgentWorkflow', {
    workflowId: 'duplicate',
    taskQueue: 'test',
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
  });
  assert.notEqual(allowedAfterClose.firstExecutionRunId, replaced.firstExecutionRunId);

  process.stdout.write('PASS temporal blackbox fake\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
