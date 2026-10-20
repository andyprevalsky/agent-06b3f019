#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import { POOL_REGISTRY } from '../../providers/rose/pools';
import { ANTHROPIC_API_URL, postAnthropicStream } from '../../providers/rose/transport';

/**
 * Provider-observed Claude OAuth client-version floors, keyed by the model the
 * OAuth transport sends: the minimum CLI version demanded by a captured
 * `claude_code_version_too_old` rejection, or the version at which a live
 * OAuth call to the model succeeded. Every pool `claudeAuthModel` must appear
 * here — retargeting rose-1-ultra to claude-opus-5-5 (which requires 2.1.280)
 * while the transport advertised 2.1.251 silently dropped every ultra Claude
 * call to GPT from 2026-09-27. Mirrors CLAUDE_OAUTH_CLIENT_VERSION_FLOORS in
 * agents/tests/blackbox/rose.blackbox.py.
 */
const CLAUDE_OAUTH_CLIENT_VERSION_FLOORS: Record<string, [number, number, number]> = {
  // 2026-09-10 captured rejection (req_011CevmJfH4uoGCZB6RutpU1).
  'claude-fable-5-1': [2, 1, 251],
  // 2026-10-20 captured rejection with a healthy reconnected token.
  'claude-opus-5-5': [2, 1, 280],
  // 2026-10-20 live OAuth calls returned HTTP 200 at 2.1.251.
  'claude-sonnet-5': [2, 1, 251],
  'claude-haiku-4-5': [2, 1, 251],
};

function below(version: number[], minimum: number[]): boolean {
  const firstDifference = version.findIndex((part, index) => part !== minimum[index]);
  return firstDifference >= 0 && version[firstDifference] < minimum[firstDifference];
}

function capturedRejection(advertised: string, required: number[]) {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `Claude Code ${advertised} does not support this model; version ${required.join('.')} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`,
      details: { error_code: 'claude_code_version_too_old' },
    },
    request_id: 'req_011CgCi6e8D8f5PgT8x86DGd',
  };
}

async function main() {
  const models = [...new Set(Object.values(POOL_REGISTRY).map((pool) => pool.claudeAuthModel))];
  const missing = models.filter((model) => !(model in CLAUDE_OAUTH_CLIENT_VERSION_FLOORS));
  assert.deepEqual(
    missing,
    [],
    'every pool claudeAuthModel needs a recorded OAuth client-version floor before routing to it'
  );
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async (input, init) => {
    assert.equal(String(input), ANTHROPIC_API_URL);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer version-test-token');
    assert.equal(headers.get('anthropic-beta')?.includes('oauth-2025-04-20'), true);
    requests++;
    const advertised = headers.get('user-agent')?.match(/^claude-cli\/((\d+)\.(\d+)\.(\d+)) /);
    assert(advertised, 'transport must identify its client version');
    const version = advertised.slice(2).map(Number);
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    const minimum = CLAUDE_OAUTH_CLIENT_VERSION_FLOORS[model];
    if (below(version, minimum)) {
      return new Response(JSON.stringify(capturedRejection(advertised[1], minimum)), {
        status: 400,
      });
    }
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200 });
  };
  try {
    const rejected: string[] = [];
    for (const model of models) {
      const response = await postAnthropicStream({
        body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true },
        claudeToken: 'version-test-token',
        requestId: `r-client-version-${model}`,
      });
      if (response.status === 200) await response.body?.cancel();
      else rejected.push(`${model}:${response.status}`);
    }
    assert.deepEqual(
      rejected,
      [],
      'OAuth transport must meet every pool model’s provider client-version requirement'
    );
    assert.equal(requests, models.length, 'direct transport must not retry or change providers');
    process.stdout.write('PASS Anthropic OAuth client-version transport contract\n');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
