#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setInterval as every } from 'node:timers/promises';

import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import {
  chatRouterCompletionTimeoutMs,
  createRouterCompletionDeadline,
  DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
  streamBeforeRouterCompletionDeadline,
} from '../../providers/chat/routerCompletionDeadline';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import {
  CHAT_TIMEOUT_MS,
  DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
} from '../../providers/rose/cerebrasRoute';
import { DEFAULT_CEREBRAS_CHAT_HEDGE_MS } from '../../providers/rose/exclusiveCerebrasChatRoute';
import { DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS } from '../../providers/rose/openrouterFastRoute';
import {
  parsePartialRouterDecisionJson,
  parseRouterDecisionAfterDeadline,
  parseRouterDecisionJson,
} from '../../providers/chat/routerDecision';

async function run(): Promise<void> {
  const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
  const abortController = new AbortController();
  const options = buildRouterCompletionOptions({
    agentId: 'chat-options-contract',
    model: phases.router,
    messages: [
      { role: 'system', content: 'router system' },
      { role: 'user', content: 'route this' },
    ],
    providerRoute: phases.routerProviderRoute,
    providerFastMode: true,
    abortSignal: abortController.signal,
  });

  assert.equal(options.model, 'rose-labs/rose-1-flash');
  assert.equal(options.provider_route, 'direct-cerebras');
  assert.equal(options.provider_fast_mode, true);
  assert.equal(options.abort_signal, abortController.signal);
  assert.equal(options.temperature, 0);
  assert.equal(options.max_tokens, 2_048);
  assert.equal(
    buildRouterCompletionOptions({
      model: phases.router,
      messages: options.messages,
      providerFastMode: true,
    }).max_tokens,
    undefined,
    'other provider routes retain their existing output budget'
  );
  assert.equal(options.effort, 'minimal');
  assert.equal(options.response_format?.json_schema.name, 'router_decision');
  assert.equal(options.response_format?.json_schema.strict, true);

  const providerAction =
    'start_superintelligence(goal="Inspect the \\"workspace\\" file list, once", mode="execute")';
  assert.deepEqual(parseRouterDecisionJson(providerAction), {
    action: 'start_superintelligence',
    goal: 'Inspect the "workspace" file list, once',
    mode: 'execute',
    reasoning: 'Route selected from a provider action response.',
  });
  assert.deepEqual(
    parseRouterDecisionAfterDeadline(providerAction, providerAction),
    parseRouterDecisionJson(providerAction)
  );
  assert.throws(() =>
    parseRouterDecisionJson('start_superintelligence(goal="ok", mode="invalid")')
  );
  assert.throws(() =>
    parseRouterDecisionJson('start_superintelligence(goal="ok", mode="plan");do_bad()')
  );

  assert.equal(
    parseRouterDecisionAfterDeadline('', ''),
    null,
    'a silent provider must surface the router deadline rather than inventing a decision'
  );

  assert.equal(CHAT_TIMEOUT_MS, 15_000, 'chat gets 15s from the start of each request');
  assert.equal(DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS, CHAT_TIMEOUT_MS);
  assert.equal(
    DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
    8_000,
    'direct Cerebras gets 8s from the start of its request'
  );
  assert.ok(
    DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS < DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
    'ending direct Cerebras must leave the failover racing inside the router attempt'
  );
  assert.equal(
    DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS,
    CHAT_TIMEOUT_MS,
    'the failover branch that serves a Cerebras stall must not give up before the router does'
  );
  assert.ok(
    DEFAULT_CEREBRAS_CHAT_HEDGE_MS < DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
    'the hedge must start the failover while Cerebras is still racing'
  );
  const savedCompletion = process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
  delete process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
  assert.equal(chatRouterCompletionTimeoutMs(), 15_000);
  process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = '400';
  assert.equal(chatRouterCompletionTimeoutMs(), 400);
  for (const invalid of ['nope', '-1', '0']) {
    process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = invalid;
    assert.equal(chatRouterCompletionTimeoutMs(), 15_000, `invalid override ${invalid}`);
  }
  if (savedCompletion === undefined) delete process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
  else process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = savedCompletion;

  assert.deepEqual(
    parsePartialRouterDecisionJson(
      '{"reasoning":"closed explanation","action":"direct_answer","query":"","goal":"","mode":"plan"'
    ),
    { action: 'direct_answer', reasoning: 'closed explanation' }
  );
  assert.deepEqual(
    parsePartialRouterDecisionJson(
      '{"reasoning":"closed explanation","action":"web_search","queries":["latest provider status","provider outage today"],"goal":"","mode":"plan"'
    ),
    {
      action: 'web_search',
      queries: ['latest provider status', 'provider outage today'],
      reasoning: 'closed explanation',
    }
  );
  assert.deepEqual(
    parsePartialRouterDecisionJson(
      '{"reasoning":"closed explanation","action":"web_search","query":"latest provider status","goal":"","mode":"plan"'
    ),
    { action: 'web_search', queries: ['latest provider status'], reasoning: 'closed explanation' },
    'a legacy single-query response recovers as one query'
  );
  assert.equal(
    parsePartialRouterDecisionJson(
      '{"action":"web_search","queries":["latest provider status","provider out'
    ),
    null,
    'deadline recovery must not guess from an unclosed queries array'
  );
  assert.equal(
    parsePartialRouterDecisionJson('{"action":"web_search","query":"latest provider status'),
    null,
    'deadline recovery must not guess from an unterminated action-specific field'
  );
  assert.deepEqual(
    parsePartialRouterDecisionJson(
      '{"reasoning":"closed explanation","action":"start_superintelligence","queries":[],"goal":"inspect the workspace","mode":"plan"'
    ),
    {
      action: 'start_superintelligence',
      goal: 'inspect the workspace',
      mode: 'plan',
      reasoning: 'closed explanation',
    },
    'an empty queries array before goal does not stop field recovery'
  );
  assert.equal(
    parsePartialRouterDecisionJson('{"reasoning":"embedded \\"action\\":\\"direct_answer\\" text'),
    null,
    'deadline recovery must not treat a field embedded in another string as the route'
  );
  assert.deepEqual(
    parsePartialRouterDecisionJson(
      '{"reasoning":"closed explanation","action":"start_superintelligence","query":"","goal":"inspect the workspace","mode":"execute"'
    ),
    {
      action: 'start_superintelligence',
      goal: 'inspect the workspace',
      mode: 'execute',
      reasoning: 'closed explanation',
    }
  );
  assert.deepEqual(
    parseRouterDecisionAfterDeadline(
      '{"reasoning":"complete response","action":"start_superintelligence","goal":"inspect the workspace"}',
      '{"reasoning":"complete response","action":"start_superintelligence","goal":"inspect the workspace"}'
    ),
    {
      action: 'start_superintelligence',
      goal: 'inspect the workspace',
      mode: 'plan',
      reasoning: 'complete response',
    },
    'deadline recovery must prefer a complete response with strict-parser defaults'
  );
  assert.deepEqual(
    parseRouterDecisionAfterDeadline(
      '{"reasoning":"truncated",',
      '{"reasoning":"closed explanation","action":"direct_answer"'
    ),
    { action: 'direct_answer', reasoning: 'closed explanation' },
    'deadline recovery must fall back to complete fields from a partial response'
  );

  const silent = createRouterCompletionDeadline(20);
  await new Promise<void>((resolve) => silent.signal.addEventListener('abort', () => resolve()));
  assert.equal(silent.expired(), true, 'a silent stream must end at the deadline');
  silent.dispose();

  async function* trickle(): AsyncGenerator<number> {
    let chunk = 0;
    for await (const step of every(10, 1)) {
      chunk += step;
      yield chunk;
    }
  }
  // Advance the actual timer APIs after each observed chunk. Host scheduling
  // must not decide whether this fixture produced its required progress.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const trickling = createRouterCompletionDeadline(150);
  try {
    const stream = streamBeforeRouterCompletionDeadline(trickle(), trickling);
    let trickled = 0;
    for (let chunk = 1; chunk <= 14; chunk += 1) {
      const next = stream.next();
      mock.timers.tick(10);
      const result = await next;
      assert.equal(result.done, false);
      assert.equal(result.value, chunk);
      trickled = chunk;
    }
    assert.ok(trickled > 3, 'precondition: the stream kept making progress');
    const afterProgress = stream.next();
    mock.timers.tick(9);
    assert.equal(
      trickling.expired(),
      false,
      'progress remains allowed before the attempt deadline'
    );
    mock.timers.tick(1);
    assert.equal(trickling.expired(), true, 'progress must not extend the attempt deadline');
    assert.equal((await afterProgress).done, true);
  } finally {
    trickling.dispose();
    mock.timers.reset();
  }

  let iteratorClosed = false;
  const uncooperativeStream: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<string>>(() => undefined),
        return: async () => {
          iteratorClosed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const hardDeadline = createRouterCompletionDeadline(5);
  const deadlineResult = await streamBeforeRouterCompletionDeadline(
    uncooperativeStream,
    hardDeadline
  )
    [Symbol.asyncIterator]()
    .next();
  assert.equal(deadlineResult.done, true, 'deadline expiry must end the bounded stream');
  assert.equal(hardDeadline.expired(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(iteratorClosed, true, 'deadline expiry must close an uncooperative iterator');
  hardDeadline.dispose();

  process.stdout.write(
    'PASS chat Router fallback is reasoning- and completion-bounded at the 15s chat timeout\n'
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
