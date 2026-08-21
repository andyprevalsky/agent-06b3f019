#!/usr/bin/env tsx
/**
 * Codex refresh-lineage aging canary.
 *
 * THE QUESTION THIS ANSWERS
 * -------------------------
 * Codex refresh tokens rotate, but an OLD refresh token keeps working -- verified
 * across minutes, and verified to survive its child advancing a generation. What
 * we CANNOT observe in a single test run is whether an old token dies after some
 * grace window measured in hours or days. Operators running Codex at scale report
 * forked lineages dying, and `refresh_token_reused` is a first-class server error
 * code, so we must not assume survival.
 *
 * A test that finishes in seconds structurally cannot answer a question about
 * days. So this canary inverts it: `park` a token now, `check` it much later. The
 * ledger accumulates the answer over calendar time without anyone waiting.
 *
 *   npx tsx scripts/codex-lineage-canary.ts park    # fork a token, record it
 *   npx tsx scripts/codex-lineage-canary.ts check   # re-test every parked token
 *
 * Run `check` on a schedule (daily). Each parked token is re-tested
 * NON-DESTRUCTIVELY for as long as it lives; the first failure records the age at
 * which the grace window closed -- which is the number production needs.
 *
 * Until this reports survival over weeks, production MUST give every surface its
 * own grant rather than forking the user's lineage.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const LEDGER = join(dirname(new URL(import.meta.url).pathname), '.codex-lineage-canary.jsonl');

interface ParkedToken {
  /** Opaque handle for logs; never log the token itself. */
  id: string;
  refreshToken: string;
  parkedAtMs: number;
}

interface Observation {
  id: string;
  observedAtMs: number;
  ageHours: number;
  alive: boolean;
  errorCode?: string;
}

async function refresh(
  refreshToken: string
): Promise<{ ok: true; refreshToken: string } | { ok: false; code: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    const m = /"code"\s*:\s*"([^"]+)"/.exec(text);
    return { ok: false, code: m?.[1] ?? `http_${res.status}` };
  }
  const body = (await res.json()) as { refresh_token: string };
  return { ok: true, refreshToken: body.refresh_token };
}

function appendLedger(entry: Record<string, unknown>): void {
  writeFileSync(LEDGER, `${JSON.stringify(entry)}\n`, { flag: 'a', mode: 0o600 });
}

function readParked(): ParkedToken[] {
  if (!existsSync(LEDGER)) return [];
  const parked = new Map<string, ParkedToken>();
  const dead = new Set<string>();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.kind === 'park') {
      parked.set(row.id as string, {
        id: row.id as string,
        refreshToken: row.refreshToken as string,
        parkedAtMs: row.parkedAtMs as number,
      });
    }
    // Once a token is observed dead there is nothing further to learn from it.
    if (row.kind === 'observe' && row.alive === false) dead.add(row.id as string);
  }
  return [...parked.values()].filter((p) => !dead.has(p.id));
}

async function park(seedRefreshToken: string): Promise<void> {
  // Fork a NEW lineage off the seed rather than parking the seed itself, so the
  // canary never competes with the live credential it was seeded from.
  const forked = await refresh(seedRefreshToken);
  if (!forked.ok) {
    console.error(`park failed: seed token rejected (${forked.code})`);
    process.exit(1);
  }
  const id = `cx-${Date.now().toString(36)}`;
  appendLedger({
    kind: 'park',
    id,
    refreshToken: forked.refreshToken,
    parkedAtMs: Date.now(),
    iso: new Date().toISOString(),
  });
  console.log(`parked ${id} -- re-test it later with: codex-lineage-canary.ts check`);
}

async function check(): Promise<void> {
  const parked = readParked();
  if (parked.length === 0) {
    console.log('no live parked tokens; run `park` first');
    return;
  }
  const observations: Observation[] = [];
  for (const p of parked) {
    const ageHours = (Date.now() - p.parkedAtMs) / 3_600_000;
    const res = await refresh(p.refreshToken);
    const obs: Observation = {
      id: p.id,
      observedAtMs: Date.now(),
      ageHours,
      alive: res.ok,
      errorCode: res.ok ? undefined : res.code,
    };
    observations.push(obs);
    appendLedger({ kind: 'observe', iso: new Date().toISOString(), ...obs });
    console.log(
      res.ok
        ? `  ALIVE  ${p.id}  age ${ageHours.toFixed(1)}h`
        : `  DEAD   ${p.id}  age ${ageHours.toFixed(1)}h  (${res.code})`
    );
  }

  const dead = observations.filter((o) => !o.alive);
  if (dead.length > 0) {
    const youngest = Math.min(...dead.map((o) => o.ageHours));
    console.log(
      `\nGRACE WINDOW CLOSED: an old refresh token died at ~${youngest.toFixed(1)}h.\n` +
        'Forking a lineage is therefore NOT durable. Production must give every\n' +
        'surface its own grant. Update assertCodexSemantics RULE 3 accordingly.'
    );
    process.exit(1);
  }
  const oldest = Math.max(...observations.map((o) => o.ageHours));
  console.log(`\nall parked lineages alive; longest survival so far ${oldest.toFixed(1)}h`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'park') {
    const seed =
      process.env.CONFORMANCE_CODEX_REFRESH_TOKEN ??
      (() => {
        const p = `${process.env.HOME}/.codex/auth.json`;
        if (!existsSync(p)) return '';
        return (
          (JSON.parse(readFileSync(p, 'utf8')) as { tokens?: { refresh_token?: string } }).tokens
            ?.refresh_token ?? ''
        );
      })();
    if (seed === '') {
      console.error('no seed refresh token (set CONFORMANCE_CODEX_REFRESH_TOKEN)');
      process.exit(1);
    }
    await park(seed);
    return;
  }
  if (cmd === 'check') {
    await check();
    return;
  }
  console.error('usage: codex-lineage-canary.ts <park|check>');
  process.exit(1);
}

void main();
