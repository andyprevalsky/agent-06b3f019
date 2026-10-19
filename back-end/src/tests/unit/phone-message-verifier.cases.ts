import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import type { CompletionOptions, CompletionChunk } from '../../providers/rose/types';
test('message wrapper binds exact approved payload and before-after evidence with fail-closed result and actual usage', async (t) => {
  let captured: CompletionOptions | undefined,
    text = '{"status":"allowed","x":50,"y":70}';
  await t.mock.module('../../providers/rose', {
    namedExports: {
      StructuredOutputAccumulator,
      createStreamingCompletion: async (options: CompletionOptions) => {
        captured = options;
        return (async function* () {
          yield {
            choices: [{ delta: { content: text } }],
            actual_model: 'gpt-5.6-luna-foundry',
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          } as CompletionChunk;
        })();
      },
    },
  });
  await t.mock.module('../../providers/modelPricing', {
    namedExports: { getModelPricing: async () => null },
  });
  const { verifyPhoneMessage, MESSAGE_SEND_PURPOSE, MESSAGE_SENT_PURPOSE } =
    await import('../../providers/phoneMessageVerifier');
  const input = {
    agentId: 'fixture-agent',
    mode: 'send' as const,
    recipient: '+15555550123',
    body: 'Exact approved body',
    before: [{ operationId: 'read', cursor: 1, result: { text: 'actual draft' } }],
    bounds: { x: 0, y: 0, w: 390, h: 844 },
  };
  const send = await verifyPhoneMessage(input);
  assert.equal(send.status, 'allowed');
  assert.equal(send.x, 50);
  assert.equal(send.usage.totalCostCents, 0);
  assert.equal(send.usage.totalTokens, 12);
  assert.equal(captured?.messages[0].content, MESSAGE_SEND_PURPOSE);
  assert.ok(captured?.abort_signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(captured!.messages[1].content as string), {
    recipient: input.recipient,
    body: input.body,
    before: input.before,
    bounds: input.bounds,
  });
  const after = [{ operationId: 'after', cursor: 3, result: { text: 'actual outgoing message' } }];
  for (const status of ['sent', 'failed', 'unknown']) {
    text = JSON.stringify({ status, x: 0, y: 0 });
    const result = await verifyPhoneMessage({ ...input, mode: 'verify', after });
    assert.equal(result.status, status);
    assert.equal(result.x, undefined);
    assert.equal(captured?.messages[0].content, MESSAGE_SENT_PURPOSE);
  }
  text = '{"status":"allowed","x":50,"y":70}';
  assert.equal((await verifyPhoneMessage({ ...input, mode: 'verify', after })).status, 'unknown');
  text = 'invalid';
  assert.equal((await verifyPhoneMessage(input)).status, 'unknown');
  assert.ok(MESSAGE_SENT_PURPOSE.includes('old matching history bubble'));
  assert.ok(MESSAGE_SENT_PURPOSE.includes('never recipient delivery or read'));
});
