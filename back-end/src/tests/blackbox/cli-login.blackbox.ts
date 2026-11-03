#!/usr/bin/env tsx
/**
 * Black-box tests for one-time CLI login codes ("Set up with your coding
 * agent", `rose agent-init --login-code`), over real HTTP + local Postgres.
 *
 *   POST /api/projects/cli-login-codes            mint (user session only)
 *   POST /api/projects/cli-login-codes/exchange   exchange once (no auth, rate-limited)
 *   Authorization: Bearer rose_cli_…              projects-scoped credential
 *
 * Invariants covered:
 *   - mint: user sessions only (no auth 401; API key / CLI credential 403);
 *     optional project binding must be the caller's own project (404)
 *   - exchange once: the first presentation returns a projects-scoped
 *     credential; reuse, malformed and unknown codes are 401
 *   - expiry: an expired code is rejected AND burned (no retry after the
 *     clock is fixed); an expired credential is 401
 *   - hashed at rest: no column holds the code or the credential
 *   - scope: the credential works only on /api/projects; a bound credential
 *     sees only its project (others 404, create / rename-upsert / delete 403);
 *     an unbound credential never reaches another user's project
 *   - rate limit: the 11th FAILED attempt from one address is 429 with
 *     Retry-After, before the code is looked up (the code still works from
 *     another address); successful exchanges never spend the quota
 *   - real CLI: `rose-sync agent-init --login-code` stores the credential 0600
 *     outside the repo, prints the agent steps without the secret, and a
 *     follow-up `push` syncs through the saved credential
 *
 * Usage: bash scripts/run-blackbox-tests.sh cli-login
 */
// First import: refuses a non-local DATABASE_URL before any module can query.
import {
  BASE_URL,
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';
import { createHash, randomBytes } from 'crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import { ExchangeRateLimiter } from '../../domains/projects/cliLoginService';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ROSE_SYNC = join(REPO_ROOT, 'scripts', 'rose-sync');
const scratch = mkdtempSync(join(tmpdir(), 'rose-cli-login-'));

after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await prisma.$disconnect();
});

interface Minted {
  code: string;
  expiresAt: string;
  project: { id: string; name: string } | null;
}

interface Exchanged {
  credential: string;
  expiresAt: string;
  userId: string;
  project: { id: string; name: string } | null;
  scope: string;
}

/** A distinct client address per case keeps each case's limiter bucket its own. */
function address(): string {
  return `198.51.100.${randomBytes(1)[0]}-${randomBytes(4).toString('hex')}`;
}

async function mint(s: Session, projectId?: string): Promise<Minted> {
  const res = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: s.token,
    body: projectId === undefined ? {} : { projectId },
  });
  expectStatus(res, 201, 'mint code');
  return res.data as unknown as Minted;
}

async function exchange(code: string, from = address()) {
  return call('/api/projects/cli-login-codes/exchange', {
    method: 'POST',
    body: { code },
    headers: { 'X-Forwarded-For': from },
  });
}

async function createProject(s: Session, name: string): Promise<{ id: string; name: string }> {
  const res = await call('/api/projects', { method: 'POST', auth: s.token, body: { name } });
  expectStatus(res, 201, `create project ${name}`);
  return res.data as unknown as { id: string; name: string };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('mint: only a signed-in user session can mint, for its own projects', async () => {
  const owner = await anonymousSession();
  const other = await anonymousSession();
  const project = await createProject(owner, 'Mint scope');

  const anonymous = await call('/api/projects/cli-login-codes', { method: 'POST', body: {} });
  expectStatus(anonymous, 401, 'no credentials');
  const viaApiKey = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    body: {},
    headers: apiKeyHeaders(owner.userId),
  });
  expectStatus(viaApiKey, 403, 'API key cannot mint');

  const foreign = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: other.token,
    body: { projectId: project.id },
  });
  expectStatus(foreign, 404, "another user's project");
  const unknownField = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: owner.token,
    body: { projectId: project.id, scope: 'all' },
  });
  expectStatus(unknownField, 400, 'strict body');

  const minted = await mint(owner, project.id);
  assert(/^rlc_[A-Za-z0-9_-]{32}$/.test(minted.code), `code format ${minted.code}`);
  assert(minted.project?.id === project.id, 'bound project echoed');
  const ttl = Date.parse(minted.expiresAt) - Date.now();
  assert(ttl > 25 * 60_000 && ttl <= 30 * 60_000, `30 minute code, got ${ttl} ms`);

  const { credential } = (await exchange(minted.code)).data as unknown as Exchanged;
  const viaCli = await call('/api/projects/cli-login-codes', {
    method: 'POST',
    auth: credential,
    body: {},
  });
  expectStatus(viaCli, 403, 'a CLI credential cannot mint more codes');
});

test('exchange once: credential issued, reuse rejected, secrets hashed at rest', async () => {
  const s = await anonymousSession();
  const project = await createProject(s, 'Exchange once');
  const minted = await mint(s, project.id);

  const first = await exchange(minted.code);
  expectStatus(first, 200, 'first exchange');
  const body = first.data as unknown as Exchanged;
  assert(/^rose_cli_[A-Za-z0-9_-]{43}$/.test(body.credential), 'credential format');
  assert(body.userId === s.userId, 'credential belongs to the minting user');
  assert(body.scope === 'projects', `scope ${body.scope}`);
  assert(body.project?.id === project.id && body.project.name === project.name, 'bound project');
  const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
  assert(days > 29 && days <= 30, `30 day credential, got ${days}`);

  const reuse = await exchange(minted.code);
  expectStatus(reuse, 401, 'second exchange of the same code');
  assert(reuse.data.code === 'cli_code_invalid', `reuse code ${reuse.text}`);
  for (const bad of ['rlc_short', `rlc_${'A'.repeat(32)}`, '']) {
    const res = await exchange(bad);
    assert([400, 401].includes(res.status), `bad code ${bad}: ${res.status}`);
  }

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "ProjectCliLogin" WHERE "userId" = ${s.userId}`;
  assert(rows.length === 1, `one row, got ${rows.length}`);
  const stored = JSON.stringify(rows);
  assert(!stored.includes(minted.code), 'code not stored');
  assert(!stored.includes(body.credential), 'credential not stored');
  assert(rows[0].codeHash === sha256(minted.code), 'code stored as sha256');
  assert(rows[0].credentialHash === sha256(body.credential), 'credential stored as sha256');
  assert(rows[0].exchangedAt instanceof Date, 'exchange recorded');

  const projects = await call('/api/projects', { auth: body.credential });
  expectStatus(projects, 200, 'credential lists projects');
  const otherRouter = await call('/api/agents', { auth: body.credential });
  expectStatus(otherRouter, 401, 'credential is rejected outside /api/projects');
});

test('expiry: an expired code is rejected and burned; an expired credential is 401', async () => {
  const s = await anonymousSession();
  const minted = await mint(s);
  await prisma.$executeRaw`
    UPDATE "ProjectCliLogin" SET "codeExpiresAt" = now() - interval '1 second'
    WHERE "codeHash" = ${sha256(minted.code)}`;
  const expired = await exchange(minted.code);
  expectStatus(expired, 401, 'expired code');
  await prisma.$executeRaw`
    UPDATE "ProjectCliLogin" SET "codeExpiresAt" = now() + interval '10 minutes'
    WHERE "codeHash" = ${sha256(minted.code)}`;
  expectStatus(await exchange(minted.code), 401, 'an expired presentation burned the code');

  const fresh = await mint(s);
  const { credential } = (await exchange(fresh.code)).data as unknown as Exchanged;
  expectStatus(await call('/api/projects', { auth: credential }), 200, 'live credential');
  await prisma.$executeRaw`
    UPDATE "ProjectCliLogin" SET "credentialExpiresAt" = now() - interval '1 second'
    WHERE "credentialHash" = ${sha256(credential)}`;
  const dead = await call('/api/projects', { auth: credential });
  expectStatus(dead, 401, 'expired credential');
  assert(dead.data.code === 'cli_credential_invalid', `expired credential body ${dead.text}`);
  const forged = await call('/api/projects', { auth: `rose_cli_${'B'.repeat(43)}` });
  expectStatus(forged, 401, 'unknown credential');
});

test('wrong user and scope: a bound credential reaches only its project', async () => {
  const owner = await anonymousSession();
  const stranger = await anonymousSession();
  const bound = await createProject(owner, 'Bound');
  const sibling = await createProject(owner, 'Sibling');
  const foreign = await createProject(stranger, 'Foreign');

  const { credential } = (await exchange((await mint(owner, bound.id)).code))
    .data as unknown as Exchanged;
  const list = await call('/api/projects', { auth: credential });
  expectStatus(list, 200, 'bound list');
  const ids = (list.data.projects as Array<{ id: string }>).map((p) => p.id);
  assert(ids.length === 1 && ids[0] === bound.id, `bound list shows only its project: ${ids}`);
  expectStatus(await call(`/api/projects/${bound.id}`, { auth: credential }), 200, 'bound get');
  expectStatus(
    await call(`/api/projects/${bound.id}/env-files`, { auth: credential }),
    200,
    'bound env files'
  );
  expectStatus(await call('/api/projects/sync-key', { auth: credential }), 200, 'sync key');
  for (const id of [sibling.id, foreign.id]) {
    expectStatus(await call(`/api/projects/${id}`, { auth: credential }), 404, `get ${id}`);
    expectStatus(
      await call(`/api/projects/${id}/sync`, { auth: credential }),
      404,
      `sync state ${id}`
    );
  }
  const create = await call('/api/projects', {
    method: 'POST',
    auth: credential,
    body: { name: 'Another' },
  });
  expectStatus(create, 403, 'bound credential cannot create');
  const upsertOther = await call('/api/projects', {
    method: 'PUT',
    auth: credential,
    body: { name: 'Sibling', startupTimeoutS: 9 },
  });
  expectStatus(upsertOther, 403, 'bound credential cannot upsert another name');
  const upsertOwn = await call('/api/projects', {
    method: 'PUT',
    auth: credential,
    body: { name: 'Bound', startupTimeoutS: 30 },
  });
  expectStatus(upsertOwn, 200, 'bound credential upserts its own project');
  const del = await call(`/api/projects/${bound.id}`, { method: 'DELETE', auth: credential });
  expectStatus(del, 403, 'CLI credentials never delete');

  const unbound = (await exchange((await mint(owner)).code)).data as unknown as Exchanged;
  assert(unbound.project === null, 'unbound credential');
  const all = await call('/api/projects', { auth: unbound.credential });
  const allIds = (all.data.projects as Array<{ id: string }>).map((p) => p.id);
  assert(allIds.includes(bound.id) && allIds.includes(sibling.id), 'unbound sees own projects');
  assert(!allIds.includes(foreign.id), 'unbound never lists another user’s project');
  expectStatus(
    await call(`/api/projects/${foreign.id}`, { auth: unbound.credential }),
    404,
    'unbound cannot read another user’s project'
  );
  const created = await call('/api/projects', {
    method: 'POST',
    auth: unbound.credential,
    body: { name: 'Created by CLI' },
  });
  expectStatus(created, 201, 'unbound credential creates a project');
  expectStatus(
    await call(`/api/projects/${sibling.id}`, { method: 'DELETE', auth: unbound.credential }),
    403,
    'unbound credential cannot delete'
  );
});

test('rate limit: the 11th failed exchange from one address is 429 before the code is checked', async () => {
  const s = await anonymousSession();
  const minted = await mint(s);
  const from = address();
  for (let i = 0; i < 10; i++) {
    const res = await exchange(`rlc_${randomBytes(24).toString('base64url')}`, from);
    expectStatus(res, 401, `wrong code attempt ${i + 1}`);
  }
  const limited = await exchange(minted.code, from);
  expectStatus(limited, 429, 'limited attempt');
  assert(limited.data.code === 'rate_limited', `limited body ${limited.text}`);
  const header = await fetch(`${BASE_URL}/api/projects/cli-login-codes/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
    body: JSON.stringify({ code: minted.code }),
  });
  assert(header.status === 429, `still limited: ${header.status}`);
  const wait = Number(header.headers.get('retry-after'));
  assert(wait >= 1 && wait <= 15 * 60, `Retry-After ${wait}`);
  const elsewhere = await exchange(minted.code);
  expectStatus(elsewhere, 200, 'a limited attempt never burned the code');
});

test('rate limit: successful exchanges never spend an address quota', async () => {
  const s = await anonymousSession();
  const from = address();
  // Twelve users behind one proxy address all sign in; only failures count.
  for (let i = 0; i < 12; i++) {
    const res = await exchange((await mint(s)).code, from);
    expectStatus(res, 200, `legitimate exchange ${i + 1}`);
  }
  const malformed = await call('/api/projects/cli-login-codes/exchange', {
    method: 'POST',
    body: { code: 'rlc_x', extra: true },
    headers: { 'X-Forwarded-For': from },
  });
  expectStatus(malformed, 400, 'strict body');
  expectStatus(await exchange((await mint(s)).code, from), 200, 'a failure does not block yet');
});

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir,
  });
}

test('real CLI: agent-init stores the credential 0600 outside the repo; push uses it', async () => {
  const s = await anonymousSession();
  const project = await createProject(s, 'CLI fixture');
  const repo = join(scratch, 'checkout');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  const secret = `cli-login-secret-${randomBytes(8).toString('hex')}`;
  writeFileSync(join(repo, '.env'), `FIXTURE_TOKEN=${secret}\n`);
  const configDir = join(scratch, 'config');
  const env = {
    ...process.env,
    ROSE_CONFIG_DIR: configDir,
    ROSE_TOKEN: '',
    ROSE_API_KEY: '',
    ROSE_USER_ID: '',
    ROSE_API_URL: BASE_URL,
  };
  const minted = await mint(s, project.id);
  const login = spawnSync(
    process.execPath,
    [ROSE_SYNC, 'agent-init', '--login-code', minted.code, '--dir', repo],
    { env, encoding: 'utf8' }
  );
  assert(login.status === 0, `agent-init failed: ${login.stderr}${login.stdout}`);
  const saved = join(configDir, 'credentials.json');
  assert((statSync(saved).mode & 0o777) === 0o600, 'credential file is 0600');
  const record = JSON.parse(readFileSync(saved, 'utf8')) as { credential: string };
  assert(record.credential.startsWith('rose_cli_'), 'credential saved');
  assert(!login.stdout.includes(record.credential), 'stdout never shows the credential');
  assert(!login.stdout.includes(secret), 'stdout never shows env values');
  assert(login.stdout.includes('FIXTURE_TOKEN') === false, 'guide does not dump variables');
  assert(/APPROVAL: ask before uploading secrets/.test(login.stdout), 'approval step printed');
  assert(login.stdout.includes(`push --project '${project.id}'`), 'push targets the bound project');

  const push = spawnSync(process.execPath, [ROSE_SYNC, 'push', '--dir', repo, '--json'], {
    env,
    encoding: 'utf8',
  });
  assert(push.status === 0, `push failed: ${push.stderr}${push.stdout}`);
  assert(!push.stdout.includes(secret), 'push output has names only');
  const pushed = JSON.parse(push.stdout) as { projectId: string; revision: number };
  assert(pushed.projectId === project.id && pushed.revision === 1, `pushed ${push.stdout}`);

  const status = spawnSync(
    process.execPath,
    [ROSE_SYNC, 'agent-init', 'status', '--dir', repo, '--json'],
    { env, encoding: 'utf8' }
  );
  assert(status.status === 0, `status failed: ${status.stderr}`);
  const report = JSON.parse(status.stdout) as {
    stage: string;
    project: { envFiles: Array<{ path: string; uploaded: boolean; variables: string[] }> };
  };
  assert(report.stage === 'synced', `stage ${report.stage}`);
  assert(
    report.project.envFiles.some(
      (f) => f.path === '.env' && f.uploaded && f.variables.includes('FIXTURE_TOKEN')
    ),
    `env file uploaded: ${status.stdout}`
  );
  assert(!status.stdout.includes(secret), 'status has names only');

  const reuse = spawnSync(
    process.execPath,
    [ROSE_SYNC, 'agent-init', '--login-code', minted.code, '--dir', repo],
    { env: { ...env, ROSE_CONFIG_DIR: join(scratch, 'config-2') }, encoding: 'utf8' }
  );
  assert(reuse.status !== 0, 'a used code cannot sign in again');
  assert(/copy a fresh setup prompt/i.test(reuse.stderr), `reuse guidance: ${reuse.stderr}`);
});

test('rate limit: distributed failures retain per-client denial without blocking unrelated clients', () => {
  const warningLines: string[] = [];
  const originalWrite = process.stdout.write;
  // This synchronous case owns the capture and restores it even on failure.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    warningLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const now = 1_000_000;
    const windowMs = 15 * 60_000;
    const limiter = new ExchangeRateLimiter(10, windowMs, 600, 10_000);
    for (let client = 0; client < 60; client++) {
      const key = `distributed-${client}`;
      for (let failure = 0; failure < 10; failure++) {
        assert(limiter.check(key, now).allowed, 'each client retains its exact ten-failure limit');
        limiter.recordFailure(key, now);
      }
    }
    assert(
      limiter.check('unrelated-legitimate-client', now).allowed,
      'a distributed failure threshold must not deny unrelated clients'
    );
    const denied = limiter.check('distributed-0', now);
    assert(!denied.allowed, 'the attacking address remains blocked');
    if (!denied.allowed) assert(denied.retryAfterS === 900, 'per-client Retry-After is unchanged');
    assert(limiter.check('distributed-0', now + windowMs).allowed, 'per-client window rolls over');
    const bounded = new ExchangeRateLimiter(2, 1000, 2, 1);
    bounded.recordFailure('tracked', now);
    bounded.recordFailure('overflow-a', now);
    assert(
      bounded.check('tracked', now).allowed,
      'overflow failures do not spend a tracked client quota'
    );
    bounded.recordFailure('overflow-b', now);
    assert(
      !bounded.check('overflow-c', now).allowed,
      'bounded-memory overflow quota remains enforced'
    );
    assert(bounded.check('overflow-c', now + 1000).allowed, 'overflow window still resets');
  } finally {
    process.stdout.write = originalWrite;
  }
  const alerts = warningLines.filter(
    (line) =>
      line.includes('ProjectCliLogin') &&
      line.includes('CLI exchange address-spraying threshold reached')
  );
  assert(
    alerts.length === 2,
    'each limiter emits exactly one warning when its global threshold is crossed'
  );
  assert(
    alerts.every((line) => !line.includes('distributed-')),
    'the warning carries counters, never client keys'
  );
});

test('agent setup commands preserve literal project and executable shell words', async () => {
  const casesPath = join(__dirname, 'cli-login-quoting.cases.mjs');
  const { verifyAgentInitShellWords } = await import(casesPath);
  const modulePath = join(REPO_ROOT, 'scripts/lib/rose-sync/agent-init.mjs');
  await verifyAgentInitShellWords(modulePath, false);
  await verifyAgentInitShellWords(modulePath, true);
});
