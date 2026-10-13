import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'https://broadcast.blackbox.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'blackbox-service-key';
process.env.SUPABASE_BROADCAST_BATCH_SIZE = '100';
process.env.SUPABASE_BROADCAST_TIMEOUT_MS = '2000';

async function main() {
  const publisher = await import('../../providers/chat/supabaseBroadcast');
  const ids = Array.from(
    { length: 50 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  );
  const metadata = {
    busId: '00000000-0000-4000-8000-999999999999',
    phase: 'complete',
    title: 'for_each complete',
    toolName: 'spawn_general_purpose_agent_for_each',
    toolCallId: 'aggregate-call',
    toolStatus: 'FINISHED',
    subAgentIds: ids,
    spawnGroupId: 'aggregate-group',
    forEachAggregate: true,
    workflowGeneration: 'aggregate-generation',
    structured_response: {
      items: ids.map((agent_id, index) => ({
        agent_id,
        index,
        status: 'COMPLETED',
        structured_response: { result: 'x'.repeat(8900) },
      })),
    },
  };
  const filePointer = { id: 'aggregate-file', storage_path: 'outputs/aggregate.csv' };
  const terminalText =
    'Completed for_each delegation for 50 items. See structured_response.items for per-child results.';
  const before = JSON.stringify(metadata);
  const received: Array<{
    payload: {
      record: {
        id: string;
        timestamp: string;
        text: string;
        role: string;
        metadata: Record<string, unknown>;
        filePointer?: object;
      };
    };
  }> = [];
  globalThis.fetch = (async (_url, init) => {
    received.push(...JSON.parse(String(init?.body)).messages);
    return new Response('', { status: 202 });
  }) as typeof fetch;
  await publisher.broadcastMessageInsert(metadata.busId, {
    id: 'aggregate-terminal',
    timestamp: new Date('2026-10-13T04:36:24.711Z'),
    text: terminalText,
    role: 'TOOL',
    metadata,
    filePointer,
  });
  await publisher.__flushBroadcastQueueForTests();
  assert.equal(
    JSON.stringify(metadata),
    before,
    'stored/model-context metadata input must remain byte-identical'
  );
  assert.equal(
    received.length,
    1,
    'reference-driven aggregate must deliver within unchanged admission limits'
  );
  const wire = received[0].payload.record.metadata;
  assert.equal(received[0].payload.record.id, 'aggregate-terminal');
  assert.equal(received[0].payload.record.timestamp, '2026-10-13T04:36:24.711Z');
  assert.equal(received[0].payload.record.text, terminalText);
  assert.equal(received[0].payload.record.role, 'TOOL');
  assert.deepEqual(received[0].payload.record.filePointer, filePointer);
  assert.deepEqual(wire.subAgentIds, ids);
  assert.equal(wire.busId, metadata.busId);
  assert.equal(
    wire.structured_response,
    undefined,
    'realtime omits duplicated child output, not reference fields'
  );
  const references: Record<string, unknown> = { ...metadata };
  delete references.structured_response;
  assert.deepEqual(wire, references, 'all other metadata must remain unchanged');
  process.stdout.write(
    `PASS aggregate wire projection; original metadata bytes=${Buffer.byteLength(before)}\n`
  );

  const smallResponse = { items: [{ result: 'Keep ordinary output' }] };
  const invalid = [
    { toolName: 'spawn_browser_agent' },
    { toolName: 'spawn_claude_code_agent' },
    { toolName: 'ordinary_tool' },
    { forEachAggregate: false },
    { toolStatus: 'IN_PROGRESS' },
    { busId: '' },
    { busId: 42 },
    { subAgentIds: [] },
    { subAgentIds: [ids[0], 42] },
    { subAgentIds: [''] },
  ];
  for (const [index, override] of invalid.entries()) {
    const original = { ...metadata, structured_response: smallResponse, ...override };
    const frozenInput = JSON.stringify(original);
    const previousFrames = received.length;
    await publisher.broadcastMessageInsert(metadata.busId, {
      id: `unprojected-${index}`,
      timestamp: new Date('2026-10-13T04:36:24.711Z'),
      text: 'Preserve required output',
      role: 'TOOL',
      metadata: original,
    });
    await publisher.__flushBroadcastQueueForTests();
    assert.equal(received.length, previousFrames + 1, 'each preservation control must deliver');
    assert.deepEqual(
      received.at(-1)!.payload.record.metadata,
      original,
      'non-reference-driven rows retain all metadata'
    );
    assert.equal(
      JSON.stringify(original),
      frozenInput,
      'projection must never mutate caller metadata'
    );
  }
  const beforeAssistantFrames = received.length;
  await publisher.broadcastMessageInsert(metadata.busId, {
    id: 'assistant-control',
    timestamp: new Date('2026-10-13T04:36:24.711Z'),
    text: 'Assistant output',
    role: 'ASSISTANT',
    metadata: { ...metadata, structured_response: smallResponse },
  });
  await publisher.__flushBroadcastQueueForTests();
  assert.equal(received.length, beforeAssistantFrames + 1);
  assert.deepEqual(received.at(-1)!.payload.record.metadata.structured_response, smallResponse);
  const failedMetadata = { ...metadata, toolStatus: 'ERROR' };
  const failedBefore = JSON.stringify(failedMetadata);
  const beforeErrorFrames = received.length;
  await publisher.broadcastMessageInsert(metadata.busId, {
    id: 'failed-aggregate',
    timestamp: new Date('2026-10-13T04:36:24.711Z'),
    text: 'Some children failed',
    role: 'TOOL',
    metadata: failedMetadata,
  });
  await publisher.__flushBroadcastQueueForTests();
  assert.equal(received.length, beforeErrorFrames + 1);
  assert.equal(received.at(-1)!.payload.record.metadata.structured_response, undefined);
  assert.equal(received.at(-1)!.payload.record.metadata.toolStatus, 'ERROR');
  assert.deepEqual(received.at(-1)!.payload.record.metadata.subAgentIds, ids);
  assert.equal(JSON.stringify(failedMetadata), failedBefore);
  process.stdout.write(
    'PASS browser, Claude, ordinary, nonterminal, invalid-reference and assistant preservation controls\n'
  );
}
void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
