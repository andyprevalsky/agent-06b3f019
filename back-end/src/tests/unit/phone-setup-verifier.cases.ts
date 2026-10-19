/** Imported by the existing phone provider unit gate; all model/pricing IO mocked. */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import type { CompletionOptions, CompletionChunk } from '../../providers/rose/types';

test('phone setup canonical Rose wrapper purpose, evidence, timeout and actual usage fail closed', async () => {
  let text = '{"identityConfirmed":true}',
    actual = 'actual-identity-model',
    hasUsage = true,
    priced = '';
  let captured: CompletionOptions | undefined;
  let deadline = 0;
  await mock.module('../../providers/rose', {
    namedExports: {
      StructuredOutputAccumulator,
      createStreamingCompletion: async (options: CompletionOptions) => {
        captured = options;
        return (async function* () {
          yield {
            choices: [{ delta: { content: text } }],
            actual_model: actual,
            requested_model: 'rose-labs/rose-1-mini',
            pool_name: 'mini',
            pool_size: 1,
            ...(hasUsage
              ? { usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } }
              : {}),
          } as CompletionChunk;
        })();
      },
    },
  });
  await mock.module('../../providers/modelPricing', {
    namedExports: {
      getModelPricing: async (model: string) => {
        priced = model;
        return { prompt: '0.000002', completion: '0.00001' };
      },
    },
  });
  const { verifyPhoneSetup, PHONE_SETUP_PURPOSE } =
    await import('../../providers/phoneSetupVerifier');
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    deadline = ms;
    return timeout(ms);
  };
  try {
    const input = {
      agentId: 'synthetic-agent',
      expectedAppleIdentity: 'synthetic@example.invalid',
      evidence: [
        { operationId: 'stored-read', cursor: 7, result: { text: 'Actual server observation' } },
      ],
    };
    assert.ok(PHONE_SETUP_PURPOSE.includes('editable sign-in form'));
    assert.ok(PHONE_SETUP_PURPOSE.includes('account suggestions'));
    const result = await verifyPhoneSetup(input);
    assert.equal(result.identityConfirmed, true);
    assert.equal(priced, 'actual-identity-model');
    assert.equal(result.usage.totalCostCents, 1);
    assert.equal(result.usage.promptTokens, 1000);
    assert.equal(deadline, 60000);
    assert.equal(captured?.messages[0].content, PHONE_SETUP_PURPOSE);
    assert.equal(captured?.route_key, input.agentId);
    assert.deepEqual(JSON.parse(captured!.messages[1].content as string), {
      expectedAppleIdentity: input.expectedAppleIdentity,
      observations: input.evidence,
    });
    assert.equal(captured?.max_tokens, 128);
    text = '{"identityConfirmed":false}';
    assert.equal((await verifyPhoneSetup(input)).identityConfirmed, false);
    text = 'not-json';
    assert.equal(
      (await verifyPhoneSetup(input)).identityConfirmed,
      false,
      'Malformed output must not establish readiness'
    );
    text = '{"identityConfirmed":"true"}';
    assert.equal((await verifyPhoneSetup(input)).identityConfirmed, false);
    text = '{"identityConfirmed":true}';
    actual = 'gpt-5.6-luna-foundry';
    assert.equal(
      (await verifyPhoneSetup(input)).usage.totalCostCents,
      0,
      'Canonical funded Foundry user-facing policy must apply'
    );
    actual = 'actual-identity-model';
    hasUsage = false;
    await assert.rejects(verifyPhoneSetup(input));
    hasUsage = true;
    actual = '';
    await assert.rejects(verifyPhoneSetup(input));
  } finally {
    AbortSignal.timeout = timeout;
    mock.restoreAll();
  }
});
