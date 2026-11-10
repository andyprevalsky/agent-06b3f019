/** Exercise real reaction request construction/stream parsing without a provider. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { buildOpenAiResponseFormat, responseModel } from '../../providers/rose/schema';
import type { ComputeCodeCredentialResult } from '../../providers/computeCredentials';
import type { CompletionOptions } from '../../providers/rose/types';

async function main(): Promise<void> {
  const requests: CompletionOptions[] = [];
  const credential: ComputeCodeCredentialResult = {
    type: 'claude',
    accessToken: 'test-token',
    source: 'pool',
    userId: 'reaction-llm-test',
    poolTokenId: 'fixture-pool-token',
    integrationId: 'fixture-integration',
    lineageKey: 'fixture-lineage',
  };
  const marked: ComputeCodeCredentialResult[] = [];
  const fetches: Array<{ excludePoolTokenIds?: string[] } | undefined> = [];
  await mock.module('../../providers/computeCredentials', {
    namedExports: {
      fetchComputeTokenForUser: async (
        _userId: string,
        options?: { excludePoolTokenIds?: string[] }
      ) => {
        fetches.push(options);
        return fetches.length === 1 ? credential : null;
      },
      markComputeTokenUnavailable: async (token: ComputeCodeCredentialResult) => {
        marked.push(token);
      },
    },
  });
  const previousModel = process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  const previousRoute = process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  const previousTokenType = process.env.BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE;
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
      credential,
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
    process.env.BENCHMARK_SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-ultra';
    process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE = 'pool-default';
    process.env.BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE = 'claude';
    const { getComputeToken } =
      await import('../../providers/smsSupervisor/supervisorComputeToken');
    const leased = await getComputeToken(credential.userId);
    assert.deepEqual(leased, credential, 'preserve complete broker identity and custody metadata');
    await callSupervisorLlm([{ role: 'user', content: inbound }], leased, credential.userId, true);
    const pinned = requests[1]!;
    assert.equal(pinned.claude_token, credential.accessToken);
    assert(pinned.subscription_leases, 'pinned benchmark carries subscription rotation source');
    assert.equal(
      await pinned.subscription_leases.next({
        credential: { type: 'claude', accessToken: credential.accessToken },
        reason: 'rate_limit',
      }),
      null
    );
    assert.deepEqual(
      marked,
      [credential],
      'initial credential must be known when first subscription fails'
    );
    assert(fetches.length >= 2, 'failed initial lease attempts another broker lookup');
    assert(
      fetches
        .slice(1)
        .every((options) => options?.excludePoolTokenIds?.includes(credential.poolTokenId!)),
      'rotation excludes the failed initial pool credential'
    );
  } finally {
    if (previousTokenType === undefined) delete process.env.BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE;
    else process.env.BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE = previousTokenType;
    if (previousModel === undefined) delete process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
    else process.env.BENCHMARK_SMS_SUPERVISOR_MODEL = previousModel;
    if (previousRoute === undefined) delete process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
    else process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE = previousRoute;
  }
  process.stdout.write('PASS sms-supervisor-reaction-llm request and arbitrary emoji selection\n');
}

void main();
