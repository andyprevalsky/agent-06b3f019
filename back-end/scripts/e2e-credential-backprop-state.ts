#!/usr/bin/env tsx
/* eslint-disable no-console */

import 'dotenv/config';
import { constants, createCipheriv, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RSA_PUBLIC_KEY_PEM } from '../src/providers/encryptionKeys';

type CredentialKind = 'cookie_bundle' | 'password' | 'steel_session' | 'email_otp' | 'minted';

const prisma = new PrismaClient();
const E2E_BROWSER_SOURCE = 'e2e-credential-backprop';
const PRACTICE_LOGIN_URL = 'https://practicetestautomation.com/practice-test-login/';
const SUCCESS_PASSWORD = 'Password123';
const AUTH_FAILURE_PASSWORD = 'DefinitelyWrongPassword20260522';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/e2e-credential-backprop-state.ts setup --case <success|auth_failure> --user-id <user-id>',
      '  npx tsx scripts/e2e-credential-backprop-state.ts state --kind <kind> --id <credential-id> [--agent-id <agent-id>]',
      '  npx tsx scripts/e2e-credential-backprop-state.ts cleanup --run-id <run-id> --user-id <user-id>',
    ].join('\n')
  );
  process.exit(2);
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function normalizeKind(kind: string): CredentialKind | null {
  const normalized = kind.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (normalized === 'cookie' || normalized === 'cookie_bundle') return 'cookie_bundle';
  if (normalized === 'browser_password' || normalized === 'password') return 'password';
  if (normalized === 'steel' || normalized === 'steel_auth' || normalized === 'steel_session') {
    return 'steel_session';
  }
  if (normalized === 'email' || normalized === 'email_otp' || normalized === 'otp') {
    return 'email_otp';
  }
  if (normalized === 'minted' || normalized === 'minted_account') return 'minted';
  return null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectCredentialRefs(value: unknown): Array<{ kind: CredentialKind; id: string }> {
  const refs = new Map<string, { kind: CredentialKind; id: string }>();

  function visit(nested: unknown): void {
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    if (!isObject(nested)) return;

    const rawRef = nested.credential_ref ?? nested.credentialRef;
    const rawRefs = Array.isArray(rawRef) ? rawRef : [rawRef];
    for (const item of rawRefs) {
      if (!isObject(item)) continue;
      const kind = typeof item.kind === 'string' ? normalizeKind(item.kind) : null;
      const id = typeof item.id === 'string' ? item.id : null;
      if (kind && id) refs.set(`${kind}:${id}`, { kind, id });
    }
    for (const item of Object.values(nested)) visit(item);
  }

  visit(value);
  return Array.from(refs.values());
}

function classifierMessage(metadata: unknown) {
  if (!isObject(metadata)) return null;
  if (metadata.action_type !== 'credential_failure_classification') return null;
  return {
    failureReason: typeof metadata.failureReason === 'string' ? metadata.failureReason : null,
    credentialPropagationOutcome:
      typeof metadata.credentialPropagationOutcome === 'string'
        ? metadata.credentialPropagationOutcome
        : null,
    rawError: typeof metadata.rawError === 'string' ? metadata.rawError : null,
  };
}

function encryptPasswordForStorage(password: string): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const encryptedAesKey = publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })
  ).toString('base64');
}

async function ensureUser(userId: string) {
  await prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      isAnonymous: true,
    },
    update: {},
  });
}

async function cleanupE2ECredentials(userId: string, runId?: string) {
  await prisma.browserPassword.deleteMany({
    where: {
      userId,
      browserSource: E2E_BROWSER_SOURCE,
      ...(runId ? { browserProfile: `run-${runId}` } : {}),
    },
  });
}

async function setupFixture(caseName: string, userId: string) {
  if (caseName !== 'success' && caseName !== 'auth_failure') {
    throw new Error(`Unsupported credential backprop fixture case: ${caseName}`);
  }

  await ensureUser(userId);
  await cleanupE2ECredentials(userId);

  const runId = randomUUID();
  const isSuccess = caseName === 'success';
  const credential = await prisma.browserPassword.create({
    data: {
      userId,
      origin: PRACTICE_LOGIN_URL,
      username: 'student',
      encryptedPassword: encryptPasswordForStorage(isSuccess ? SUCCESS_PASSWORD : AUTH_FAILURE_PASSWORD),
      browserSource: E2E_BROWSER_SOURCE,
      browserProfile: `run-${runId}`,
      dateLastUsed: BigInt(Date.now() * 1000),
      disabledAt: isSuccess ? new Date('2026-05-22T00:00:00.000Z') : null,
      disabledReason: isSuccess ? 'e2e previous auth failure' : null,
    },
  });

  return {
    fixture: {
      runId,
      targetUrl: PRACTICE_LOGIN_URL,
      credentialRefKind: 'password',
      credentialRefId: credential.id,
      username: credential.username,
      case: caseName,
    },
  };
}

async function loadCredential(kind: CredentialKind, id: string) {
  switch (kind) {
    case 'cookie_bundle': {
      const row = await prisma.cookieBundle.findUnique({
        where: { id },
        select: { id: true, userId: true, disabledAt: true, disabledReason: true },
      });
      return row
        ? {
            kind,
            id: row.id,
            exists: true,
            userId: row.userId,
            disabledAt: iso(row.disabledAt),
            disabledReason: row.disabledReason,
          }
        : { kind, id, exists: false };
    }
    case 'password': {
      const row = await prisma.browserPassword.findUnique({
        where: { id },
        select: { id: true, userId: true, disabledAt: true, disabledReason: true },
      });
      return row
        ? {
            kind,
            id: row.id,
            exists: true,
            userId: row.userId,
            disabledAt: iso(row.disabledAt),
            disabledReason: row.disabledReason,
          }
        : { kind, id, exists: false };
    }
    case 'steel_session': {
      const row = await prisma.steelSessionAuth.findUnique({
        where: { id },
        select: { id: true, userId: true, disabledAt: true, disabledReason: true },
      });
      return row
        ? {
            kind,
            id: row.id,
            exists: true,
            userId: row.userId,
            disabledAt: iso(row.disabledAt),
            disabledReason: row.disabledReason,
          }
        : { kind, id, exists: false };
    }
    case 'minted': {
      const row = await prisma.mintedAccount.findUnique({
        where: { id },
        select: { id: true, userId: true, disabledAt: true, disabledReason: true },
      });
      return row
        ? {
            kind,
            id: row.id,
            exists: true,
            userId: row.userId,
            disabledAt: iso(row.disabledAt),
            disabledReason: row.disabledReason,
          }
        : { kind, id, exists: false };
    }
    case 'email_otp': {
      const row = await prisma.emailIntegrationCredential.findUnique({
        where: { id },
        select: { id: true, userId: true, metadata: true },
      });
      return row
        ? {
            kind,
            id: row.id,
            exists: true,
            userId: row.userId,
            disabledAt: null,
            disabledReason: null,
            metadata: row.metadata,
          }
        : { kind, id, exists: false };
    }
  }
}

async function loadAgent(agentId: string | null) {
  if (!agentId) return null;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, status: true, statusMessage: true },
  });
  if (agent === null) return null;

  const [messages, marker] = await Promise.all([
    prisma.message.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, metadata: true },
    }),
    prisma.agentRunCredentialPropagation.findUnique({ where: { agentId } }),
  ]);

  const credentialRefs = new Map<string, { kind: CredentialKind; id: string }>();
  const classifierMessages = [];
  for (const message of messages) {
    for (const ref of collectCredentialRefs(message.metadata)) {
      credentialRefs.set(`${ref.kind}:${ref.id}`, ref);
    }
    const classifier = classifierMessage(message.metadata);
    if (classifier) {
      classifierMessages.push({
        ...classifier,
        timestamp: message.timestamp.toISOString(),
      });
    }
  }

  return {
    id: agent.id,
    status: agent.status,
    statusMessage: agent.statusMessage,
    propagationApplied: marker !== null,
    credentialRefs: Array.from(credentialRefs.values()),
    classifierMessages,
  };
}

async function main() {
  const command = process.argv[2]?.startsWith('--') ? 'state' : process.argv[2] ?? 'state';
  if (command === 'setup') {
    const caseName = argValue('--case');
    const userId = argValue('--user-id');
    if (!caseName || !userId) usage();
    console.log(JSON.stringify(await setupFixture(caseName, userId)));
    return;
  }

  if (command === 'cleanup') {
    const runId = argValue('--run-id');
    const userId = argValue('--user-id');
    if (!runId || !userId) usage();
    await cleanupE2ECredentials(userId, runId);
    console.log(JSON.stringify({ cleaned: true, runId }));
    return;
  }

  if (command !== 'state') usage();

  const rawKind = argValue('--kind');
  const id = argValue('--id');
  if (!rawKind || !id) usage();

  const kind = normalizeKind(rawKind);
  if (kind === null) {
    console.error(`Unsupported credential kind: ${rawKind}`);
    process.exit(2);
  }

  const agentId = argValue('--agent-id');
  const [credential, agent] = await Promise.all([
    loadCredential(kind, id),
    loadAgent(agentId),
  ]);

  console.log(JSON.stringify({ credential, agent }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
