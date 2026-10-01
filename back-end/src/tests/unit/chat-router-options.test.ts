#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import {
  chatRouterCompletionBounds,
  createRouterCompletionDeadline,
  DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
  DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS,
  streamBeforeRouterCompletionDeadline,
} from '../../providers/chat/routerCompletionDeadline';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS } from '../../providers/rose/openrouterFastRoute';
import {
  parsePartialRouterDecisionJson,
  parseRouterDecisionAfterDeadline,
} from '../../providers/chat/routerDecision';

async function run(): Promise<void> {
  const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
  const abortController = new AbortController();
  const options = buildRouterCompletionOptions({
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
  assert.equal(options.temperature, 0.3);
  assert.equal(options.effort, 'minimal');
  assert.equal(options.response_format?.json_schema.name, 'router_decision');
  assert.equal(options.response_format?.json_schema.strict, true);

  assert.equal(DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS, 5_000);
  assert.equal(DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS, 15_000);
  assert.ok(
    DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS >= DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS,
    'the failover branch that serves a Cerebras stall must not give up before the router does'
  );
  const savedStall = process.env.CHAT_ROUTER_STALL_TIMEOUT_MS;
  const savedCompletion = process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
  delete process.env.CHAT_ROUTER_STALL_TIMEOUT_MS;
  delete process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
  assert.deepEqual(chatRouterCompletionBounds(), {
    stallTimeoutMs: 5_000,
    completionTimeoutMs: 15_000,
  });
  process.env.CHAT_ROUTER_STALL_TIMEOUT_MS = '900';
  process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = '400';
  assert.deepEqual(
    chatRouterCompletionBounds(),
    { stallTimeoutMs: 400, completionTimeoutMs: 400 },
    'the stall bound can never outlive the completion cap'
  );
  process.env.CHAT_ROUTER_STALL_TIMEOUT_MS = 'nope';
  process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS = '-1';
  assert.deepEqual(chatRouterCompletionBounds(), {
    stallTimeoutMs: 5_000,
    completionTimeoutMs: 15_000,
  });
  if (savedStall === undefined) delete process.env.CHAT_ROUTER_STALL_TIMEOUT_MS;
  else process.env.CHAT_ROUTER_STALL_TIMEOUT_MS = savedStall;
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
      '{"reasoning":"closed explanation","action":"web_search","query":"latest provider status","goal":"","mode":"plan"'
    ),
    { action: 'web_search', query: 'latest provider status', reasoning: 'closed explanation' }
  );
  assert.equal(
    parsePartialRouterDecisionJson('{"action":"web_search","query":"latest provider status'),
    null,
    'deadline recovery must not guess from an unterminated action-specific field'
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

  const stalled = createRouterCompletionDeadline({
    stallTimeoutMs: 20,
    completionTimeoutMs: 1_000,
  });
  await new Promise<void>((resolve) => stalled.signal.addEventListener('abort', () => resolve()));
  assert.equal(stalled.expired(), true, 'a stream with no progress must hit the stall bound');
  assert.equal(stalled.expiry(), 'stall');
  stalled.dispose();

  const progressing = createRouterCompletionDeadline({
    stallTimeoutMs: 100,
    completionTimeoutMs: 2_000,
  });
  const progressStartedAt = Date.now();
  const ticks = setInterval(() => progressing.progress(), 20);
  await new Promise((resolve) => setTimeout(resolve, 200));
  clearInterval(ticks);
  assert.ok(Date.now() - progressStartedAt > 100, 'precondition: elapsed exceeds the stall bound');
  assert.equal(progressing.expired(), false, 'progress must re-arm the stall bound');
  progressing.dispose();

  const trickling = createRouterCompletionDeadline({
    stallTimeoutMs: 100,
    completionTimeoutMs: 150,
  });
  const trickle = setInterval(() => trickling.progress(), 10);
  await new Promise<void>((resolve) => trickling.signal.addEventListener('abort', () => resolve()));
  clearInterval(trickle);
  assert.equal(trickling.expiry(), 'completion', 'the cap must end a stream that keeps trickling');
  trickling.progress();
  assert.equal(trickling.expiry(), 'completion', 'progress after expiry must not re-arm');
  trickling.dispose();

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
  const hardDeadline = createRouterCompletionDeadline({
    stallTimeoutMs: 5,
    completionTimeoutMs: 50,
  });
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

  process.stdout.write('PASS chat Router fallback is reasoning-, stall-, and completion-bounded\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
