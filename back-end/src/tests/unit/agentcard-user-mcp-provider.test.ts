#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { AgentCardUserMcpProvider } from '../../providers/card-provider';

type Call = {
  userId: string;
  name: string;
  args: Record<string, unknown>;
};

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function toolResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function main(): Promise<void> {
  process.env.AGENTCARD_PUBLIC_URL = 'https://rose.test';

  await test('mints through per-user MCP and resolves AgentCard approval gate', async () => {
    const calls: Call[] = [];
    let approved = false;
    const provider = new AgentCardUserMcpProvider('user-123', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'create_card') {
        return approved
          ? toolResult({ card_id: 'card-123', status: 'ACTIVE' })
          : toolResult({ approval_required: true, approval_id: 'approval-123' });
      }
      if (name === 'approve_request') {
        approved = true;
        return toolResult({ approved: true });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242424242',
          cvv: '123',
          expiry: '12/30',
          balance_cents: 2500,
          status: 'ACTIVE',
        });
      }
      throw new Error(`unexpected tool ${name}`);
    });

    const minted = await provider.mintCard({ amountCents: 2500, idempotencyKey: 'idem-1' });

    assert.deepStrictEqual(minted, {
      cardId: 'card-123',
      last4: '4242',
      expiry: '12/30',
      spendLimitCents: 2500,
      status: 'ACTIVE',
    });
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-123', 'create_card', { amount_cents: 2500 }],
        ['user-123', 'approve_request', { approval_id: 'approval-123' }],
        ['user-123', 'create_card', { amount_cents: 2500 }],
        ['user-123', 'get_card_details', { card_id: 'card-123' }],
      ]
    );
  });

  await test('reads and closes cards through the same connected user token', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider('user-abc', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'get_card_details') {
        return toolResult({
          pan: '5555555555554444',
          cvv: '321',
          expiry: '01/31',
          balance_cents: 100,
          status: 'OPEN',
        });
      }
      if (name === 'close_card') return toolResult({ ok: true });
      throw new Error(`unexpected tool ${name}`);
    });

    const details = await provider.getDetails('card-abc');
    await provider.closeCard('card-abc');

    assert.strictEqual(details.pan, '5555555555554444');
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-abc', 'get_card_details', { card_id: 'card-abc' }],
        ['user-abc', 'close_card', { card_id: 'card-abc' }],
      ]
    );
  });

  await test('resolves AgentCard approval gate before returning card details', async () => {
    const calls: Call[] = [];
    let approved = false;
    const provider = new AgentCardUserMcpProvider(
      'user-details-approval',
      async (userId, name, args) => {
        calls.push({ userId, name, args });
        if (name === 'get_card_details') {
          return approved
            ? toolResult({
                pan: '4111111111111111',
                cvv: '456',
                expiry: '02/32',
                balance_cents: 4396,
                status: 'ACTIVE',
              })
            : toolResult({ approval_required: true, approval_id: 'approval-details-1' });
        }
        if (name === 'approve_request') {
          approved = true;
          return toolResult({ approved: true });
        }
        throw new Error(`unexpected tool ${name}`);
      }
    );

    const details = await provider.getDetails('card-needs-approval');

    assert.strictEqual(details.pan, '4111111111111111');
    assert.strictEqual(details.cvv, '456');
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-details-approval', 'get_card_details', { card_id: 'card-needs-approval' }],
        ['user-details-approval', 'approve_request', { approval_id: 'approval-details-1' }],
        ['user-details-approval', 'get_card_details', { card_id: 'card-needs-approval' }],
      ]
    );
  });

  await test('parses live AgentCard details text when structured content omits secrets', async () => {
    const provider = new AgentCardUserMcpProvider('user-live-shape', async (_userId, name) => {
      if (name === 'get_card_details') {
        return {
          content: [
            {
              type: 'text',
              text:
                'Card ID: card-live\n' +
                'PAN: 4111111111111111\n' +
                'CVV: 508\n' +
                'Expiry: 07/28\n' +
                'Balance: $43.96\n' +
                'Status: OPEN',
            },
          ],
          structuredContent: {
            message:
              'Card ID: card-live\n' +
              'PAN: 4111111111111111\n' +
              'CVV: 508\n' +
              'Expiry: 07/28\n' +
              'Balance: $43.96\n' +
              'Status: OPEN',
            status: 'details',
            cardId: 'card-live',
            expiry: '07/28',
            last4: '1111',
            balanceCents: 4396,
            balanceDollars: '43.96',
            cardStatus: 'OPEN',
          },
        };
      }
      throw new Error(`unexpected tool ${name}`);
    });

    const details = await provider.getDetails('card-live');

    assert.deepStrictEqual(details, {
      pan: '4111111111111111',
      cvv: '508',
      expiry: '07/28',
      balanceCents: 4396,
      status: 'OPEN',
    });
  });

  await test('starts KYC automatically when card creation reports kyc_required', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider('user-kyc', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'create_card') {
        return toolResult({ status: 'kyc_required', message: 'KYC needed' });
      }
      if (name === 'start_kyc') {
        return toolResult({
          status: 'started',
          url: 'https://identity.agentcard.test/session-1',
          session_id: 'ivs-1',
        });
      }
      throw new Error(`unexpected tool ${name}`);
    });

    await assert.rejects(
      () => provider.mintCard({ amountCents: 2500 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'start_kyc' &&
        (err as { details: Record<string, unknown> }).details.setupUrl ===
          'https://identity.agentcard.test/session-1'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-kyc', 'create_card', { amount_cents: 2500 }],
        ['user-kyc', 'start_kyc', {}],
      ]
    );
  });

  await test('starts wallet funding automatically when card creation reports wallet funding required', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider('user-wallet', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'create_card') {
        return toolResult({ error: 'wallet_funding_required', message: 'Fund wallet' });
      }
      if (name === 'get_wallet') {
        return toolResult({ wallet: { address: '0xabc', balanceUsdc: '0.00' } });
      }
      if (name === 'fund_wallet') {
        return toolResult({
          session: { id: 'onr-1', status: 'pending' },
          payment: { checkoutUrl: 'https://pay.coinbase.test/onr-1' },
        });
      }
      throw new Error(`unexpected tool ${name}`);
    });

    await assert.rejects(
      () => provider.mintCard({ amountCents: 4396 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'fund_wallet' &&
        (err as { details: Record<string, unknown> }).details.checkoutUrl ===
          'https://pay.coinbase.test/onr-1'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-wallet', 'create_card', { amount_cents: 4396 }],
        ['user-wallet', 'get_wallet', {}],
        ['user-wallet', 'fund_wallet', { amount_cents: 4396, payment_method: 'apple_pay' }],
      ]
    );
  });

  await test('maps live text wallet funding response to setup required', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider('user-wallet-text', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'create_card') {
        return {
          content: [
            {
              type: 'text',
              text:
                'Your wallet needs $43.96 more USDC to create this card. ' +
                'Fund it with the fund_wallet tool (debit card or Apple Pay) or send USDC directly.',
            },
          ],
        };
      }
      if (name === 'get_wallet') {
        return toolResult({ wallet: { address: '0xabc', balanceUsdc: '0.00' } });
      }
      if (name === 'fund_wallet') {
        return {
          content: [
            {
              type: 'text',
              text: 'Funding requires email verification and an Apple Pay checkout.',
            },
          ],
        };
      }
      throw new Error(`unexpected tool ${name}`);
    });

    await assert.rejects(
      () => provider.mintCard({ amountCents: 4396 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.agentcardStatus ===
          'wallet_funding_required' &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'fund_wallet' &&
        String((err as { details: Record<string, unknown> }).details.setupMessage).includes(
          'Funding requires email verification'
        )
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-wallet-text', 'create_card', { amount_cents: 4396 }],
        ['user-wallet-text', 'get_wallet', {}],
        ['user-wallet-text', 'fund_wallet', { amount_cents: 4396, payment_method: 'apple_pay' }],
      ]
    );
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }

  console.log(`\n✅ ${passed} AgentCard per-user MCP provider tests passed`);
}

void main();
