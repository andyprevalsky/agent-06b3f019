#!/usr/bin/env tsx

import assert from 'node:assert';

const report = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const reportError = (message: string): void => {
  process.stderr.write(`${message}\n`);
};
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
    report(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    report(`  ❌ ${name}`);
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

  await test('current approval_pending waits for user passkey without impersonating approval', async () => {
    const calls: string[] = [];
    const provider = new AgentCardUserMcpProvider('user-passkey', async (_userId, name) => {
      calls.push(name);
      return toolResult({
        status: 'approval_pending',
        approvalUrl: 'https://agentcard.sh/approve/example',
        approvalId: 'approval-example',
      });
    });
    await assert.rejects(
      provider.mintCard({ amountCents: 2500 }),
      (error: unknown) =>
        error instanceof Error &&
        'details' in error &&
        (error as { details: Record<string, unknown> }).details.setupUrl ===
          'https://agentcard.sh/approve/example'
    );
    assert.deepStrictEqual(calls, ['create_card']);
  });

  await test('current vault_started result returns the user link instead of claiming a card was minted', async () => {
    const provider = new AgentCardUserMcpProvider('user-vault', async () =>
      toolResult({
        status: 'vault_started',
        vaultUrl: 'https://agentcard.sh/vault/example',
      })
    );
    await assert.rejects(
      provider.mintCard({ amountCents: 2500 }),
      (error: unknown) =>
        error instanceof Error &&
        'details' in error &&
        (error as { details: Record<string, unknown> }).details.setupUrl ===
          'https://agentcard.sh/vault/example'
    );
  });

  await test('mints a ready card through per-user MCP', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider('user-123', async (userId, name, args) => {
      calls.push({ userId, name, args });
      if (name === 'create_card') {
        return toolResult({ card_id: 'card-123', status: 'created' });
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
      pan: '4242424242424242',
      cvv: '123',
      balanceCents: 2500,
    });
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
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

  await test('card details approval stays with the user', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider(
      'user-details-approval',
      async (userId, name, args) => {
        calls.push({ userId, name, args });
        if (name === 'get_card_details') {
          return toolResult({ status: 'approval_required', approvalId: 'approval-details-1' });
        }
        throw new Error(`unexpected tool ${name}`);
      }
    );

    await assert.rejects(
      provider.getDetails('card-needs-approval'),
      (error: unknown) =>
        error instanceof Error &&
        'details' in error &&
        (error as { details: Record<string, unknown> }).details.approvalId === 'approval-details-1'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [['user-details-approval', 'get_card_details', { card_id: 'card-needs-approval' }]]
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
      if (name === 'add_funds') {
        return toolResult({
          checkoutUrl: 'https://pay.coinbase.test/onr-1',
        });
      }
      throw new Error(`unexpected tool ${name}`);
    });

    await assert.rejects(
      () => provider.mintCard({ amountCents: 4396 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'add_funds' &&
        (err as { details: Record<string, unknown> }).details.setupUrl ===
          'https://pay.coinbase.test/onr-1'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-wallet', 'create_card', { amount_cents: 4396 }],
        ['user-wallet', 'add_funds', { amount_cents: 4396 }],
      ]
    );
  });

  await test('passes the requested amount through an MCP error before starting wallet funding', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider(
      'user-wallet-error',
      async (userId, name, args) => {
        calls.push({ userId, name, args });
        if (name === 'create_card') {
          const payload = { code: 'issuing_balance_insufficient' };
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
          };
        }
        if (name === 'add_funds') {
          return toolResult({ checkoutUrl: 'https://pay.coinbase.test/onr-error' });
        }
        throw new Error(`unexpected tool ${name}`);
      }
    );

    await assert.rejects(
      () => provider.mintCard({ amountCents: 4396 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.setupUrl ===
          'https://pay.coinbase.test/onr-error'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-wallet-error', 'create_card', { amount_cents: 4396 }],
        ['user-wallet-error', 'add_funds', { amount_cents: 4396 }],
      ]
    );
  });

  await test('reports required funding without invoking add_funds when no amount is known', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider(
      'user-details-error',
      async (userId, name, args) => {
        calls.push({ userId, name, args });
        const payload = { code: 'wallet_funding_required' };
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
    );

    await assert.rejects(
      () => provider.getDetails('card-needs-funds'),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.agentcardStatus ===
          'wallet_funding_required' &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'add_funds'
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [['user-details-error', 'get_card_details', { card_id: 'card-needs-funds' }]]
    );
  });

  await test('maps live text wallet funding response to setup required', async () => {
    const calls: Call[] = [];
    const provider = new AgentCardUserMcpProvider(
      'user-wallet-text',
      async (userId, name, args) => {
        calls.push({ userId, name, args });
        if (name === 'create_card') {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Your wallet needs $43.96 more USDC to create this card. ' +
                  'Fund it with the add_funds tool (Apple Pay) or send USDC directly.',
              },
            ],
          };
        }
        if (name === 'add_funds') {
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
      }
    );

    await assert.rejects(
      () => provider.mintCard({ amountCents: 4396 }),
      (err: unknown) =>
        err instanceof Error &&
        'details' in err &&
        (err as { details: Record<string, unknown> }).details.agentcardStatus ===
          'wallet_funding_required' &&
        (err as { details: Record<string, unknown> }).details.setupTool === 'add_funds' &&
        String((err as { details: Record<string, unknown> }).details.setupMessage).includes(
          'Funding requires email verification'
        )
    );
    assert.deepStrictEqual(
      calls.map((call) => [call.userId, call.name, call.args]),
      [
        ['user-wallet-text', 'create_card', { amount_cents: 4396 }],
        ['user-wallet-text', 'add_funds', { amount_cents: 4396 }],
      ]
    );
  });

  await test('prefers get_card_details status over stale create_card status', async () => {
    const provider = new AgentCardUserMcpProvider('user-stale-status', async (_userId, name) => {
      if (name === 'create_card') {
        // Incomplete create payload forces getDetails; status here is stale.
        return toolResult({ card_id: 'card-stale', status: 'ACTIVE' });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4111111111111111',
          cvv: '999',
          expiry: '12/30',
          balance_cents: 1000,
          status: 'CLOSED',
        });
      }
      throw new Error(`unexpected tool ${name}`);
    });

    const minted = await provider.mintCard({ amountCents: 1000, idempotencyKey: 'idem-stale' });
    assert.strictEqual(minted.status, 'CLOSED');
    assert.strictEqual(minted.pan, '4111111111111111');
  });

  if (failures.length > 0) {
    reportError(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }

  report(`\n✅ ${passed} AgentCard per-user MCP provider tests passed`);
}

void main();
