#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import { ANTHROPIC_API_URL, postAnthropicStream } from '../../providers/rose/transport';

async function main() {
  const capturedRejection = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        "Claude Code 2.1.81 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
      details: { error_code: 'claude_code_version_too_old' },
    },
    request_id: 'req_011CevmJfH4uoGCZB6RutpU1',
  };
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async (input, init) => {
    assert.equal(String(input), ANTHROPIC_API_URL);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer version-test-token');
    assert.equal(headers.get('anthropic-beta')?.includes('oauth-2025-04-20'), true);
    requests++;
    const advertised = headers.get('user-agent')?.match(/^claude-cli\/(\d+)\.(\d+)\.(\d+) /);
    assert(advertised, 'transport must identify its client version');
    const version = advertised.slice(1).map(Number);
    const minimum = [2, 1, 251];
    const firstDifference = version.findIndex((part, index) => part !== minimum[index]);
    if (firstDifference >= 0 && version[firstDifference] < minimum[firstDifference]) {
      return new Response(JSON.stringify(capturedRejection), { status: 400 });
    }
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200 });
  };
  try {
    const response = await postAnthropicStream({
      body: {
        model: 'claude-fable-5-1',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: true,
      },
      claudeToken: 'version-test-token',
      requestId: 'r-client-version',
    });
    assert.equal(
      response.status,
      200,
      'OAuth transport must meet the captured provider client-version requirement'
    );
    assert(response.body, 'accepted request must have a stream');
    await response.body.cancel();
    assert.equal(requests, 1, 'direct transport must not retry or change providers');
    process.stdout.write('PASS Anthropic OAuth client-version transport contract\n');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
