/**
 * Shared scaffolding for the Rose Shop black-box suite: the test registry, a
 * throwaway user, an in-process copy of the site with Primitive's relay stubbed,
 * and small HTTP helpers. Case files register tests through `test(...)`; the
 * entrypoint (auth-test-site.blackbox.ts) imports them and runs the registry.
 */

import 'dotenv/config';
import { parse as parseDotenv } from 'dotenv';
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  privateDecrypt,
  constants,
  randomUUID,
  sign,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { prisma } from '../../providers/database';
import authTestSiteRouter from '../../domains/auth-test-site/routes';
import { AUTH_TEST_SITE_BASE_PATH } from '../../domains/auth-test-site/config';
import { setPaymentSettler } from '../../domains/auth-test-site/serviceShop';
import { AgentCardSandboxSettlementError } from '../../providers/agentcard/sandbox-settlement';

export const BASE_URL = process.env.TEST_BASE_URL ?? '';
export const API_KEY = process.env.BACKEND_API_KEY ?? '';
export const STUB_MAIL_DOMAIN = 'mail.rose-shop-blackbox.test';

export type TestFn = () => Promise<void>;
export const tests: Array<{ name: string; fn: TestFn }> = [];
export function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface Manifest {
  siteId: string;
  realm: string;
  entryUrl: string;
  savedPasswordUsernames: string[];
  mintedEmail: string | null;
  mintedPhone: string | null;
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
  namedAccountEmail: string | null;
  userSignIn: { email: string; password: string } | null;
  appApprovalUser: {
    deviceUrl: string;
    expectedNumber: string;
    challengeLifetimeSeconds: number;
  } | null;
  savedSession: 'valid' | 'expired' | null;
  savedBrowserAuthHidden: boolean;
  authOptionsPreview: {
    passwordUsernames: string[];
    mintedEmail: string | null;
    passkeyCount: number;
    cookieBundleCount: number;
    emailOtpInboxes: string[];
  };
}

export interface Report {
  signInEmail: string | null;
  attempts: Array<{ kind: string; email: string; outcome: string; reason: string | null }>;
  sessions: Array<{ email: string; method: string; endedAt: string | null }>;
  savedPasswords: Array<{ username: string; matchesAccount: boolean }>;
  passkey: { disabledAt: string | null; signCount: number } | null;
  savedSessionBundle: { disabledAt: string | null } | null;
  accounts: Array<{ email: string; memberNumber: string; origin: string; verified: boolean }>;
  orders: Array<{
    orderNumber: string;
    email: string | null;
    totalCents: number;
    purchaseId: string | null;
    itemIds: string[];
  }>;
}

export async function createUser(name: string | null = null): Promise<string> {
  const userId = `auth-test-site-${randomUUID()}`;
  await prisma.user.create({ data: { userId, name, isAnonymous: true, systemName: 'Rose' } });
  return userId;
}

export async function cleanup(userId: string) {
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.agentPhoneMessage.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.passkeyCredential.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.agentIdentity.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

/**
 * The worker's private key. Cloud shells inject it; a local checkout keeps it
 * only in agents/.env, the file the worker itself loads.
 */
function workerDecryptionKeyB64(): string {
  const injected = process.env.PAYMENT_DECRYPTION_KEY ?? '';
  if (injected !== '') return injected;
  const agentsEnv = path.resolve(__dirname, '../../../../agents/.env');
  if (!existsSync(agentsEnv)) return '';
  return parseDotenv(readFileSync(agentsEnv)).PAYMENT_DECRYPTION_KEY ?? '';
}

/** Mirrors the agent worker's decrypt_password_with_key for the shared envelope. */
export function decryptEnvelope(encrypted: string): string {
  const keyB64 = workerDecryptionKeyB64();
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
export async function withLocalSite(
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
    SURGE_API_KEY: process.env.SURGE_API_KEY,
    BLACKBOX_TEST_FAKE_AGENTPHONE: process.env.BLACKBOX_TEST_FAKE_AGENTPHONE,
  };
  try {
    process.env.PRIMITIVE_BASE_URL = await listen(relay);
    process.env.PRIMITIVE_API_KEY = 'blackbox-primitive-key';
    process.env.PRIMITIVE_DOMAIN = STUB_MAIL_DOMAIN;
    // No text may leave the test: without a key the site's SMS send fails closed.
    delete process.env.SURGE_API_KEY;
    // As on a benchmark stack: agent phone numbers are mocks with a local inbox.
    process.env.BLACKBOX_TEST_FAKE_AGENTPHONE = '1';
    await fn({ base: await listen(site), sentMail });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([close(relay), close(site)]);
  }
}

export async function createFixture(base: string, body: Record<string, unknown>) {
  return fetch(`${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  });
}

export async function fetchReport(base: string, siteId: string): Promise<Report> {
  const response = await fetch(`${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${siteId}/report`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assert(response.status === 200, `report expected 200, got ${response.status}`);
  return (await response.json()) as Report;
}

export function pagePath(manifest: Manifest, suffix: string): string {
  return `${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}${suffix}?authRealm=${manifest.realm}`;
}

export async function postForm(
  base: string,
  path: string,
  form: Record<string, string>,
  cookie = ''
) {
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

export async function savedPasswordsInListedOrder(userId: string, manifest: Manifest) {
  const rows = await prisma.browserPassword.findMany({
    where: { userId, origin: manifest.entryUrl },
  });
  return manifest.authOptionsPreview.passwordUsernames.map((username) => {
    const row = rows.find((candidate) => candidate.username === username);
    assert(row !== undefined, `saved password row missing for ${username}`);
    return { username, password: decryptEnvelope(row.encryptedPassword) };
  });
}

export function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

export async function getPage(base: string, path: string, cookie = '') {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
  });
}

export async function postJson(base: string, path: string, body: unknown, cookie = '') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Every Set-Cookie pair of a response, joined for a Cookie request header. */
export function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0] ?? '')
    .join('; ');
}

/** Gives the user a minted identity up front so no test provisions a real inbox or phone. */
export async function createMintedIdentity(userId: string, phone = '+15555550142') {
  const email = `rose.cedar11.${randomUUID().slice(0, 8)}@${STUB_MAIL_DOMAIN}`;
  await prisma.agentIdentity.create({
    data: { userId, email, phone, phoneProvider: 'agentphone' },
  });
  return { email, phone };
}

/** The mail body of the last message sent to the address, or '' when none was. */
export function lastMailTo(sentMail: Array<Record<string, string>>, to: string): string {
  const mail = [...sentMail].reverse().find((candidate) => candidate.to === to);
  return mail?.body_text ?? '';
}

/**
 * Signs a WebAuthn assertion the way the agent's virtual authenticator would,
 * using the passkey row the fixture stored for the user.
 */
export async function signPasskeyAssertion(params: {
  userId: string;
  realm: string;
  origin: string;
  challenge: string;
}) {
  const row = await prisma.passkeyCredential.findFirst({
    where: { userId: params.userId, authRealm: params.realm },
  });
  assert(row !== null, 'fixture passkey row missing');
  const privateKey = createPrivateKey({
    key: Buffer.from(decryptEnvelope(row.encryptedPrivateKey), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: params.challenge, origin: params.origin })
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(Number(row.signCount) + 1);
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(row.rpId).digest(),
    Buffer.from([0x05]),
    counter,
  ]);
  const signature = sign(
    'sha256',
    Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
    privateKey
  );
  return {
    credentialId: Buffer.from(row.credentialId, 'base64').toString('base64url'),
    clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: authenticatorData.toString('base64url'),
    signature: signature.toString('base64url'),
  };
}

// --- Shop checkout helpers shared by the sign-up/shop and checkout case files.

export const SHOP_CARD = {
  cardNumber: '4242 4242 4242 4242',
  cardName: 'Avery Ross',
  cardExpiry: '12/30',
  cardCvv: '123',
  postalCode: '94105',
};

export async function seedShop(base: string, userId: string, scenario: string): Promise<Manifest> {
  const created = await createFixture(base, { userId, scenario, publicBaseUrl: base });
  assert(created.status === 201, `${scenario} fixture expected 201, got ${created.status}`);
  return (await created.json()) as Manifest;
}

export function attemptTrail(report: {
  attempts: Array<{ kind: string; outcome: string; reason: string | null }>;
}) {
  return report.attempts.map(
    (a) => `${a.kind}:${a.outcome}${a.reason === null ? '' : `:${a.reason}`}`
  );
}

/** Stands in for the sandbox card settlement; records every charge it is asked to make. */
export async function withSettler(
  fn: (
    charges: Array<{ cardNumber: string; amountCents: number; merchant: string }>
  ) => Promise<void>,
  behavior: 'settle' | 'decline' | 'outage' = 'settle'
) {
  const charges: Array<{ cardNumber: string; amountCents: number; merchant: string }> = [];
  // One hold per test: like the real settler, the same card and total replay
  // the same purchase inside a test, and another test's hold is another purchase.
  const hold = randomUUID();
  setPaymentSettler((input) => {
    charges.push(input);
    if (behavior === 'decline') return Promise.reject(new Error('no held purchase for this card'));
    if (behavior === 'outage') {
      return Promise.reject(
        new AgentCardSandboxSettlementError('Cleared purchase is missing its Stripe hold', 502)
      );
    }
    return Promise.resolve({
      purchaseId: `purchase-${hold}-${input.cardNumber}-${input.amountCents}`,
    });
  });
  try {
    await fn(charges);
  } finally {
    setPaymentSettler(null);
  }
}

export async function cartWithTote(base: string, manifest: Manifest): Promise<string> {
  const added = await postForm(base, pagePath(manifest, '/cart/add'), { item: 'canvas-tote' });
  assert(added.status === 303, 'adding to the cart redirects to it');
  return responseCookies(added);
}
