#!/usr/bin/env tsx
import { assertAgentCardProviderProvenance } from './agentcard-v2-provenance.cases';
import path from 'node:path';
import { assertV2SetupResumeContract } from '../unit/agentcard-v2-setup-contract.cases';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { config } from 'dotenv';
import { AgentCardV2Client } from '../../providers/agentcard/api-v2';
import { AgentCardV2Provider } from '../../providers/card-provider/agentcard-v2';
import { AgentCardProviderError } from '../../providers/card-provider/errors';
import { verifyLiveSandboxV2 } from './agentcard-v2-live-fixture';
import { AgentCardRoutingProvider } from '../../providers/card-provider/agentcard-routing';

async function main(): Promise<void> {
  await assertAgentCardProviderProvenance();
  assertV2SetupResumeContract(path.resolve(__dirname, '../../..'));
  let tokenCalls = 0;
  let credentialCalls = 0;
  let companyFunding = true;
  let walletLivemode = false;
  let closed = false;
  const creates: Array<{ body: unknown; key: string | string[] | undefined }> = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/api/v2/')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    const reply = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/v2/oauth/token') {
      tokenCalls += 1;
      const form = new URLSearchParams(bodyText);
      assert.equal(form.get('client_id'), 'company-client');
      assert.equal(form.get('client_secret'), 'company-secret');
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.has('resource'), false);
      reply({ access_token: 'platform-token', expires_in: 3600 });
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer platform-token', `${req.method} ${req.url}`);
    const card = {
      object: 'card',
      id: 'card_contract',
      user_id: 'usr_connected',
      transfer_id: 'owt_contract',
      status: closed ? 'closed' : 'open',
      closed_reason: closed ? 'canceled' : undefined,
      balance_cents: closed ? 0 : 100,
      spend_limit_cents: 100,
      last4: '4242',
      expiry: '12/30',
      type: 'single_use',
    };
    if (req.url === '/api/v2/company_wallet')
      reply({
        livemode: walletLivemode,
        default_funds_source: companyFunding ? 'company_flow' : 'onramp_flow',
      });
    else if (req.url === '/api/v2/cards' && req.method === 'POST') {
      const body: unknown = JSON.parse(bodyText);
      creates.push({ body, key: req.headers['idempotency-key'] });
      assert.deepEqual(body, { user_id: 'usr_connected', amount_cents: 100, type: 'single_use' });
      if (creates.length === 1)
        reply(
          {
            object: 'card_funding',
            status: 'funding_in_progress',
            transfer_id: 'owt_contract',
            retry_after_seconds: 7,
          },
          202
        );
      else reply(card, 201);
    } else if (req.url === '/api/v2/cards/card_contract') reply(card);
    else if (req.url === '/api/v2/cards/card_contract/credentials') {
      credentialCalls += 1;
      reply({
        object: 'card_credentials',
        id: 'card_contract',
        number: '4242424242424242',
        cvc: '123',
        exp_month: '12',
        exp_year: '2030',
        last4: '4242',
      });
    } else if (req.url === '/api/v2/cards/card_contract/close' && req.method === 'POST') {
      closed = true;
      reply({ ...card, status: 'closed' });
    } else reply({ error: { code: 'invalid_request', message: 'Unexpected test resource' } }, 400);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new AgentCardV2Client(fetch, () => ({
    baseUrl: `http://127.0.0.1:${address.port}`,
    clientId: 'company-client',
    clientSecret: 'company-secret',
  }));
  const provider = new AgentCardV2Provider('usr_connected', client.request);
  const noLegacy = () => {
    throw new Error('v2 purchases must not invoke the legacy MCP path');
  };
  const routing = new AgentCardRoutingProvider('rose-user', {
    resolveOrgCardholderId: noLegacy,
    startOrgOnboarding: noLegacy,
    createOrgProvider: noLegacy,
    createUserProvider: noLegacy,
    resolveV2UserId: async () => 'usr_connected',
    createV2Provider: () => provider,
    startV2Onboarding: noLegacy,
  });
  try {
    await Promise.all(
      Array.from({ length: 10 }, () => client.request('GET', '/api/v2/company_wallet'))
    );
    assert.equal(tokenCalls, 1, 'concurrent requests must share one cached platform token');
    const intent = {
      amountCents: 100,
      fundsSource: 'company_flow' as const,
      idempotencyKey: 'purchase:contract',
      expectedLivemode: false,
    };
    await assert.rejects(
      () => routing.mintCard(intent),
      (error: unknown) =>
        error instanceof AgentCardProviderError &&
        error.code === 'agentcard_company_funding_in_progress' &&
        error.details.retryAfterSeconds === 7 &&
        error.details.transferId === 'owt_contract'
    );
    const minted = await routing.mintCard(intent);
    assert.equal(minted.providerTransferId, 'owt_contract');
    assert.equal(minted.pan, '4242424242424242');
    assert.equal(minted.cvv, '123');
    assert.equal(minted.expiry, '12/30');
    assert.equal(minted.status, 'OPEN');
    assert.deepEqual(
      creates[0],
      creates[1],
      'pending funding retries must preserve body and idempotency header'
    );
    assert.equal(tokenCalls, 1);
    await provider.closeCard('card_contract');
    await provider.closeCard('card_contract');
    const revealed = credentialCalls;
    await assert.rejects(
      () => provider.getDetails('card_contract'),
      (error: unknown) => error instanceof AgentCardProviderError && error.code === 'card_closed'
    );
    assert.equal(credentialCalls, revealed, 'closed cards must not request credentials');
    const replay = await routing.mintCard(intent);
    assert.equal(replay.status, 'CLOSED');
    assert.equal(replay.pan, undefined);
    assert.equal(
      replay.providerTransferId,
      'owt_contract',
      'closed replays retain compensation identity'
    );
    assert.equal(credentialCalls, revealed);
    companyFunding = false;
    await assert.rejects(
      () => provider.mintCard(intent),
      (error: unknown) =>
        error instanceof AgentCardProviderError && error.code === 'agentcard_setup_required'
    );
    assert.equal(creates.length, 3, 'an onramp default must never create a company purchase');
    await assert.rejects(() => provider.mintCard({ ...intent, amountCents: 99 }), /at least 100/);
    companyFunding = true;
    walletLivemode = true;
    await assert.rejects(
      () => provider.mintCard(intent),
      (error: unknown) =>
        error instanceof AgentCardProviderError && error.code === 'agentcard_setup_required'
    );
    assert.equal(creates.length, 3, 'test-mode billing must never fund a live card');
    console.log(
      'PASS AgentCard v2 company-token issuing, pending/replay, structured credentials and closure'
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  if (process.env.AGENTCARD_V2_LIVE_SANDBOX === '1') {
    config();
    await verifyLiveSandboxV2();
  }

  if (process.env.AGENTCARD_V2_LIVE_READ === '1') {
    config();
    const live = new AgentCardV2Client();
    const wallet = await live.request('GET', '/api/v2/company_wallet');
    assert.equal(wallet.object, 'company_wallet');
    assert.equal(typeof wallet.livemode, 'boolean');
    assert.equal(typeof wallet.available_cents, 'number');
    assert.equal(wallet.default_funds_source, 'company_flow');
    console.log(`PASS live AgentCard v2 read-only contract (sandbox=${wallet.livemode === false})`);
  }
}
void main();
