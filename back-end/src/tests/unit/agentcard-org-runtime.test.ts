#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { AGENTCARD_MCP_RESOURCE } from '../../providers/agentcard/config';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';

const ENV_NAMES = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_API_KEY',
  'AGENTCARD_ADMIN_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
  'AGENTCARD_OAUTH_CLIENT_ID',
  'AGENTCARD_OAUTH_CLIENT_SECRET',
] as const;

async function main(): Promise<void> {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'wizard-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'wizard-secret';

    let tokenRequests = 0;
    let calledWithToken = '';
    const runtime = new AgentCardOrgRuntime(
      async (accessToken, toolName, args) => {
        calledWithToken = accessToken;
        assert.equal(toolName, 'list_transfers');
        assert.deepEqual(args, { limit: 100 });
        return { structuredContent: { transfers: [] } };
      },
      async (_input, init) => {
        tokenRequests += 1;
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_id'), 'wizard-client');
        assert.equal(form.get('client_secret'), 'wizard-secret');
        assert.equal(form.get('resource'), AGENTCARD_MCP_RESOURCE);
        return new Response(JSON.stringify({ access_token: 'fresh-org-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );

    await runtime.callTool('list_transfers', { limit: 100 });
    await runtime.callTool('list_transfers', { limit: 100 });
    assert.equal(calledWithToken, 'fresh-org-token');
    assert.equal(tokenRequests, 1, 'client-credential tokens should be cached until near expiry');

    let concurrentTokenRequests = 0;
    let releaseTokenRequest: (() => void) | undefined;
    const tokenRequestReleased = new Promise<void>((resolve) => {
      releaseTokenRequest = resolve;
    });
    const concurrentRuntime = new AgentCardOrgRuntime(
      async () => ({ structuredContent: { transfers: [] } }),
      async () => {
        concurrentTokenRequests += 1;
        await tokenRequestReleased;
        return new Response(
          JSON.stringify({ access_token: 'shared-org-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    );
    const concurrentCalls = Promise.all([
      concurrentRuntime.callTool('get_card', { card_id: 'card-1' }),
      concurrentRuntime.callTool('list_transfers', { status: 'consumed', limit: 100 }),
      concurrentRuntime.callTool('list_transfers', { limit: 100 }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      concurrentTokenRequests,
      1,
      'concurrent org reads must share one client-credential token exchange'
    );
    releaseTokenRequest?.();
    await concurrentCalls;
    assert.equal(concurrentTokenRequests, 1);

    let retryTokenRequests = 0;
    let toolCalls = 0;
    const retryingRuntime = new AgentCardOrgRuntime(
      async (accessToken) => {
        toolCalls += 1;
        if (toolCalls === 1) throw new Error('Invalid or expired organization token');
        assert.equal(accessToken, 'org-token-2');
        return { structuredContent: { transfers: [] } };
      },
      async () => {
        retryTokenRequests += 1;
        return new Response(
          JSON.stringify({ access_token: `org-token-${retryTokenRequests}`, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    );
    await retryingRuntime.callTool('list_transfers', { limit: 100 });
    assert.equal(retryTokenRequests, 2, 'an MCP auth rejection must refresh once');
    assert.equal(toolCalls, 2, 'an MCP auth rejection must retry the tool once');

    // A stalled/aborted token endpoint surfaces as an AgentCardOrgRuntimeError, not a raw hang.
    const timingOutRuntime = new AgentCardOrgRuntime(
      async () => {
        throw new Error('tool must not run when the token cannot be acquired');
      },
      async () => {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
    );
    await assert.rejects(
      () => timingOutRuntime.callTool('list_transfers', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 504 &&
        error.code === 'agentcard_org_token_unavailable'
    );

    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_API_KEY = 'sk_test_retired';
    const retiredKeyRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired API key must never reach the Organization MCP transport');
    });
    await assert.rejects(
      () => retiredKeyRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'sk_test_retired';
    const retiredDirectTokenRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired direct token must never reach the Organization MCP transport');
    });
    await assert.rejects(
      () => retiredDirectTokenRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    process.stdout.write('AgentCard org runtime tests passed\n');
  } finally {
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void main();
