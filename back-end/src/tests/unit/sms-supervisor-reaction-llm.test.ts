/** Exercise real reaction request construction/stream parsing without a provider. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { buildOpenAiResponseFormat, responseModel } from '../../providers/rose/schema';
import type { CompletionOptions } from '../../providers/rose/types';

async function main(): Promise<void> {
  const requests: CompletionOptions[] = [];
  const previousModel = process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  const previousRoute = process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  delete process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  delete process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  await mock.module('../../providers/rose', {
    namedExports: {
      buildOpenAiResponseFormat,
      responseModel,
      createStreamingCompletion: async (options: CompletionOptions) => {
        requests.push(options);
        const body = JSON.stringify({
          reasoning: 'Celebrate the good news.',
          tool_calls: [{ tool: 'react_to_message', arguments: { emoji: '🥳' } }],
        });
        return (async function* () {
          yield { choices: [{ delta: { content: body.slice(0, 20) } }] };
          yield { choices: [{ delta: { content: body.slice(20) } }] };
        })();
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/supervisorFixtures', {
    namedExports: { loadBlackboxSupervisorResponseFixture: () => null },
  });
  try {
    const { callSupervisorLlm } = await import('../../providers/smsSupervisor/supervisorLlm');
    const inbound = 'I got the job!';
    const selected = await callSupervisorLlm(
      [{ role: 'user', content: inbound }],
      { type: 'claude', accessToken: 'test-token' },
      'reaction-llm-test',
      true
    );
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.model, 'rose-labs/rose-1-flash');
    assert.equal(request.messages[0].content, inbound);
    assert.equal(request.messages.at(-1)?.role, 'user');
    assert.match(String(request.messages.at(-1)?.content), /Current UTC time:/);
    assert.equal(request.provider_route, undefined);
    assert.equal(request.claude_token, undefined);
    assert.equal(request.response_model?.name, 'sms_supervisor_reaction');
    assert.equal(selected.tool_calls[0].arguments.emoji, '🥳');
    for (const emoji of ['🫶🏽', '🦦', '🇳🇿', '🧑‍🚀']) {
      assert.equal(
        request.response_model?.schema.safeParse({
          reasoning: '',
          tool_calls: [{ tool: 'react_to_message', arguments: { emoji } }],
        }).success,
        true,
        'no palette in the model schema'
      );
    }
    assert.equal(
      request.response_model?.schema.safeParse({
        reasoning: '',
        tool_calls: [{ tool: 'grep', arguments: { pattern: 'x' } }],
      }).success,
      false,
      'selection cannot request another tool'
    );
  } finally {
    if (previousModel === undefined) delete process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
    else process.env.BENCHMARK_SMS_SUPERVISOR_MODEL = previousModel;
    if (previousRoute === undefined) delete process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
    else process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE = previousRoute;
  }
  process.stdout.write('PASS sms-supervisor-reaction-llm request and arbitrary emoji selection\n');
}

void main();
