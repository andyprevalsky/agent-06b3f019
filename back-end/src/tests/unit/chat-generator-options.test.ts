#!/usr/bin/env tsx

import assert from 'node:assert';
import { buildGeneratorCompletionOptions } from '../../providers/chat/generatorLlm';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion } from '../../providers/rose';
import { contentKey } from '../../providers/demoCacheNormalizeKeys';

async function run(): Promise<void> {
  const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
  const abortController = new AbortController();
  const options = buildGeneratorCompletionOptions({
    agentId: 'chat-options-contract',
    model: phases.generator,
    messages: [
      { role: 'system', content: 'generator system' },
      { role: 'user', content: 'answer this' },
    ],
    providerRoute: phases.generatorProviderRoute,
    providerFastMode: true,
    abortSignal: abortController.signal,
  });

  assert.strictEqual(options.model, 'rose-labs/rose-1-flash');
  assert.strictEqual(options.provider_route, 'direct-cerebras');
  assert.strictEqual(options.provider_fast_mode, true);
  assert.strictEqual(options.abort_signal, abortController.signal);
  assert.strictEqual(options.temperature, 0.7);
  assert.strictEqual(options.max_tokens, 4_096);
  assert.strictEqual(
    buildGeneratorCompletionOptions({
      model: phases.generator,
      messages: options.messages,
      providerFastMode: true,
    }).max_tokens,
    undefined,
    'other provider routes retain their existing output budget'
  );
  assert.strictEqual(options.effort, 'minimal');
  assert.strictEqual(options.response_format?.json_schema.name, 'generator_response');
  assert.strictEqual(options.response_format?.json_schema.strict, true);
  for (const property of ['claude_token', 'gpt_token', 'gpt_account_id', 'disable_waterfall']) {
    assert.strictEqual(
      Object.hasOwn(options, property),
      false,
      `Generator options must not own ${property}`
    );
  }
  const liteCacheKey = contentKey('same goal', 'chat_generator', options);
  const ultraCacheKey = contentKey('same goal', 'chat_generator', {
    ...options,
    model: 'rose-labs/rose-1-ultra',
  });
  assert.notStrictEqual(liteCacheKey, ultraCacheKey, 'Generator cache identity includes model');
  const sharedRouteCacheKey = contentKey('same goal', 'chat_generator', {
    ...options,
    provider_route: 'shared-openai-priority',
  });
  assert.notStrictEqual(
    liteCacheKey,
    sharedRouteCacheKey,
    'Generator cache identity includes provider route'
  );

  const originalFetch = globalThis.fetch;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldGptKey = process.env.GPT_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.GPT_API_KEY = 'shared-provider-must-not-run';
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error('no provider call expected');
  }) as typeof fetch;

  try {
    // Exclusive direct-cerebras requires CEREBRAS_API_KEY; GPT_API_KEY must not leak.
    await assert.rejects(async () => {
      for await (const chunk of await createStreamingCompletion(options)) {
        assert.fail(`unexpected chunk without provider keys: ${chunk.actual_model}`);
      }
    }, /CEREBRAS_API_KEY|Rose/);
    assert.strictEqual(providerCalls, 0, 'missing provider keys must fail before provider calls');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldGptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = oldGptKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }

  process.stdout.write('PASS chat Generator options exclude ignored compute-auth fields\n');
  process.stdout.write('PASS Generator direct-cerebras fails closed without leakage\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
