import { execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
import assert from 'node:assert/strict';
import { AgentCardRoutingProvider } from '../../providers/card-provider/agentcard-routing';

export async function assertAgentCardProviderProvenance(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalConnect = Socket.prototype.connect;
  globalThis.fetch = async () => {
    throw new Error('UNEXPECTED_PROVIDER_NETWORK');
  };
  Socket.prototype.connect = function () {
    throw new Error('UNEXPECTED_NETWORK_OR_DATABASE');
  };
  try {
    let rail: 'legacy' | 'v2' | 'unknown' = 'legacy';
    let legacyMints = 0,
      v2Mints = 0,
      onboardings = 0,
      legacyReads = 0,
      v2Reads = 0,
      legacyCloses = 0,
      v2Closes = 0;
    const details = {
      pan: '4242424242424242',
      cvv: '123',
      expiry: '12/30',
      status: 'OPEN',
      balanceCents: 100,
    };
    const legacy = {
      mintCard: async () => {
        legacyMints++;
        return {
          cardId: 'card_legacy',
          last4: '4242',
          expiry: '12/30',
          spendLimitCents: 100,
          status: 'OPEN',
        };
      },
      getDetails: async () => {
        legacyReads++;
        return details;
      },
      closeCard: async () => {
        legacyCloses++;
      },
    };
    const v2 = {
      mintCard: async () => {
        v2Mints++;
        return {
          cardId: 'rest-owned',
          last4: '4242',
          expiry: '12/30',
          spendLimitCents: 100,
          status: 'OPEN',
        };
      },
      getDetails: async () => {
        v2Reads++;
        return details;
      },
      closeCard: async () => {
        v2Closes++;
      },
    };
    const routing = new AgentCardRoutingProvider('rose-owned', {
      resolveOrgCardholderId: async () => 'ch-owned',
      createOrgProvider: () => legacy,
      createUserProvider: () => legacy,
      startOrgOnboarding: async () => {
        throw new Error('must not onboard legacy replay');
      },
      resolveV2UserId: async () => 'usr-current',
      createV2Provider: () => v2,
      startV2Onboarding: async () => {
        onboardings++;
        return { sessionId: 'otp', setupUrl: 'https://example.invalid/otp' };
      },
      resolveMintRail: async () => rail,
      resolveCardRail: async () => rail,
    });
    const request = {
      amountCents: 100,
      fundsSource: 'company_flow' as const,
      idempotencyKey: 'purchase:legacy-pending',
      expectedLivemode: false,
    };
    await routing.mintCard(request);
    assert.equal(
      legacyMints,
      1,
      'persisted legacy funding intent must replay legacy even after v2 enrollment'
    );
    assert.equal(v2Mints, 0);
    assert.equal(onboardings, 0);
    await routing.getDetails('card_legacy');
    await routing.closeCard('card_legacy');
    assert.equal(legacyReads, 1, 'card_ is not REST provenance');
    assert.equal(legacyCloses, 1);
    assert.equal(v2Reads, 0);
    assert.equal(v2Closes, 0);
    rail = 'v2';
    await routing.mintCard(request);
    await routing.getDetails('rest-owned');
    await routing.closeCard('rest-owned');
    assert.equal(v2Mints, 1);
    assert.equal(v2Reads, 1);
    assert.equal(v2Closes, 1);
    rail = 'unknown';
    await assert.rejects(
      routing.mintCard(request),
      (e) => (e as { code?: string }).code === 'agentcard_funding_provider_unknown'
    );
    await assert.rejects(
      routing.getDetails('card_unknown'),
      (e) => (e as { code?: string }).code === 'agentcard_card_provider_unknown'
    );
    await assert.rejects(
      routing.closeCard('card_unknown'),
      (e) => (e as { code?: string }).code === 'agentcard_card_provider_unknown'
    );
    assert.equal(onboardings, 0, 'an ambiguous existing intent cannot initiate OTP');
    assert.equal(v2Mints, 1);
    assert.equal(legacyMints, 1);
    assert.equal(legacyCloses, 1);
    assert.equal(v2Closes, 1);

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        String.raw`
const assert = require('node:assert/strict'), Module = require('node:module'), path = require('node:path');
global.fetch = async () => { throw new Error('UNEXPECTED_PROVIDER_NETWORK'); };
require('node:net').Socket.prototype.connect = () => { throw new Error('UNEXPECTED_DATABASE_OR_NETWORK'); };
let funding = null, writes = [], orgCardholder = 'ch-current';
const purchase = { id: 'owned-intent', userId: 'rose-owned', agentId: 'agent-owned', totalCents: 100, stripeLivemode: false, cardId: 'card_legacy' };
const db = { purchaseSpend: { findUnique: async () => ({ ...purchase, walletFunding: funding }), findFirst: async () => ({ ...purchase, walletFunding: funding }) }, purchaseWalletFunding: { upsert: async args => { writes.push(args); funding ??= { id: 'funding-owned', ...args.create }; return funding; } } };
const id = require.resolve(path.join(process.cwd(), 'src/providers/database.ts')); const m = new Module(id); m.loaded = true; m.exports = { prisma: db }; require.cache[id] = m;
const storeId = require.resolve(path.join(process.cwd(), 'src/providers/agentcard/store.ts')); const sm = new Module(storeId); sm.loaded = true; sm.exports = { getV2ConnectedUserId: async () => 'usr-current', getOrgManagedCardholderId: async () => orgCardholder }; require.cache[storeId] = sm;
const { preparePurchaseWalletCollection } = require('./src/providers/purchase-wallet-funding.ts');
const { resolveAgentCardMintRail, resolveAgentCardCardRail } = require('./src/providers/card-provider/agentcard-provenance.ts');
const request = { amountCents: 100, idempotencyKey: 'purchase:owned-intent', fundsSource: 'company_flow', expectedLivemode: false };
(async () => {
  await preparePurchaseWalletCollection(purchase, 'usd');
  assert.equal(funding.metadata.cardProviderRail, 'v2', 'new intent must persist route before first external call');
  assert.deepEqual(writes[0].update, {}, 'existing intent metadata must never be reset');
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'v2');
  funding.metadata = { funding_model: 'company_flow' };
  await preparePurchaseWalletCollection(purchase, 'usd');
  assert.deepEqual(funding.metadata, { funding_model: 'company_flow' });
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'legacy');
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_legacy'), 'legacy');
  orgCardholder = undefined;
  let userReads = 0, userCloses = 0, orgReads = 0, orgCloses = 0, restReads = 0, restCloses = 0;
  const provider = counts => ({ mintCard: async () => { throw new Error('must not mint'); }, getDetails: async () => { counts.read(); return {}; }, closeCard: async () => counts.close() });
  const { AgentCardRoutingProvider } = require('./src/providers/card-provider/agentcard-routing.ts');
  const knownOrgCard = new AgentCardRoutingProvider('rose-owned', {
    resolveOrgCardholderId: async () => orgCardholder,
    createOrgProvider: () => provider({ read: () => orgReads++, close: () => orgCloses++ }),
    createUserProvider: () => provider({ read: () => userReads++, close: () => userCloses++ }),
    startOrgOnboarding: async () => { throw new Error('must not onboard'); },
    createV2Provider: () => provider({ read: () => restReads++, close: () => restCloses++ }),
    resolveCardRail: resolveAgentCardCardRail,
  });
  const missingOrgResults = await Promise.allSettled([knownOrgCard.getDetails('card_legacy'), knownOrgCard.closeCard('card_legacy')]);
  assert(missingOrgResults.every(result => result.status === 'rejected' && result.reason.code === 'agentcard_card_provider_unknown'), 'known company-flow card without org binding must not fall back to user MCP for read or close');
  assert.deepEqual({ userReads, userCloses, orgReads, orgCloses, restReads, restCloses }, { userReads: 0, userCloses: 0, orgReads: 0, orgCloses: 0, restReads: 0, restCloses: 0 });
  orgCardholder = 'ch-current';
  funding.metadata = {};
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown', 'unmarked transferless old intent cannot become a new v2 mint');
  funding.metadata = { apiVersion: 2 };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'v2');
  assert.equal(await resolveAgentCardMintRail('rose-foreign', request), 'unknown');
  assert.equal(await resolveAgentCardMintRail('rose-owned', { ...request, expectedLivemode: true }), 'unknown');
  assert.equal(await resolveAgentCardMintRail('rose-owned', { ...request, amountCents: 101 }), 'unknown');
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_other'), 'unknown');
  funding.userId = 'rose-foreign';
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown');
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_legacy'), 'unknown');
  funding.userId = 'rose-owned'; funding.metadata = { apiVersion: 2, funding_model: 'company_flow' };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown');
  funding.metadata = { apiVersion: 2, user_id: 'usr-original' };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown', 'do not rebind a replay to a different provider user');
  funding.metadata = { funding_model: 'company_flow', cardholder_id: 'ch-original' };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown', 'legacy replay retains its original cardholder');
  funding.metadata = { apiVersion: 2, user_id: 7 };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown');
  funding.metadata = { apiVersion: 1, cardholder_id: null };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown');
  funding.metadata = { apiVersion: 3, funding_model: 'company_flow' };
  assert.equal(await resolveAgentCardMintRail('rose-owned', request), 'unknown');
  funding.metadata = { apiVersion: 2, card_id: 'card_other' };
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_legacy'), 'unknown');
  process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = ''; process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'fixture-legacy-token'; funding.metadata = { apiVersion: 2 };
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_legacy'), 'v2', 'known v2 never falls back for absent credentials');
  funding.metadata = {};
  assert.equal(await resolveAgentCardCardRail('rose-owned', 'card_legacy'), 'legacy', 'legacy-only install retains exact MCP card access');
  orgCardholder = undefined;
  const legacyUserCard = new AgentCardRoutingProvider('rose-owned', {
    resolveOrgCardholderId: async () => orgCardholder,
    createOrgProvider: () => { throw new Error('must not guess org for legacy user card'); },
    createUserProvider: () => provider({ read: () => userReads++, close: () => userCloses++ }),
    startOrgOnboarding: async () => { throw new Error('must not onboard'); },
    resolveCardRail: resolveAgentCardCardRail,
  });
  await legacyUserCard.getDetails('card_legacy');
  await legacyUserCard.closeCard('card_legacy');
  assert.deepEqual({ userReads, userCloses, orgReads, orgCloses, restReads, restCloses }, { userReads: 1, userCloses: 1, orgReads: 0, orgCloses: 0, restReads: 0, restCloses: 0 }, 'separate legacy-only user-card access remains supported');
  console.log('PASS real intent persistence and user/amount/mode/card provenance controls');
})().catch(e => { console.error(e); process.exitCode = 1; });
`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENTCARD_V2_LIVE_SANDBOX: '', AGENTCARD_V2_LIVE_READ: '' },
        stdio: 'pipe',
      }
    );

    console.log('PASS durable AgentCard mint/card provenance and ambiguous-intent refusal');
  } finally {
    globalThis.fetch = originalFetch;
    Socket.prototype.connect = originalConnect;
  }
}
