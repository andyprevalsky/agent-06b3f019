#!/usr/bin/env tsx
/**
 * Claude grant-independence probe.
 *
 * THE QUESTION
 * ------------
 * Our whole cloud-token design rests on one claim: `claude setup-token` mints an
 * INDEPENDENT grant that is not invalidated when another authorization happens on
 * the same account. If that claim is false, a cloud-held token dies every time the
 * user logs in anywhere, and the redesign is worthless.
 *
 * WHY SOURCE CODE IS NOT ENOUGH
 * -----------------------------
 * Reading claude-code's source proves only that the CLIENT does not delete
 * anything locally on the setup-token path (that branch never calls
 * performLogout() and never writes the keychain). It says NOTHING about whether
 * Anthropic's SERVER revokes sibling grants -- which is the actual question. There
 * is no API that enumerates grants, so the only way to know is to mint two and
 * observe. This probe does exactly that, and records the answer.
 *
 * WHAT IT PROVES
 * --------------
 *   1. a setup-token authenticates for inference at all;
 *   2. minting it does NOT kill the interactive /login session token;
 *   3. minting a SECOND setup-token does NOT kill the first;
 *   4. ... nor the /login session token.
 *
 * (2)-(4) together are the "a new auth does not invalidate other tokens" claim.
 *
 * NON-DESTRUCTIVE: unlike mac-app's sync path, this NEVER writes the keychain, so
 * your active login is untouched. It opens a browser twice for authorization.
 *
 *   npx tsx scripts/claude-grant-independence-probe.ts
 *
 * NOTE ON THE 1-YEAR TTL: this probe cannot verify it. `expires_in: 31536000` is
 * requested BY THE CLIENT and the server may cap it; sk-ant-oat tokens are opaque
 * with no readable exp. Only a long-running canary re-checking a parked
 * setup-token over months can confirm the lifetime actually granted.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const LEDGER = join(dirname(new URL(import.meta.url).pathname), '.claude-grant-independence.jsonl');
const UA = 'claude-cli/2.1.88 (external, cli)';

/** Probe a token against the real inference API. 401 => dead, anything else => alive. */
async function tokenAlive(accessToken: string): Promise<{ alive: boolean; detail: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const text = await res.text();
  return { alive: res.status !== 401, detail: `HTTP ${res.status} ${text.slice(0, 120)}` };
}

/** Read the CURRENT interactive-login access token without modifying it. */
function readSessionAccessToken(): string | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `claude setup-token` and capture the minted token from stdout.
 * Deliberately does NOT persist it anywhere -- the caller decides.
 */
function mintSetupToken(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`\n  [${label}] running \`claude setup-token\` -- authorize in the browser...`);
    const proc = spawn('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const timer = setTimeout(
      () => {
        proc.kill();
        reject(new Error('setup-token timed out after 5 minutes'));
      },
      5 * 60 * 1000
    );
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`setup-token exited ${code}: ${err.slice(0, 200)}`));
        return;
      }
      const m = /(sk-ant-oat[A-Za-z0-9_-]+)/.exec(out);
      if (m === null) {
        reject(new Error('could not parse a token from setup-token output'));
        return;
      }
      resolve(m[1]);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function record(entry: Record<string, unknown>): void {
  writeFileSync(LEDGER, `${JSON.stringify({ iso: new Date().toISOString(), ...entry })}\n`, {
    flag: 'a',
    mode: 0o600,
  });
}

async function main() {
  const results: Array<{ check: string; pass: boolean; detail: string }> = [];
  const expect = async (check: string, token: string, wantAlive: boolean) => {
    const { alive, detail } = await tokenAlive(token);
    const pass = alive === wantAlive;
    results.push({ check, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${check}  (${detail})`);
    return alive;
  };

  const checkOnly = process.argv.includes('--check');
  console.log('\nClaude grant-independence probe');
  console.log(
    checkOnly
      ? 'CHECK MODE: validating plumbing only -- no browser, no tokens minted.\n'
      : 'This opens a browser TWICE. It never writes your keychain.\n'
  );

  const session = readSessionAccessToken();
  if (session === null) {
    console.error('Could not read the current login from the keychain. Is Claude Code logged in?');
    process.exit(1);
  }
  await expect('baseline: interactive /login session token is alive', session, true);

  if (checkOnly) {
    const claudeOnPath = (() => {
      try {
        execFileSync('claude', ['--version'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();
    results.push({
      check: '`claude` CLI is on PATH (required to mint setup-tokens)',
      pass: claudeOnPath,
      detail: claudeOnPath ? 'found' : 'NOT FOUND',
    });
    console.log(
      `  ${claudeOnPath ? 'PASS' : 'FAIL'}  \`claude\` CLI is on PATH (required to mint setup-tokens)`
    );
    const bad = results.filter((r) => !r.pass);
    console.log(`\nCHECK: ${results.length - bad.length}/${results.length} passed`);
    console.log('Plumbing OK -- re-run without --check to perform the real probe.');
    process.exit(bad.length === 0 ? 0 : 1);
  }

  // --- first independent grant -------------------------------------------------
  const s1 = await mintSetupToken('S1');
  await expect('S1 (setup-token) authenticates for inference', s1, true);
  await expect(
    'minting S1 did NOT revoke the /login session token',
    readSessionAccessToken() ?? session,
    true
  );

  // --- second authorization event ---------------------------------------------
  // This is the crux: a brand-new authorization on the SAME account.
  const s2 = await mintSetupToken('S2');
  await expect('S2 authenticates for inference', s2, true);
  await expect('THE CRUX: minting S2 did NOT revoke S1', s1, true);
  await expect(
    'minting S2 did NOT revoke the /login session token',
    readSessionAccessToken() ?? session,
    true
  );

  const failed = results.filter((r) => !r.pass);
  record({
    kind: 'probe',
    results,
    verdict: failed.length === 0 ? 'independent' : 'NOT_independent',
  });

  console.log(`\nRESULTS: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length === 0) {
    console.log(
      '\nVERDICT: grants are INDEPENDENT. A new authorization does not invalidate\n' +
        'existing ones, so a cloud-held setup-token can coexist with the user logging\n' +
        'in anywhere else. The redesign rests on solid ground.\n\n' +
        'STILL UNVERIFIED: the actual granted lifetime (the 1-year figure is what the\n' +
        'client REQUESTS, not necessarily what the server grants). Park S1 and re-check\n' +
        'it periodically to confirm.'
    );
    console.log(`\nPark this token to track its real lifetime:\n  ${s1}`);
  } else {
    console.log(
      '\nVERDICT: grants are NOT independent -- a new authorization revoked something.\n' +
        'The cloud-token redesign CANNOT rely on setup-token surviving user logins.\n' +
        'Failed checks:'
    );
    for (const f of failed) console.log(`  - ${f.check}: ${f.detail}`);
    process.exit(1);
  }
}

if (existsSync(LEDGER)) {
  const prior = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean);
  if (prior.length > 0) {
    const last = JSON.parse(prior[prior.length - 1]) as { iso?: string; verdict?: string };
    console.log(`(prior run ${last.iso ?? '?'} -> ${last.verdict ?? '?'})`);
  }
}

void main();
