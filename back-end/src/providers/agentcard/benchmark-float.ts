import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

const DEFAULT_ADMIN_API_URL = 'https://api.agentcard.sh';
const DEFAULT_SANDBOX_FLOAT_CENTS = 50_000;
const REFRESH_EXPIRY_SKEW_SECONDS = 60;
const REFRESH_TIMEOUT_MS = 10_000;
const MIN_REFRESH_LOCK_TIMEOUT_MS = 15_000;
const REFRESH_LOCK_IO_MARGIN_MS = 5_000;
const REFRESH_LOCK_STALE_MARGIN_MS = 10_000;

type FetchLike = typeof fetch;

interface AdminConfig {
  apiUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  jwt?: string;
  activeKeyId?: string;
  lastApiKey?: string;
  storedKeys?: Array<{ id?: string; key?: string }>;
}

interface UserConfig {
  apiUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  jwt?: string;
}

type CredentialConfig = AdminConfig | UserConfig;

interface WalletResponse {
  settings?: { sandbox_balance_cents?: number };
  sandboxWalletBalanceCents?: number;
}

export interface AgentCardBenchmarkAdmin {
  apiUrl: string;
  token: string;
  walletApiUrl?: string;
  walletToken?: string;
}

class AgentCardSandboxFloatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function activeStoredApiKey(config: AdminConfig): string | undefined {
  const activeKeyId = config.activeKeyId?.trim();
  if (!activeKeyId) return undefined;
  return config.storedKeys?.find((entry) => entry.id?.trim() === activeKeyId)?.key?.trim();
}

function usableCredentialToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  if (!value) return undefined;
  const expiration = credentialTokenExpiration(value);
  if (expiration !== undefined && expiration <= Math.floor(Date.now() / 1000)) return undefined;
  return value;
}

function credentialTokenExpiration(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    // API keys and nonstandard tokens are opaque credentials, not invalid JWTs.
    return undefined;
  }
}

function accessTokenNeedsRefresh(token: string | undefined): boolean {
  const value = token?.trim();
  if (!value) return false;
  const expiration = credentialTokenExpiration(value);
  return (
    expiration !== undefined &&
    expiration <= Math.floor(Date.now() / 1000) + REFRESH_EXPIRY_SKEW_SECONDS
  );
}

interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
}

export async function refreshAgentCardSession(
  apiUrl: string,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = REFRESH_TIMEOUT_MS
): Promise<RefreshedSession | undefined> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async () => {
    const response = await fetchImpl(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<RefreshedSession>;
    const accessToken = body.accessToken?.trim();
    const rotatedRefreshToken = body.refreshToken?.trim();
    if (!accessToken || !rotatedRefreshToken) return undefined;
    return { accessToken, refreshToken: rotatedRefreshToken };
  })().catch(() => undefined);
  try {
    const deadline = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
    });
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function persistCredentialConfig(filePath: string, config: CredentialConfig): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readCredentialConfig<T extends CredentialConfig>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

interface CredentialRefreshLockOwner {
  pid: number;
  hostname: string;
  nonce: string;
}

export function agentCardCredentialRefreshLockBudgets(refreshTimeoutMs: number): {
  waitMs: number;
  staleMs: number;
} {
  const completeRefreshBudgetMs = refreshTimeoutMs * 2 + REFRESH_LOCK_IO_MARGIN_MS;
  const waitMs = Math.max(MIN_REFRESH_LOCK_TIMEOUT_MS, completeRefreshBudgetMs);
  return { waitMs, staleMs: waitMs + REFRESH_LOCK_STALE_MARGIN_MS };
}

function parseCredentialRefreshLockOwner(value: string): CredentialRefreshLockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<CredentialRefreshLockOwner>;
    if (
      !Number.isInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.hostname !== 'string' ||
      owner.hostname === '' ||
      typeof owner.nonce !== 'string' ||
      owner.nonce === ''
    ) {
      return undefined;
    }
    return owner as CredentialRefreshLockOwner;
  } catch {
    return undefined;
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function releaseCredentialRefreshLock(
  lockPath: string,
  owner: CredentialRefreshLockOwner
): Promise<void> {
  const current = parseCredentialRefreshLockOwner(await readFile(lockPath, 'utf8').catch(() => ''));
  if (current?.nonce === owner.nonce) {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function recoverDeadCredentialRefreshLock(
  lockPath: string,
  staleMs: number
): Promise<boolean> {
  // Serializing recovery is essential: two waiters must not both approve an
  // old inode and let the second unlink the first waiter's replacement lock.
  // This tiny guard is deliberately never auto-recovered; a crash in this
  // millisecond-scale section fails closed instead of admitting two refreshes.
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryOwner: CredentialRefreshLockOwner = {
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
  };
  let recovery: Awaited<ReturnType<typeof open>>;
  try {
    recovery = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await recovery.writeFile(`${JSON.stringify(recoveryOwner)}\n`);
    await recovery.sync();
    const lockStat = await stat(lockPath).catch(() => undefined);
    if (lockStat === undefined || lockStat.mtimeMs >= Date.now() - staleMs) return false;
    const staleOwner = parseCredentialRefreshLockOwner(
      await readFile(lockPath, 'utf8').catch(() => '')
    );
    if (
      staleOwner === undefined ||
      staleOwner.hostname !== recoveryOwner.hostname ||
      localProcessIsAlive(staleOwner.pid)
    ) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } finally {
    await recovery.close();
    await releaseCredentialRefreshLock(recoveryPath, recoveryOwner);
  }
}

async function withCredentialRefreshLock<T>(
  lockPath: string,
  refreshTimeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  const budgets = agentCardCredentialRefreshLockBudgets(refreshTimeoutMs);
  const deadline = Date.now() + budgets.waitMs;
  const owner: CredentialRefreshLockOwner = {
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
  };
  while (true) {
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      try {
        await lock.writeFile(`${JSON.stringify(owner)}\n`);
        await lock.sync();
        return await operation();
      } finally {
        await lock.close();
        await releaseCredentialRefreshLock(lockPath, owner);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat !== undefined && lockStat.mtimeMs < Date.now() - budgets.staleMs) {
        if (await recoverDeadCredentialRefreshLock(lockPath, budgets.staleMs)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the AgentCard credential refresh lock');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function persistRefreshedCredentialConfig<T extends CredentialConfig>(
  filePath: string,
  current: T,
  usedRefreshToken: string,
  session: RefreshedSession
): Promise<T> {
  const latest = await readCredentialConfig(filePath, current);
  // An external CLI that does not use our lock may have won the rotation.
  // Never overwrite its newer credential snapshot with our stale read.
  if (latest.refreshToken?.trim() !== usedRefreshToken) return latest;
  const refreshed = { ...latest, ...session } as T;
  await persistCredentialConfig(filePath, refreshed);
  return refreshed;
}

async function refreshExpiredConfig<T extends AdminConfig | UserConfig>(
  filePath: string,
  config: T,
  apiUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<T> {
  const current = await readCredentialConfig(filePath, config);
  const refreshToken = current.refreshToken?.trim();
  if (!accessTokenNeedsRefresh(current.accessToken) || !refreshToken) return current;
  const session = await refreshAgentCardSession(apiUrl, refreshToken, fetchImpl, timeoutMs);
  if (!session) return readCredentialConfig(filePath, current);
  return persistRefreshedCredentialConfig(filePath, current, refreshToken, session);
}

async function refreshCredentialConfigs(params: {
  adminConfigPath: string;
  userConfigPath: string;
  refreshLockPath: string;
  adminConfig: AdminConfig;
  userConfig: UserConfig;
  adminApiUrl: string;
  walletApiUrl: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{ adminConfig: AdminConfig; userConfig: UserConfig }> {
  const {
    adminConfigPath,
    userConfigPath,
    refreshLockPath,
    adminApiUrl,
    walletApiUrl,
    fetchImpl,
    timeoutMs,
  } = params;
  if (
    !accessTokenNeedsRefresh(params.adminConfig.accessToken) &&
    !accessTokenNeedsRefresh(params.userConfig.accessToken)
  ) {
    return { adminConfig: params.adminConfig, userConfig: params.userConfig };
  }
  return withCredentialRefreshLock(refreshLockPath, timeoutMs, async () => {
    let adminConfig = await readCredentialConfig(adminConfigPath, params.adminConfig);
    let userConfig = await readCredentialConfig(userConfigPath, params.userConfig);
    const adminRefreshToken = adminConfig.refreshToken?.trim();
    const userRefreshToken = userConfig.refreshToken?.trim();
    const sharedRefreshToken =
      adminRefreshToken && adminRefreshToken === userRefreshToken ? adminRefreshToken : undefined;

    if (
      sharedRefreshToken !== undefined &&
      (accessTokenNeedsRefresh(adminConfig.accessToken) ||
        accessTokenNeedsRefresh(userConfig.accessToken))
    ) {
      const session = await refreshAgentCardSession(
        walletApiUrl,
        sharedRefreshToken,
        fetchImpl,
        timeoutMs
      );
      if (session !== undefined) {
        adminConfig = await persistRefreshedCredentialConfig(
          adminConfigPath,
          adminConfig,
          sharedRefreshToken,
          session
        );
        userConfig = await persistRefreshedCredentialConfig(
          userConfigPath,
          userConfig,
          sharedRefreshToken,
          session
        );
      } else {
        [adminConfig, userConfig] = await Promise.all([
          readCredentialConfig(adminConfigPath, adminConfig),
          readCredentialConfig(userConfigPath, userConfig),
        ]);
      }
      return { adminConfig, userConfig };
    }

    adminConfig = await refreshExpiredConfig(
      adminConfigPath,
      adminConfig,
      adminApiUrl,
      fetchImpl,
      timeoutMs
    );
    userConfig = await refreshExpiredConfig(
      userConfigPath,
      userConfig,
      walletApiUrl,
      fetchImpl,
      timeoutMs
    );
    return { adminConfig, userConfig };
  });
}

export function selectAgentCardBenchmarkAdminToken(
  config: AdminConfig,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return (
    usableCredentialToken(env.AGENT_CARDS_ADMIN_JWT) ||
    usableCredentialToken(config.accessToken) ||
    activeStoredApiKey(config) ||
    config.lastApiKey?.trim() ||
    usableCredentialToken(config.jwt)
  );
}

export function selectAgentCardBenchmarkWalletToken(
  userConfig: UserConfig,
  adminConfig: AdminConfig,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return (
    usableCredentialToken(env.AGENT_CARDS_JWT) ||
    usableCredentialToken(userConfig.accessToken) ||
    usableCredentialToken(userConfig.jwt) ||
    usableCredentialToken(env.AGENT_CARDS_ADMIN_JWT) ||
    usableCredentialToken(adminConfig.accessToken) ||
    usableCredentialToken(adminConfig.jwt)
  );
}

function asWalletResponse(value: unknown): WalletResponse {
  return typeof value === 'object' && value !== null ? (value as WalletResponse) : {};
}

function errorBodySummary(body: WalletResponse): string {
  const error = body as Record<string, unknown>;
  const value = error.error ?? error.message ?? error.code;
  return typeof value === 'string' && value.trim() !== '' ? `: ${value.slice(0, 200)}` : '';
}

async function adminRequest(
  admin: AgentCardBenchmarkAdmin,
  pathname: string,
  init: RequestInit,
  fetchImpl: FetchLike
): Promise<WalletResponse> {
  const response = await fetchImpl(`${admin.apiUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${admin.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const body = asWalletResponse(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new AgentCardSandboxFloatRequestError(
      `AgentCard sandbox float request ${pathname} failed with HTTP ${response.status}${errorBodySummary(body)}`,
      response.status
    );
  }
  return body;
}

interface LoadAgentCardBenchmarkAdminOptions {
  adminConfigPath?: string;
  userConfigPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  refreshTimeoutMs?: number;
  refreshLockPath?: string;
}

export async function loadAgentCardBenchmarkAdmin(
  options: LoadAgentCardBenchmarkAdminOptions = {}
): Promise<AgentCardBenchmarkAdmin> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
  const adminConfigPath =
    options.adminConfigPath ?? path.join(homedir(), '.agent-cards-admin.json');
  const userConfigPath = options.userConfigPath ?? path.join(homedir(), '.agent-cards/config.json');
  const refreshLockPath =
    options.refreshLockPath ?? path.join(homedir(), '.agent-cards-benchmark-refresh.lock');
  let adminConfig = await readCredentialConfig<AdminConfig>(adminConfigPath, {});
  let userConfig = await readCredentialConfig<UserConfig>(userConfigPath, {});
  const adminApiUrl =
    env.ADMIN_API_URL?.trim() || adminConfig.apiUrl?.trim() || DEFAULT_ADMIN_API_URL;
  const walletApiUrl = env.AGENT_CARDS_API_URL?.trim() || userConfig.apiUrl?.trim() || adminApiUrl;
  const refreshed = await refreshCredentialConfigs({
    adminConfigPath,
    userConfigPath,
    refreshLockPath,
    adminConfig,
    userConfig,
    adminApiUrl,
    walletApiUrl,
    fetchImpl,
    timeoutMs: refreshTimeoutMs,
  });
  adminConfig = refreshed.adminConfig;
  userConfig = refreshed.userConfig;
  const walletToken = selectAgentCardBenchmarkWalletToken(userConfig, adminConfig, env);
  const token = selectAgentCardBenchmarkAdminToken(adminConfig, env) || walletToken;
  if (!token) {
    throw new Error('AgentCard admin login required; run npx agent-cards login');
  }
  return {
    apiUrl: adminApiUrl,
    token,
    walletApiUrl,
    walletToken,
  };
}

export async function ensureAgentCardSandboxFloat(
  admin: AgentCardBenchmarkAdmin,
  orgId: string,
  targetCents = DEFAULT_SANDBOX_FLOAT_CENTS,
  fetchImpl: FetchLike = fetch
): Promise<{ previousCents: number; balanceCents: number; addedCents: number }> {
  const walletAdmin = {
    apiUrl: admin.walletApiUrl ?? admin.apiUrl,
    token: admin.walletToken ?? admin.token,
  };
  const wallet = await adminRequest(walletAdmin, `/orgs/${orgId}/wallet`, {}, fetchImpl);
  const previousCents = wallet.settings?.sandbox_balance_cents;
  if (!Number.isInteger(previousCents) || previousCents === undefined || previousCents < 0) {
    throw new Error('AgentCard wallet response omitted sandbox balance');
  }
  const addedCents = Math.max(0, targetCents - previousCents);
  if (addedCents === 0) return { previousCents, balanceCents: previousCents, addedCents };

  const funded = await adminRequest(
    walletAdmin,
    `/orgs/${orgId}/wallet/test-fund`,
    { method: 'POST', body: JSON.stringify({ amountCents: addedCents }) },
    fetchImpl
  );
  const balanceCents = funded.sandboxWalletBalanceCents;
  if (!Number.isInteger(balanceCents) || balanceCents === undefined) {
    throw new Error('AgentCard test-fund response omitted sandbox balance');
  }
  return { previousCents, balanceCents, addedCents };
}
