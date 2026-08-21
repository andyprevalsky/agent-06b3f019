#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the two treasury transfer clients that actually move money:
 * Brex (USD wire) and Coinbase (USDC send).
 *
 * These cover the refusal and failure paths rather than the happy path, because those are the ones
 * that decide whether money moves to the WRONG place or moves TWICE:
 *
 *  - Brex refuses to send on a mismatched rail. A DOMESTIC_WIRE instrument fed an ACH transfer can
 *    bounce or land unattributed, and the counterparty is a bank account we cannot claw back from.
 *  - Coinbase rejects any non-UUID `idem`. This was caught live: the first real send died on
 *    `Invalid input parameter. Param: Idem` because the key was prefixed, which would have broken
 *    EVERY automated top-up at the final step. It is validated locally so it can never regress.
 *  - Both clients must report `possiblySent` truthfully. A POST that fails in transport or with a
 *    5xx may already have moved money; treating it as a clean failure invites a double-send.
 */

import assert from 'node:assert';
import {
  createBrexTreasury,
  railsAreCompatible,
  type BrexConfig,
} from '../../providers/brex/treasury';
import {
  centsToDecimal,
  createCoinbaseTreasury,
  decimalToCents,
  CoinbaseTreasuryError,
} from '../../providers/coinbase/treasury';

const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Swap global fetch for a scripted responder, restoring it even when the test throws. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const BREX_CONFIG: BrexConfig = {
  apiToken: 'bxt_test',
  baseUrl: 'https://platform.brexapis.com',
  processingType: 'WIRE',
  coinbaseCounterpartyId: 'bkcp_test',
};

const CASH_ACCOUNTS = {
  items: [
    {
      id: 'dpacc_primary',
      name: 'Primary checking',
      status: 'ACTIVE',
      available_balance: { amount: 100_000 },
      current_balance: { amount: 100_000 },
    },
    {
      id: 'dpacc_idle',
      name: 'Vault',
      status: 'ACTIVE',
      available_balance: { amount: 0 },
      current_balance: { amount: 0 },
    },
  ],
};

const vendorsWith = (type: string): unknown => ({
  items: [{ payment_accounts: [{ details: { type, payment_instrument_id: 'bkcp_test' } }] }],
});

async function testBrexRailGuards(): Promise<void> {
  console.log('\nBrex rail guards');

  await check('WIRE transfer through a DOMESTIC_WIRE instrument is allowed', () => {
    assert.strictEqual(railsAreCompatible('DOMESTIC_WIRE', 'WIRE'), true);
    assert.strictEqual(railsAreCompatible('INTERNATIONAL_WIRE', 'WIRE'), true);
    assert.strictEqual(railsAreCompatible('SAME_DAY_ACH', 'ACH'), true);
    assert.strictEqual(railsAreCompatible('ACH', 'ACH'), true);
  });

  await check('ACH instrument rejects a WIRE transfer and vice versa', () => {
    assert.strictEqual(railsAreCompatible('ACH', 'WIRE'), false);
    assert.strictEqual(railsAreCompatible('DOMESTIC_WIRE', 'ACH'), false);
  });

  await check('transferToCoinbase refuses when the instrument rail does not match', async () => {
    await withFetch(
      (url) => (url.includes('/v1/vendors') ? json(vendorsWith('ACH')) : json(CASH_ACCOUNTS)),
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG); // processingType WIRE vs ACH instrument
        await assert.rejects(
          () =>
            brex.transferToCoinbase({
              cents: 1000,
              idempotencyKey: 'key-1',
              description: 'test',
            }),
          (error: unknown) =>
            error instanceof Error && /refusing to send on a mismatched rail/i.test(error.message)
        );
      }
    );
  });

  await check(
    'transferToCoinbase refuses when the counterparty matches no instrument',
    async () => {
      await withFetch(
        (url) => (url.includes('/v1/vendors') ? json({ items: [] }) : json(CASH_ACCOUNTS)),
        async () => {
          const brex = createBrexTreasury(BREX_CONFIG);
          await assert.rejects(
            () =>
              brex.transferToCoinbase({ cents: 1000, idempotencyKey: 'k', description: 'test' }),
            (error: unknown) =>
              error instanceof Error && /matches no Brex payment instrument/i.test(error.message)
          );
        }
      );
    }
  );

  await check('transferToCoinbase refuses a non-positive amount', async () => {
    await withFetch(
      () => json(CASH_ACCOUNTS),
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG);
        await assert.rejects(
          () => brex.transferToCoinbase({ cents: 0, idempotencyKey: 'k', description: 't' }),
          (error: unknown) => error instanceof Error && /positive integer/i.test(error.message)
        );
      }
    );
  });

  await check('transferToCoinbase refuses when no account has enough available', async () => {
    await withFetch(
      (url) =>
        url.includes('/v1/vendors') ? json(vendorsWith('DOMESTIC_WIRE')) : json(CASH_ACCOUNTS),
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG);
        await assert.rejects(
          () =>
            brex.transferToCoinbase({
              cents: 999_999_99,
              idempotencyKey: 'k',
              description: 't',
            }),
          (error: unknown) => error instanceof Error && /available/i.test(error.message)
        );
      }
    );
  });

  await check('getAvailableCents sums only ACTIVE accounts and never goes negative', async () => {
    await withFetch(
      () =>
        json({
          items: [
            ...CASH_ACCOUNTS.items,
            {
              id: 'dpacc_closed',
              name: 'Closed',
              status: 'CLOSED',
              available_balance: { amount: 500_000 },
              current_balance: { amount: 500_000 },
            },
            {
              id: 'dpacc_negative',
              name: 'Overdrawn',
              status: 'ACTIVE',
              available_balance: { amount: -5_000 },
              current_balance: { amount: -5_000 },
            },
          ],
        }),
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG);
        // 100_000 (primary) + 0 (vault) + 0 (clamped overdraft); CLOSED account excluded.
        assert.strictEqual(await brex.getAvailableCents(), 100_000);
      }
    );
  });

  await check('a POST transport failure is flagged as possibly sent', async () => {
    await withFetch(
      (url, init) => {
        if (url.includes('/v1/vendors')) return json(vendorsWith('DOMESTIC_WIRE'));
        if ((init?.method ?? 'GET') === 'POST') throw new Error('socket hang up');
        return json(CASH_ACCOUNTS);
      },
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG);
        await assert.rejects(
          () => brex.transferToCoinbase({ cents: 1000, idempotencyKey: 'k', description: 't' }),
          (error: unknown) =>
            error instanceof Error &&
            (error as { possiblySent?: boolean }).possiblySent === true &&
            /socket hang up/.test(error.message)
        );
      }
    );
  });

  await check('a successful wire returns the Brex transfer id', async () => {
    await withFetch(
      (url, init) => {
        if (url.includes('/v1/vendors')) return json(vendorsWith('DOMESTIC_WIRE'));
        if ((init?.method ?? 'GET') === 'POST') return json({ id: 'dptx_ok' });
        return json(CASH_ACCOUNTS);
      },
      async () => {
        const brex = createBrexTreasury(BREX_CONFIG);
        const result = await brex.transferToCoinbase({
          cents: 1000,
          idempotencyKey: 'k',
          description: 'Rose treasury float replenish',
        });
        assert.strictEqual(result.transferId, 'dptx_ok');
      }
    );
  });
}

const COINBASE_CONFIG = {
  // A syntactically valid Ed25519 key so JWT signing succeeds without network access.
  apiKeyId: 'organizations/test/apiKeys/test',
  apiKeySecret: Buffer.from(new Uint8Array(64)).toString('base64'),
  network: 'base' as const,
};

const USDC_ACCOUNTS = {
  data: [{ id: 'acct_usdc', currency: { code: 'USDC' }, balance: { amount: '500.00' } }],
};

async function testCoinbaseGuards(): Promise<void> {
  console.log('\nCoinbase transfer guards');

  await check('decimalToCents is exact where float math is not', () => {
    // parseFloat('0.29') * 100 === 28.999999999999996, which floors to 28.
    assert.strictEqual(decimalToCents('0.29'), 29);
    assert.strictEqual(decimalToCents('123.456789'), 12_345);
    assert.strictEqual(decimalToCents('0'), 0);
    assert.strictEqual(decimalToCents('-1.50'), -150);
  });

  await check('decimalToCents rejects an unparseable amount', () => {
    assert.throws(() => decimalToCents('not-a-number'), CoinbaseTreasuryError);
  });

  await check('centsToDecimal round-trips through decimalToCents', () => {
    for (const cents of [0, 1, 99, 100, 12_345, 159_12]) {
      assert.strictEqual(decimalToCents(centsToDecimal(cents)), cents);
    }
    assert.strictEqual(centsToDecimal(159_12), '159.12');
  });

  await check('transferUsdcCents rejects a non-UUID idempotency key', async () => {
    const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
    await assert.rejects(
      () =>
        treasury.transferUsdcCents({
          toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
          cents: 100,
          // The exact shape that failed live against Coinbase.
          idempotencyKey: 'rose-topup:3eb69a9d-2eb8-3d53-f978-963f00000000',
        }),
      (error: unknown) =>
        error instanceof CoinbaseTreasuryError &&
        error.code === 'coinbase_treasury_bad_idempotency_key'
    );
  });

  await check('transferUsdcCents rejects a send below the 1 USDC minimum', async () => {
    const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
    await assert.rejects(
      () =>
        treasury.transferUsdcCents({
          toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
          cents: 99,
          idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
        }),
      (error: unknown) =>
        error instanceof CoinbaseTreasuryError && error.code === 'coinbase_treasury_below_minimum'
    );
  });

  await check('transferUsdcCents refuses a malformed destination address', async () => {
    const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
    await assert.rejects(
      () =>
        treasury.transferUsdcCents({
          toAddress: '0xnot-an-address',
          cents: 100,
          idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
        }),
      (error: unknown) =>
        error instanceof CoinbaseTreasuryError && error.code === 'coinbase_treasury_bad_address'
    );
  });

  await check('getUsdcBalanceCents reads the USDC wallet', async () => {
    await withFetch(
      () => json(USDC_ACCOUNTS),
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        assert.strictEqual(await treasury.getUsdcBalanceCents(), 50_000);
      }
    );
  });

  await check('a missing USDC wallet reads as zero, not an error', async () => {
    await withFetch(
      () => json({ data: [] }),
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        assert.strictEqual(await treasury.getUsdcBalanceCents(), 0);
      }
    );
  });

  await check('getUsdBalanceCents surfaces stranded, unconverted fiat', async () => {
    await withFetch(
      () =>
        json({
          data: [{ id: 'acct_usd', currency: { code: 'USD' }, balance: { amount: '490.03' } }],
        }),
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        assert.strictEqual(await treasury.getUsdBalanceCents(), 49_003);
      }
    );
  });

  await check('a send with no USDC wallet fails closed', async () => {
    await withFetch(
      () => json({ data: [] }),
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        await assert.rejects(
          () =>
            treasury.transferUsdcCents({
              toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
              cents: 100,
              idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
            }),
          (error: unknown) =>
            error instanceof CoinbaseTreasuryError &&
            error.code === 'coinbase_treasury_no_usdc_wallet'
        );
      }
    );
  });

  await check('a send returns the onchain hash when present, never the internal id', async () => {
    await withFetch(
      (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return json({ data: { id: 'accaf256-internal', network: { hash: '0xdeadbeef' } } });
        }
        return json(USDC_ACCOUNTS);
      },
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        const result = await treasury.transferUsdcCents({
          toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
          cents: 100,
          idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
        });
        assert.strictEqual(result.transactionHash, '0xdeadbeef');
        assert.strictEqual(result.onchainHash, '0xdeadbeef');
      }
    );
  });

  await check('a not-yet-broadcast send falls back to the transfer id with no hash', async () => {
    await withFetch(
      (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') return json({ data: { id: 'accaf256-internal' } });
        return json(USDC_ACCOUNTS);
      },
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        const result = await treasury.transferUsdcCents({
          toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
          cents: 100,
          idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
        });
        assert.strictEqual(result.transactionHash, 'accaf256-internal');
        // Must NOT claim an onchain hash it does not have: an explorer link built from the
        // internal id 404s and reads like a lost transfer.
        assert.strictEqual(result.onchainHash, undefined);
      }
    );
  });

  await check('a 5xx on send is surfaced as possibly sent', async () => {
    await withFetch(
      (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') return json({ message: 'upstream' }, 503);
        return json(USDC_ACCOUNTS);
      },
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        await assert.rejects(
          () =>
            treasury.transferUsdcCents({
              toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
              cents: 100,
              idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
            }),
          (error: unknown) => error instanceof CoinbaseTreasuryError && error.possiblySent === true
        );
      }
    );
  });

  await check('a send returning neither hash nor id fails as possibly sent', async () => {
    await withFetch(
      (url, init) => {
        if ((init?.method ?? 'GET') === 'POST') return json({ data: {} });
        return json(USDC_ACCOUNTS);
      },
      async () => {
        const treasury = createCoinbaseTreasury(COINBASE_CONFIG);
        await assert.rejects(
          () =>
            treasury.transferUsdcCents({
              toAddress: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
              cents: 100,
              idempotencyKey: '3eb69a9d-2eb8-3d53-f978-963f00000000',
            }),
          (error: unknown) =>
            error instanceof CoinbaseTreasuryError &&
            error.code === 'coinbase_treasury_no_tx_reference' &&
            error.possiblySent === true
        );
      }
    );
  });
}

async function main(): Promise<void> {
  console.log('Treasury transfer guards (Brex wire + Coinbase USDC send)');
  await testBrexRailGuards();
  await testCoinbaseGuards();
  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll treasury transfer guard tests passed.');
}

void main();
