#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';

function run(): void {
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

  assert.equal(options.model, 'rose-labs/rose-1-lite');
  assert.equal(options.provider_route, 'direct-cerebras');
  assert.equal(options.provider_fast_mode, true);
  assert.equal(options.abort_signal, abortController.signal);
  assert.equal(options.temperature, 0.3);
  assert.equal(options.effort, 'minimal');
  assert.equal(options.response_format?.json_schema.name, 'router_decision');
  assert.equal(options.response_format?.json_schema.strict, true);

  process.stdout.write('PASS chat Router fallback uses minimal reasoning\n');
}

run();
