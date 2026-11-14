/**
 * One encrypted native-CLI credential bundle per connection. A command leases
 * the bundle, refreshes credentials locally, then returns its updated files.
 * Expired leases are never stolen: the prior command may have rotated a token.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { encryptProjectSecret, decryptProjectSecret } from './projects/secrets';
import { CliIntegrationError, type CliCaller } from './cliIntegrations';

export interface CliCredentialFile {
  path: string;
  data: string | null;
}
interface CredentialState {
  kind: 'native-cli-credentials-v1';
  envelope: string;
  paths: string[];
  lease?: { token: string; agentId: string; taskId: string; expiresAt: number };
}
const KIND = 'native-cli-credentials-v1';
const LEASE_MS = 90_000;
const MAX_FILE_BYTES = 65_536;
const MAX_TOTAL_BYTES = 262_144;
const RESERVED = new Set([
  '.rose',
  '.claude',
  '.codex',
  '.ssh',
  '.gnupg',
  '.git',
  '.cursor',
  '.agents',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  'AGENTS.md',
  'CLAUDE.md',
  '.mcp.json',
]);

/** Only relative HOME paths, excluding agent/platform config and shell startup files. */
export function isCliCredentialPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    value.startsWith('/') ||
    value.startsWith('~')
  )
    return false;
  const parts = value.split('/');
  return parts.every(
    (part) =>
      part !== '' && part !== '.' && part !== '..' && part.length <= 255 && !RESERVED.has(part)
  );
}
export function validateCliCredentialFiles(
  value: unknown,
  expectedPaths?: readonly string[]
): CliCredentialFile[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new CliIntegrationError(400, 'Invalid CLI credential files');
  let total = 0;
  const paths = new Set<string>();
  const files: CliCredentialFile[] = [];
  for (const file of value) {
    if (
      file === null ||
      typeof file !== 'object' ||
      !isCliCredentialPath(file.path) ||
      paths.has(file.path) ||
      (file.data !== null && typeof file.data !== 'string')
    )
      throw new CliIntegrationError(400, 'Invalid CLI credential files');
    if (typeof file.data === 'string') {
      if (
        file.data.length > 4 * Math.ceil(MAX_FILE_BYTES / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
      )
        throw new CliIntegrationError(400, 'Invalid CLI credential encoding or size');
      const bytes = Buffer.from(file.data, 'base64');
      if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== file.data)
        throw new CliIntegrationError(400, 'Invalid CLI credential encoding or size');
      total += bytes.length;
    }
    if (total > MAX_TOTAL_BYTES)
      throw new CliIntegrationError(400, 'CLI credential bundle exceeds its size limit');
    paths.add(file.path);
    files.push({ path: file.path, data: file.data });
  }
  if (
    expectedPaths &&
    (expectedPaths.length !== paths.size || expectedPaths.some((path) => !paths.has(path)))
  )
    throw new CliIntegrationError(400, 'CLI credential paths must match the connection');
  return files;
}
const credentialsWhere = (userId: string, integrationId: string) => ({
  userId_name_accountId: { userId, name: 'cli_credentials', accountId: integrationId },
});
const asJson = (value: CredentialState): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function credentialState(value: Prisma.JsonValue): CredentialState {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.kind !== KIND ||
    typeof value.envelope !== 'string' ||
    !Array.isArray(value.paths) ||
    value.paths.some((path) => !isCliCredentialPath(path))
  )
    throw new CliIntegrationError(409, 'CLI credentials are unavailable; reconnect this CLI');
  const state = value as unknown as CredentialState;
  if (
    state.lease &&
    (typeof state.lease.token !== 'string' ||
      typeof state.lease.agentId !== 'string' ||
      typeof state.lease.taskId !== 'string' ||
      typeof state.lease.expiresAt !== 'number')
  )
    throw new CliIntegrationError(409, 'CLI credentials are unavailable; reconnect this CLI');
  return state;
}
function secured(files: CliCredentialFile[]): string {
  try {
    return encryptProjectSecret(JSON.stringify(files));
  } catch {
    throw new CliIntegrationError(503, 'CLI credentials could not be secured');
  }
}
function opened(state: CredentialState): CliCredentialFile[] {
  try {
    const text = decryptProjectSecret(state.envelope);
    if (text === null) throw new Error('unavailable');
    return validateCliCredentialFiles(JSON.parse(text), state.paths);
  } catch {
    throw new CliIntegrationError(503, 'CLI credentials could not be opened');
  }
}

async function ownedCli(userId: string, integrationId: string) {
  const row = await prisma.integration.findFirst({
    where: { id: integrationId, userId, name: 'cli', type: 'TOOL_SETUP' },
  });
  if (!row) throw new CliIntegrationError(404, 'CLI connection not found');
  return row;
}
function declaredPaths(config: Prisma.JsonValue): string[] {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    config.native_template !== true ||
    typeof config.command !== 'string' ||
    !Array.isArray(config.credential_files) ||
    config.credential_files.length > 16 ||
    config.credential_files.some((path) => !isCliCredentialPath(path)) ||
    new Set(config.credential_files).size !== config.credential_files.length
  )
    throw new CliIntegrationError(409, 'Native CLI credentials are not configured');
  return config.credential_files as string[];
}
async function authorized(
  caller: CliCaller,
  integrationId: string
): Promise<{ paths: string[]; command: string }> {
  if (caller.taskId === null) throw new CliIntegrationError(403, 'A live code session is required');
  const [connection, task, agent] = await Promise.all([
    ownedCli(caller.userId, integrationId),
    prisma.claudeCodeSession.findUnique({
      where: { id: caller.taskId },
      select: { agentId: true, status: true },
    }),
    prisma.agent.findFirst({
      where: { id: caller.agentId, userId: caller.userId, deletedAt: null },
      select: { id: true },
    }),
  ]);
  if (!agent || !task || task.agentId !== caller.agentId || task.status !== 'ACTIVE')
    throw new CliIntegrationError(403, 'A live code session is required');
  if (connection.status !== 'CONNECTED') throw new CliIntegrationError(409, 'CLI is not connected');
  const paths = declaredPaths(connection.config);
  return { paths, command: String((connection.config as Prisma.JsonObject).command) };
}
async function loadState(userId: string, integrationId: string) {
  const row = await prisma.integration.findUnique({
    where: credentialsWhere(userId, integrationId),
    select: { config: true },
  });
  if (!row)
    throw new CliIntegrationError(409, 'CLI credentials are unavailable; reconnect this CLI');
  return credentialState(row.config);
}
async function swap(
  userId: string,
  integrationId: string,
  expected: CredentialState,
  next: CredentialState
): Promise<void> {
  const changed = await prisma.integration.updateMany({
    where: {
      userId,
      name: 'cli_credentials',
      accountId: integrationId,
      config: { equals: asJson(expected) },
    },
    data: { config: asJson(next) },
  });
  if (changed.count !== 1)
    throw new CliIntegrationError(
      409,
      'CLI credential lease changed; retry with its current owner'
    );
}
function assertLease(state: CredentialState, caller: CliCaller, token: string): void {
  if (
    !state.lease ||
    state.lease.token !== token ||
    state.lease.agentId !== caller.agentId ||
    state.lease.taskId !== caller.taskId
  )
    throw new CliIntegrationError(409, 'CLI credential lease does not belong to this session');
  if (state.lease.expiresAt <= Date.now())
    throw new CliIntegrationError(409, 'CLI credential lease expired; reconnect this CLI');
}

/** Setup may refresh its bundle until Connected; published credentials change only on release. */
export async function initializeCliCredentials(
  userId: string,
  integrationId: string,
  value: CliCredentialFile[],
  publishingToken?: string
): Promise<{ initialized: boolean }> {
  const connection = await ownedCli(userId, integrationId);
  const config = connection.config;
  const expected =
    config !== null &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    Array.isArray(config.credential_files)
      ? config.credential_files
      : undefined;
  if (expected && expected.some((path) => !isCliCredentialPath(path)))
    throw new CliIntegrationError(400, 'Invalid CLI credential paths');
  const files = validateCliCredentialFiles(value, expected as string[] | undefined);
  const state: CredentialState = {
    kind: KIND,
    envelope: secured(files),
    paths: files.map((file) => file.path),
  };
  return runTransactionWithRetry(async (tx) => {
    // Serialize setup initialization with the final connection publication.
    const setup = await tx.integration.updateMany({
      where: {
        id: integrationId,
        userId,
        name: 'cli',
        status: { not: 'CONNECTED' },
        ...(publishingToken
          ? {
              AND: [
                { config: { path: ['publishing_token'], equals: publishingToken } },
                { config: { path: ['publishing_expires_at'], gt: Date.now() } },
              ],
            }
          : {}),
      },
      data: { updatedAt: new Date() },
    });
    if (publishingToken && setup.count !== 1)
      throw new CliIntegrationError(409, 'CLI publication lease expired or was replaced');
    const existing = await tx.integration.findUnique({
      where: credentialsWhere(userId, integrationId),
      select: { config: true },
    });
    if (existing) {
      const prior = credentialState(existing.config);
      validateCliCredentialFiles(files, prior.paths);
      if (setup.count === 0) return { initialized: false };
      if (prior.lease)
        throw new CliIntegrationError(409, 'CLI credentials are in use or require reconnection');
      const changed = await tx.integration.updateMany({
        where: {
          userId,
          name: 'cli_credentials',
          accountId: integrationId,
          config: { equals: asJson(prior) },
        },
        data: { config: asJson(state) },
      });
      if (changed.count !== 1)
        throw new CliIntegrationError(409, 'CLI credential setup changed; retry initialization');
      return { initialized: true };
    }
    if (setup.count === 0)
      throw new CliIntegrationError(409, 'Connected CLI credentials cannot be initialized again');
    await tx.integration.create({
      data: {
        userId,
        name: 'cli_credentials',
        accountId: integrationId,
        type: 'TOOL_SETUP',
        status: 'CONNECTED',
        config: asJson(state),
      },
    });
    return { initialized: true };
  });
}
export async function acquireCliCredentials(
  caller: CliCaller,
  integrationId: string
): Promise<{
  lease_token: string;
  command: string;
  files: CliCredentialFile[];
  expires_at: number;
}> {
  const { paths, command } = await authorized(caller, integrationId);
  const state = await loadState(caller.userId, integrationId);
  if (state.lease)
    throw new CliIntegrationError(
      409,
      state.lease.expiresAt <= Date.now()
        ? 'CLI credential lease expired; reconnect this CLI'
        : 'CLI credentials are in use by another command'
    );
  const files = validateCliCredentialFiles(opened(state), paths);
  const token = randomUUID();
  const expiresAt = Date.now() + LEASE_MS;
  const next = {
    ...state,
    lease: { token, agentId: caller.agentId, taskId: caller.taskId!, expiresAt },
  };
  await swap(caller.userId, integrationId, state, next);
  return { lease_token: token, command, files, expires_at: expiresAt };
}
export async function heartbeatCliCredentials(
  caller: CliCaller,
  integrationId: string,
  token: string
): Promise<{ expires_at: number }> {
  await authorized(caller, integrationId);
  const state = await loadState(caller.userId, integrationId);
  assertLease(state, caller, token);
  const expiresAt = Date.now() + LEASE_MS;
  await swap(caller.userId, integrationId, state, {
    ...state,
    lease: { ...state.lease!, expiresAt },
  });
  return { expires_at: expiresAt };
}
export async function releaseCliCredentials(
  caller: CliCaller,
  integrationId: string,
  token: string,
  value: CliCredentialFile[]
): Promise<{ released: true }> {
  const { paths } = await authorized(caller, integrationId);
  const files = validateCliCredentialFiles(value, paths);
  const state = await loadState(caller.userId, integrationId);
  assertLease(state, caller, token);
  await swap(caller.userId, integrationId, state, { kind: KIND, paths, envelope: secured(files) });
  return { released: true };
}
