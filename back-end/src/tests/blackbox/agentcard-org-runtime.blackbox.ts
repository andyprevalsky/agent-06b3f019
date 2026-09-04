#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';

const CREDENTIAL_ENV = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_API_KEY',
  'AGENTCARD_ADMIN_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
  'AGENTCARD_OAUTH_CLIENT_ID',
  'AGENTCARD_OAUTH_CLIENT_SECRET',
] as const;

async function main(): Promise<void> {
  const original = Object.fromEntries(CREDENTIAL_ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of CREDENTIAL_ENV) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'blackbox-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'blackbox-secret';

    let tokenRequests = 0;
    const seenTokens: string[] = [];
    const runtime = new AgentCardOrgRuntime(
      async (accessToken) => {
        seenTokens.push(accessToken);
        return { structuredContent: { transfers: [] } };
      },
      async () => {
        tokenRequests += 1;
        throw new Error('org runtime must not exchange client credentials for a JWT');
      }
    );

    await Promise.all([
      runtime.callTool('get_card', { card_id: 'card-1' }),
      runtime.callTool('list_transfers', { status: 'consumed', limit: 100 }),
      runtime.callTool('list_transfers', { limit: 100 }),
    ]);
    assert.equal(tokenRequests, 0, 'a lifecycle fanout must not hit the OAuth token endpoint');
    assert.deepEqual(
      seenTokens,
      ['blackbox-secret', 'blackbox-secret', 'blackbox-secret'],
      'lifecycle reads must send the org client secret as Bearer'
    );

    for (const name of CREDENTIAL_ENV) delete process.env[name];
    process.env.AGENTCARD_API_KEY = 'sk_test_retired';
    process.env.AGENTCARD_OAUTH_CLIENT_ID = 'user-client';
    process.env.AGENTCARD_OAUTH_CLIENT_SECRET = 'user-secret';
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'sk_test_retired';
    const retiredCredentialsRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired or user-scoped credentials must not reach the org transport');
    });
    await assert.rejects(
      () => retiredCredentialsRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    console.log('PASS AgentCard org lifecycle uses the client secret as Bearer');
  } finally {
    for (const name of CREDENTIAL_ENV) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void main();
