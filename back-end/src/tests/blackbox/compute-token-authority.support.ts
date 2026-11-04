/** Shared setup for the registered backend-native authority contract. */
import assert from 'assert';
import { type ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const backendDir = path.resolve(__dirname, '../../..');
const serverScript = path.join(__dirname, 'compute-token-authority.server.ts');
export const USER_ID = `cta-user-${crypto.randomUUID()}`;
export const GUEST_KEY = `guest-key-${crypto.randomUUID()}`;
export const AUTHORITY_KEY = `authority-key-${crypto.randomUUID()}`;

export function writeAuthorityFixtureSchema(tmp: string): string {
  const schemaSql = execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: backendDir, encoding: 'utf8' }
  );
  const schemaFile = path.join(tmp, 'schema.sql');
  fs.writeFileSync(schemaFile, schemaSql);
  return schemaFile;
}

export function localServerUrl(): URL {
  const raw = process.env.DATABASE_URL;
  assert(raw, 'DATABASE_URL is required for the compute-token authority blackbox');
  const url = new URL(raw);
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    `compute-token authority blackbox requires local Postgres, got ${url.hostname}`
  );
  url.search = '';
  return url;
}

export function databaseUrl(server: URL, name: string): string {
  const url = new URL(server.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

export function encryptEnvelope(plaintext: string, publicKeyPem: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const encryptedAesKey = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
    'utf8'
  ).toString('base64');
}

export async function startBackend(
  label: string,
  url: string,
  decryptionKey: string,
  extraEnv: Record<string, string>,
  children: ChildProcess[]
): Promise<{ child: ChildProcess; baseUrl: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    DIRECT_URL: url,
    PORT: '0',
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: decryptionKey,
    COMPUTE_TOKEN_AUTHORITY_URL: '',
    COMPUTE_TOKEN_AUTHORITY_API_KEY: '',
    ...extraEnv,
  };
  delete env.FLY_APP_NAME;
  const child = spawn(process.execPath, ['--import', 'tsx', serverScript], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} backend did not start within 60s: ${stderr}`)),
      60_000
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} backend exited ${code} before READY: ${stderr}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

export async function fetchLease(baseUrl: string, lineageKey: string): Promise<number> {
  const params = new URLSearchParams({
    lineageKey,
    agentId: lineageKey,
    rootAgentId: lineageKey,
    tokenType: 'gpt',
  });
  const response = await fetch(
    `${baseUrl}/api/integrations/compute-code/credentials/token?${params}`,
    { headers: { 'X-API-Key': GUEST_KEY, 'X-User-Id': USER_ID } }
  );
  await response.text();
  return response.status;
}

export async function post(baseUrl: string, route: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/integrations/compute-code/${route}`, {
    method: 'POST',
    headers: { 'X-API-Key': GUEST_KEY, 'X-User-Id': USER_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `${route} returned ${response.status}: ${text}`);
}

export async function foundryCall(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/integrations/compute-code/${route}`, {
    method: 'POST',
    headers: { 'X-API-Key': GUEST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `${route} returned ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function assertInvalidFoundryInputs(
  baseUrl: string,
  cooldownRows: () => Promise<unknown>
): Promise<void> {
  const beforeInvalid = await cooldownRows();
  const invalidKeys = [
    '',
    Array.from({ length: 65 }, (_, i) => `limit.example.test:deployment-${i}`).join(','),
    'bad host:deployment',
  ];
  for (const keys of invalidKeys) {
    const response = await fetch(
      `${baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=${encodeURIComponent(keys)}`,
      { headers: { 'X-API-Key': AUTHORITY_KEY } }
    );
    assert.strictEqual(response.status, 400, `invalid cooldown keys: ${keys}`);
    assert.deepStrictEqual(await cooldownRows(), beforeInvalid, 'invalid read must not mutate');
  }
  for (const body of [
    { region: 42, deployment: 'deployment' },
    { region: 'valid.example.test', deployment: 'bad deployment' },
  ]) {
    const response = await fetch(
      `${baseUrl}/api/integrations/compute-code/foundry-deployment/served`,
      {
        method: 'POST',
        headers: { 'X-API-Key': AUTHORITY_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    assert.strictEqual(response.status, 400, 'invalid served input must fail closed');
    assert.deepStrictEqual(await cooldownRows(), beforeInvalid, 'invalid reset must not mutate');
  }
  for (const body of [
    { region: ['valid.example.test'], deployment: 'deployment' },
    { region: 'valid.example.test', deployment: ['deployment'] },
    { region: null, deployment: 'deployment' },
    { region: 'valid.example.test', deployment: {} },
  ]) {
    const response = await fetch(`${baseUrl}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: { 'X-API-Key': AUTHORITY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'foundry', source: 'pool', ...body }),
    });
    assert.strictEqual(response.status, 400, 'non-string Foundry mark input must fail closed');
    assert.deepStrictEqual(await cooldownRows(), beforeInvalid, 'invalid mark must not mutate');
  }
  const validAfterInvalid = await fetch(
    `${baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=valid.example.test:deployment`,
    { headers: { 'X-API-Key': AUTHORITY_KEY } }
  );
  assert.strictEqual(validAfterInvalid.status, 200);
  console.log('PASS invalid cooldown read/reset inputs fail closed without mutation');
}
