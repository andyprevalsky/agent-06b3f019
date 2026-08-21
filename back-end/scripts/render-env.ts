#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Read Render production env vars — CORRECTLY PAGINATED.
 *
 * Why this script exists: the Render API caps `/env-vars` at 100 rows per page and returns a
 * cursor on the last row. The one-liner previously documented in CLAUDE.md used `?limit=100` with
 * no pagination, so once the service passed 100 vars it silently dropped the rest. On 2026-08-05
 * that made `AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS` read as "not set in prod" when it was in fact
 * present — the service had 117 vars. A missing var and a truncated page look identical, which is
 * the dangerous part: you conclude a credential is absent and go set it, or worse, conclude a
 * deploy is misconfigured when it is fine.
 *
 * Usage:
 *   npx tsx scripts/render-env.ts                 # all keys (values masked)
 *   npx tsx scripts/render-env.ts --show          # include values
 *   npx tsx scripts/render-env.ts KEY [KEY...]    # specific keys, exact values
 *   npx tsx scripts/render-env.ts --json          # machine readable
 *
 * Reads RENDER_API_KEY / RENDER_SERVICE_ID from back-end/.env.
 */

import 'dotenv/config';

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

interface RenderEnvRow {
  envVar?: { key?: string; value?: string };
  cursor?: string;
}

async function fetchAllEnvVars(apiKey: string, serviceId: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url =
      `https://api.render.com/v1/services/${serviceId}/env-vars?limit=${PAGE_SIZE}` +
      (cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      throw new Error(`Render env-vars ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as RenderEnvRow[];
    const rows = Array.isArray(body) ? body.filter((row) => row.envVar?.key !== undefined) : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      values.set(row.envVar?.key as string, row.envVar?.value ?? '');
    }
    cursor = rows[rows.length - 1].cursor;
    // A short page is the last page. Without this we would keep requesting with a stale cursor.
    if (rows.length < PAGE_SIZE || cursor === undefined) break;
    if (page === MAX_PAGES - 1) {
      throw new Error(
        `Stopped after ${MAX_PAGES} pages with a cursor still present — refusing to report a ` +
          `partial env list as complete.`
      );
    }
  }
  return values;
}

function mask(value: string): string {
  if (value === '') return '';
  return value.length <= 8 ? '***' : `${value.slice(0, 6)}…(${value.length} chars)`;
}

async function main(): Promise<void> {
  const apiKey = process.env.RENDER_API_KEY?.trim();
  const serviceId = process.env.RENDER_SERVICE_ID?.trim();
  if (!apiKey || !serviceId) {
    console.error('RENDER_API_KEY and RENDER_SERVICE_ID must be set (back-end/.env)');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const show = args.includes('--show');
  const requested = args.filter((arg) => !arg.startsWith('--'));

  const values = await fetchAllEnvVars(apiKey, serviceId);

  if (asJson) {
    console.log(JSON.stringify(Object.fromEntries(values), null, 2));
    return;
  }

  if (requested.length > 0) {
    for (const key of requested) {
      const value = values.get(key);
      console.log(`${key} = ${value === undefined ? '*** NOT SET ***' : value}`);
    }
    return;
  }

  console.log(`${values.size} env var(s) on ${serviceId}\n`);
  for (const key of [...values.keys()].sort()) {
    console.log(`  ${key} = ${show ? values.get(key) : mask(values.get(key) as string)}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
