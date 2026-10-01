#!/usr/bin/env tsx
/**
 * Black-box tests for the dev-only Larkspur Members sign-in site that backs the
 * daily browser-auth benchmarks (password retry, all-options-fail, minted OTP).
 *
 * Two surfaces:
 *   - the real backend at TEST_BASE_URL proves the router is mounted, guarded,
 *     and seeds realm-scoped credentials exactly as the agent will see them;
 *   - an in-process copy of the same router (same Prisma DB) lets the test read
 *     the per-site account table and stub Primitive's relay, so the sign-in
 *     ladder and the emailed-code loop are deterministic and send no real mail.
 */

import 'dotenv/config';
import { createDecipheriv, privateDecrypt, constants, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { prisma } from '../../providers/database';
import { canonicalAuthRealm } from '../../providers/authRealm';
import authTestSiteRouter from '../../domains/auth-test-site/routes';
import { AUTH_TEST_SITE_BASE_PATH } from '../../domains/auth-test-site/config';

const BASE_URL = process.env.TEST_BASE_URL ?? '';
const API_KEY = process.env.BACKEND_API_KEY ?? '';
const STUB_MAIL_DOMAIN = 'mail.larkspur-blackbox.test';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Manifest {
  siteId: string;
  realm: string;
  entryUrl: string;
  savedPasswordUsernames: string[];
  mintedEmail: string | null;
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
  savedBrowserAuthHidden: boolean;
  authOptionsPreview: { passwordUsernames: string[]; mintedEmail: string | null };
}

interface Report {
  signInEmail: string | null;
  attempts: Array<{ kind: string; email: string; outcome: string; reason: string | null }>;
  sessions: Array<{ email: string; method: string }>;
  savedPasswords: Array<{ username: string; matchesAccount: boolean }>;
}

async function createUser(name: string | null = null): Promise<string> {
  const userId = `auth-test-site-${randomUUID()}`;
  await prisma.user.create({ data: { userId, name, isAnonymous: true, systemName: 'Rose' } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.agentIdentity.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

/** Mirrors the agent worker's decrypt_password_with_key for the shared envelope. */
function decryptEnvelope(encrypted: string): string {
  const keyB64 = process.env.PAYMENT_DECRYPTION_KEY ?? '';
  assert(keyB64 !== '', 'PAYMENT_DECRYPTION_KEY is required to emulate the agent worker');
  const envelope = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as {
    encrypted_aes_key: string;
    iv: string;
    ciphertext: string;
  };
  const aesKey = privateDecrypt(
    {
      key: Buffer.from(keyB64, 'base64').toString('utf8'),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.encrypted_aes_key, 'base64')
  );
  const sealed = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** In-process site + Primitive relay stub; restores the env it overrides. */
async function withLocalSite(
  fn: (ctx: { base: string; sentMail: Array<Record<string, string>> }) => Promise<void>
) {
  const sentMail: Array<Record<string, string>> = [];
  const relay = createServer((req, res) => {
    void readBody(req).then((body) => {
      if (req.method === 'POST' && req.url === '/send-mail') {
        sentMail.push(JSON.parse(body) as Record<string, string>);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: `stub-${sentMail.length}` } }));
    });
  });
  const app = express();
  app.use(express.json());
  app.use(AUTH_TEST_SITE_BASE_PATH, authTestSiteRouter);
  const site = createServer(app);
  const previous = {
    PRIMITIVE_API_KEY: process.env.PRIMITIVE_API_KEY,
    PRIMITIVE_BASE_URL: process.env.PRIMITIVE_BASE_URL,
    PRIMITIVE_DOMAIN: process.env.PRIMITIVE_DOMAIN,
  };
  try {
    process.env.PRIMITIVE_BASE_URL = await listen(relay);
    process.env.PRIMITIVE_API_KEY = 'blackbox-primitive-key';
    process.env.PRIMITIVE_DOMAIN = STUB_MAIL_DOMAIN;
    await fn({ base: await listen(site), sentMail });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([close(relay), close(site)]);
  }
}

async function createFixture(base: string, body: Record<string, unknown>) {
  return fetch(`${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  });
}

async function fetchReport(base: string, siteId: string): Promise<Report> {
  const response = await fetch(`${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${siteId}/report`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assert(response.status === 200, `report expected 200, got ${response.status}`);
  return (await response.json()) as Report;
}

function pagePath(manifest: Manifest, suffix: string): string {
  return `${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}${suffix}?authRealm=${manifest.realm}`;
}

async function postForm(base: string, path: string, form: Record<string, string>, cookie = '') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
}

async function savedPasswordsInListedOrder(userId: string, manifest: Manifest) {
  const rows = await prisma.browserPassword.findMany({
    where: { userId, origin: manifest.entryUrl },
  });
  return manifest.authOptionsPreview.passwordUsernames.map((username) => {
    const row = rows.find((candidate) => candidate.username === username);
    assert(row !== undefined, `saved password row missing for ${username}`);
    return { username, password: decryptEnvelope(row.encryptedPassword) };
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

test('fixture management requires the internal API key and unknown sites 404', async () => {
  const forbidden = await fetch(`${BASE_URL}${AUTH_TEST_SITE_BASE_PATH}/fixtures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'x', scenario: 'all_fail', publicBaseUrl: BASE_URL }),
  });
  assert(forbidden.status === 403, `expected 403 without API key, got ${forbidden.status}`);
  const missing = await fetch(`${BASE_URL}${AUTH_TEST_SITE_BASE_PATH}/000000000000/`);
  assert(missing.status === 404, `expected 404 for unknown site, got ${missing.status}`);
  assert((await missing.text()).includes('Page not found'), 'expected HTML not-found page');
});

test('password_retry seeds three realm-scoped saved passwords, freshest first, then deletes them', async () => {
  const userId = await createUser('J Ng');
  try {
    const response = await createFixture(BASE_URL, {
      userId,
      scenario: 'password_retry',
      publicBaseUrl: BASE_URL,
    });
    assert(response.status === 201, `fixture expected 201, got ${response.status}`);
    const manifest = (await response.json()) as Manifest;
    const usernames = manifest.savedPasswordUsernames;
    assert(
      new Set(usernames).size === 3 && usernames.every((name) => /^(j|ng)[.a-z]*\./.test(name)),
      `saved logins must be three distinct addresses derived from the user's name: ${usernames}`
    );
    assert(/^larkspur-[0-9a-f]{12}\.test$/.test(manifest.realm), `bad realm ${manifest.realm}`);
    assert(canonicalAuthRealm(manifest.entryUrl) === manifest.realm, 'entryUrl must carry realm');
    assert(manifest.savedBrowserAuthHidden === false, 'saved browser auth must be visible');
    assert(
      JSON.stringify(manifest.authOptionsPreview.passwordUsernames) ===
        JSON.stringify(manifest.savedPasswordUsernames),
      `auth options must list every saved password freshest first: ${JSON.stringify(manifest.authOptionsPreview)}`
    );
    assert(manifest.authOptionsPreview.mintedEmail === null, 'passwords must suppress minted');
    assert(
      manifest.expectedSignInEmail === null,
      'the working login is whichever third saved login the agent tries, so none is pinned'
    );
    assert(/^LM-\d{8}$/.test(manifest.expectedMemberNumber ?? ''), 'member number expected');

    const page = await fetch(`${BASE_URL}${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}/login`, {
      redirect: 'manual',
    });
    assert(page.status === 303, `login without authRealm must redirect, got ${page.status}`);
    assert(
      (page.headers.get('location') ?? '').endsWith(`/login?authRealm=${manifest.realm}`),
      `redirect must add authRealm: ${page.headers.get('location')}`
    );

    const removed = await fetch(
      `${BASE_URL}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${manifest.siteId}`,
      {
        method: 'DELETE',
        headers: { 'X-API-Key': API_KEY },
      }
    );
    assert(removed.status === 200, `delete expected 200, got ${removed.status}`);
    const left = await prisma.browserPassword.count({
      where: { userId, origin: manifest.entryUrl },
    });
    assert(left === 0, `fixture passwords must be deleted, ${left} left`);
  } finally {
    await cleanup(userId);
  }
});

test('fixture rejects a public host that cannot carry an authRealm override', async () => {
  const userId = await createUser();
  try {
    const response = await createFixture(BASE_URL, {
      userId,
      scenario: 'password_retry',
      publicBaseUrl: 'https://members.example.com',
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(
      (await prisma.browserPassword.count({ where: { userId } })) === 0,
      'rejected fixture must not seed passwords'
    );
  } finally {
    await cleanup(userId);
  }
});

test('dev tunnel hosts honor authRealm overrides; ordinary hosts do not', async () => {
  for (const host of ['abc.trycloudflare.com', 'abc.ngrok-free.app', 'abc.ngrok-free.dev']) {
    const realm = canonicalAuthRealm(`https://${host}/x/?authRealm=larkspur-1.test`);
    assert(realm === 'larkspur-1.test', `${host} must honor override, got ${realm}`);
  }
  const spoofed = canonicalAuthRealm('https://shop.example.com/?authRealm=amazon.com');
  assert(spoofed === 'example.com', `public hosts must ignore override, got ${spoofed}`);
});

test('password_retry: the two stale saved passwords are rejected and the third signs in', async () => {
  const userId = await createUser('Avery Quinlan-Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'password_retry',
        publicBaseUrl: base,
      });
      assert(created.status === 201, `fixture expected 201, got ${created.status}`);
      const manifest = (await created.json()) as Manifest;
      const expectedUsernames = ['avery.ross', 'averyr', 'a.ross'].map(
        (localPart) => `${localPart}.${manifest.siteId}@example.com`
      );
      assert(
        JSON.stringify(manifest.savedPasswordUsernames) === JSON.stringify(expectedUsernames),
        `saved logins must belong to the user by name: ${manifest.savedPasswordUsernames}`
      );
      const saved = await savedPasswordsInListedOrder(userId, manifest);
      const outcomes: number[] = [];
      let cookie = '';
      for (const credential of saved) {
        const response = await postForm(base, pagePath(manifest, '/login'), {
          email: credential.username,
          password: credential.password,
        });
        outcomes.push(response.status);
        if (response.status === 303) cookie = sessionCookie(response);
        else assert((await response.text()).includes('incorrect'), 'rejection must explain itself');
      }
      assert(JSON.stringify(outcomes) === '[200,200,303]', `unexpected outcomes ${outcomes}`);
      const account = await fetch(`${base}${pagePath(manifest, '/account')}`, {
        headers: { Cookie: cookie },
      });
      const html = await account.text();
      assert(html.includes(`Signed in as <strong>${saved[2]?.username}`), 'wrong account');
      assert(html.includes(manifest.expectedMemberNumber ?? '?'), 'member number must be shown');
      assert(
        html.includes('<dd id="member-name">Avery Quinlan-Ross</dd>'),
        'account page must name the member'
      );

      const report = await fetchReport(base, manifest.siteId);
      const reasons = report.attempts.map((attempt) => `${attempt.outcome}:${attempt.reason}`);
      assert(
        JSON.stringify(reasons) ===
          JSON.stringify(['rejected:wrong_password', 'rejected:unknown_account', 'signed_in:null']),
        `unexpected attempt log ${JSON.stringify(reasons)}`
      );
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'password',
        'one session'
      );
      assert(report.signInEmail === saved[2]?.username, `signInEmail ${report.signInEmail}`);
    });
  } finally {
    await cleanup(userId);
  }
});

test('password_retry: whichever two saved logins are tried first fail and the third works', async () => {
  const userId = await createUser('Avery Quinlan-Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'password_retry',
        publicBaseUrl: base,
      });
      const manifest = (await created.json()) as Manifest;
      const [first, second, third] = await savedPasswordsInListedOrder(userId, manifest);
      assert(first && second && third, 'three saved logins expected');
      const submit = (credential: { username: string; password: string }) =>
        postForm(base, pagePath(manifest, '/login'), {
          email: credential.username,
          password: credential.password,
        });

      assert((await submit(third)).status === 200, 'the first saved login tried must fail');
      assert((await submit(third)).status === 200, 'resubmitting a failed login keeps failing');
      assert(
        (await submit({ username: second.username, password: 'guessed-password' })).status === 200,
        'a password that is not saved never works'
      );
      assert((await submit(first)).status === 200, 'the second distinct saved login must fail');
      const signedIn = await submit(second);
      assert(
        signedIn.status === 303,
        `the third distinct saved login must work, got ${signedIn.status}`
      );
      const accountHtml = await (
        await fetch(`${base}${pagePath(manifest, '/account')}`, {
          headers: { Cookie: sessionCookie(signedIn) },
        })
      ).text();
      assert(accountHtml.includes(`Signed in as <strong>${second.username}`), 'wrong account');
      assert(accountHtml.includes(manifest.expectedMemberNumber ?? '?'), 'member number');

      await postForm(base, pagePath(manifest, '/logout'), {}, sessionCookie(signedIn));
      assert((await submit(second)).status === 303, 'the working login keeps working');
      assert((await submit(third)).status === 200, 'logins that failed keep failing');

      const report = await fetchReport(base, manifest.siteId);
      assert(report.signInEmail === second.username, `signInEmail ${report.signInEmail}`);
      const trail = report.attempts.map(
        (a) =>
          `${a.email === third.username ? 3 : a.email === first.username ? 1 : 2}:${a.outcome}:${a.reason}`
      );
      assert(
        JSON.stringify(trail) ===
          JSON.stringify([
            '3:rejected:wrong_password',
            '3:rejected:wrong_password',
            '2:rejected:unknown_account',
            '1:rejected:unknown_account',
            '2:signed_in:null',
            '2:signed_in:null',
            '3:rejected:wrong_password',
          ]),
        `unexpected ladder ${JSON.stringify(trail)}`
      );
      assert(
        report.savedPasswords.map((record) => record.matchesAccount).join() === 'false,true,false',
        `only the resolved login matches: ${JSON.stringify(report.savedPasswords)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('all_fail: every saved password is rejected and no minted account is offered', async () => {
  const userId = await createUser();
  try {
    await withLocalSite(async ({ base, sentMail }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'all_fail',
        publicBaseUrl: base,
      });
      const manifest = (await created.json()) as Manifest;
      assert(manifest.expectedSignInEmail === null, 'no account should be reachable');
      assert(manifest.authOptionsPreview.mintedEmail === null, 'minted must stay hidden');
      for (const credential of await savedPasswordsInListedOrder(userId, manifest)) {
        const response = await postForm(base, pagePath(manifest, '/login'), {
          email: credential.username,
          password: credential.password,
        });
        assert(response.status === 200, `saved password for ${credential.username} must fail`);
      }
      const codeRequest = await postForm(base, pagePath(manifest, '/login/code'), {
        email: manifest.savedPasswordUsernames[0] ?? '',
      });
      assert(codeRequest.status === 303, 'code request redirects to code entry');
      assert(sentMail.length === 0, 'no mail may leave for addresses we cannot receive');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.sessions.length === 0, 'no session may exist');
      assert(report.signInEmail === null, 'no account may be reachable');
      assert(report.attempts.filter((a) => a.kind === 'password').length === 3, 'three attempts');
      assert(
        report.savedPasswords.every((record) => !record.matchesAccount),
        'none may match'
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('minted_otp: the emailed code reaches the minted inbox and signs in', async () => {
  const userId = await createUser('Rowan Ellery');
  const mintedEmail = `rose.cedar11.${randomUUID().slice(0, 8)}@${STUB_MAIL_DOMAIN}`;
  try {
    await prisma.agentIdentity.create({
      data: { userId, email: mintedEmail, phone: '+15555550142', phoneProvider: 'agentphone' },
    });
    await withLocalSite(async ({ base, sentMail }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'minted_otp',
        publicBaseUrl: base,
      });
      assert(created.status === 201, `fixture expected 201, got ${created.status}`);
      const manifest = (await created.json()) as Manifest;
      assert(manifest.mintedEmail === mintedEmail, `minted email mismatch ${manifest.mintedEmail}`);
      assert(manifest.authOptionsPreview.passwordUsernames.length === 0, 'no saved passwords');
      assert(manifest.expectedSignInEmail === mintedEmail, 'minted account must be the target');

      const unknown = await postForm(base, pagePath(manifest, '/login/code'), {
        email: `nobody@${STUB_MAIL_DOMAIN}`,
      });
      assert(unknown.status === 303 && sentMail.length === 0, 'unknown accounts get no mail');

      const requested = await postForm(base, pagePath(manifest, '/login/code'), {
        email: mintedEmail,
      });
      assert(requested.status === 303, 'code request must redirect to code entry');
      const entry = await fetch(`${base}${requested.headers.get('location') ?? ''}`);
      assert((await entry.text()).includes('Verify and sign in'), 'code entry page expected');
      assert(sentMail.length === 1 && sentMail[0]?.to === mintedEmail, 'one mail to minted inbox');
      const code = /sign-in code is (\d{6})/.exec(sentMail[0]?.body_text ?? '')?.[1] ?? '';
      assert(code !== '', `code missing from mail: ${sentMail[0]?.body_text}`);

      const wrong = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: mintedEmail,
        code: code === '000000' ? '111111' : '000000',
      });
      assert(wrong.status === 200, 'a wrong code must be rejected');
      const verified = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: mintedEmail,
        code,
      });
      assert(verified.status === 303, `correct code must sign in, got ${verified.status}`);
      const account = await fetch(`${base}${pagePath(manifest, '/account')}`, {
        headers: { Cookie: sessionCookie(verified) },
      });
      const accountHtml = await account.text();
      assert(accountHtml.includes(manifest.expectedMemberNumber ?? '?'), 'member number');
      assert(
        accountHtml.includes('<dd id="member-name">Rowan Ellery</dd>'),
        'minted account page must name the member it was opened for'
      );
      const report = await fetchReport(base, manifest.siteId);
      assert(report.signInEmail === mintedEmail, `signInEmail ${report.signInEmail}`);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'email_code',
        `expected one email_code session, got ${JSON.stringify(report.sessions)}`
      );
      assert(
        report.attempts.some((a) => a.kind === 'code_request' && a.outcome === 'code_sent'),
        'code_sent attempt expected'
      );
    });
  } finally {
    await cleanup(userId);
  }
});

async function main(): Promise<void> {
  if (BASE_URL === '')
    throw new Error('TEST_BASE_URL is required (scripts/run-blackbox-tests.sh sets it)');
  console.log(`Running auth-test-site black-box tests (${tests.length} tests)...`);
  let failed = 0;
  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      console.log(`PASS ${name} (${Date.now() - start}ms)`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name} (${Date.now() - start}ms)`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nAuth-test-site black-box tests: ${tests.length - failed}/${tests.length} passed`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
