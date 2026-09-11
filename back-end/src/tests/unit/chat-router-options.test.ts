#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import {
  createRouterCompletionDeadline,
  DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS,
  streamBeforeRouterCompletionDeadline,
} from '../../providers/chat/routerCompletionDeadline';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import {
  parsePartialRouterDecisionJson,
  parseRouterDecisionAfterDeadline,
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

  assert.equal(options.model, 'rose-labs/rose-1-lite');
  assert.equal(options.provider_route, 'direct-cerebras');
  assert.equal(options.provider_fast_mode, true);
  assert.equal(options.abort_signal, abortController.signal);
  assert.equal(options.temperature, 0.3);
  assert.equal(options.effort, 'minimal');
  assert.equal(options.response_format?.json_schema.name, 'router_decision');
  assert.equal(options.response_format?.json_schema.strict, true);

  assert.equal(DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS, 3_000);
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

  const deadline = createRouterCompletionDeadline(5);
  await new Promise<void>((resolve) => deadline.signal.addEventListener('abort', () => resolve()));
  assert.equal(deadline.expired(), true, 'the completion deadline must abort a trickling stream');
  deadline.dispose();

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

  process.stdout.write('PASS chat Router fallback is reasoning- and completion-bounded\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
