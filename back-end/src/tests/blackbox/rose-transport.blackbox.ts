#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { POOL_REGISTRY } from '../../providers/rose/pools';
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_USER_AGENT,
  postAnthropicStream,
} from '../../providers/rose/transport';

interface ClaudeOAuthClientContract {
  client_version: string;
  user_agent_suffix: string;
  models: Record<string, { min_client_version: string }>;
  captured_rejection: { error: { message: string } };
}

const contract = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../shared/claude-oauth-client/contract.json'),
    'utf8'
  )
) as ClaudeOAuthClientContract;

function olderThan(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index] < b[index];
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let output = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

async function everyConfiguredModelAcceptsAdvertisedClient(): Promise<void> {
  const configured = [
    ...new Set(Object.values(POOL_REGISTRY).map((spec) => spec.claudeAuthModel)),
  ].sort();
  const missing = configured.filter((model) => !(model in contract.models));
  assert.deepEqual(
    missing,
    [],
    'claudeAuth models need a recorded live client-version requirement'
  );
  const originalFetch = global.fetch;
  const seen: string[] = [];
  global.fetch = async (input, init) => {
    assert.equal(String(input), ANTHROPIC_API_URL);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer version-test-token');
    assert.equal(headers.get('anthropic-beta')?.includes('oauth-2025-04-20'), true);
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    seen.push(model);
    const advertised = headers.get('user-agent')?.match(/^claude-cli\/(\d+\.\d+\.\d+) /);
    assert(advertised, 'transport must identify its client version');
    if (olderThan(advertised[1], contract.models[model].min_client_version)) {
      return new Response(JSON.stringify(contract.captured_rejection), { status: 400 });
    }
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200 });
  };
  try {
    for (const model of configured) {
      const response = await postAnthropicStream({
        body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true },
        claudeToken: 'version-test-token',
        requestId: `r-client-version-${model}`,
      });
      assert.equal(
        response.status,
        200,
        `OAuth transport advertised a client version ${model} rejects (captured provider contract)`
      );
      assert(response.body, 'accepted request must have a stream');
      await response.body.cancel();
    }
    assert.deepEqual(seen, configured, 'direct transport must not retry or change providers');
    // One recorded identity, mirrored by agents/providers/rose/transport.py.
    assert.equal(
      ANTHROPIC_USER_AGENT,
      `claude-cli/${contract.client_version} ${contract.user_agent_suffix}`
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function clientVersionRejectionIsSurfaced(): Promise<void> {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify(contract.captured_rejection), { status: 400 });
  try {
    let status = 0;
    const stderr = await captureStderr(async () => {
      const response = await postAnthropicStream({
        body: { model: 'claude-opus-5-5', messages: [], max_tokens: 16, stream: true },
        claudeToken: 'version-test-token',
        requestId: 'r-version-too-old',
      });
      status = response.status;
    });
    assert.equal(status, 400);
    assert.match(stderr, /anthropic\.client_version_too_old/);
    assert.match(stderr, /claude-opus-5-5/);
    assert(
      stderr.includes(contract.captured_rejection.error.message),
      'error log must carry the provider requirement'
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  await everyConfiguredModelAcceptsAdvertisedClient();
  await clientVersionRejectionIsSurfaced();
  process.stdout.write('PASS Anthropic OAuth client-version transport contract\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
