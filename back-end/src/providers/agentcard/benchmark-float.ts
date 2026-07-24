import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_ADMIN_API_URL = 'https://api.agentcard.sh';
const DEFAULT_SANDBOX_FLOAT_CENTS = 50_000;

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
  const segments = value.split('.');
  if (segments.length !== 3) return value;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000)) {
      return undefined;
    }
  } catch {
    // API keys and nonstandard tokens are opaque credentials, not invalid JWTs.
  }
  return value;
}

function accessTokenNeedsRefresh(token: string | undefined): boolean {
  const value = token?.trim();
  return Boolean(value && usableCredentialToken(value) === undefined);
}

interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
}

export async function refreshAgentCardSession(
  apiUrl: string,
  refreshToken: string,
  fetchImpl: FetchLike = fetch
): Promise<RefreshedSession | undefined> {
  try {
    const response = await fetchImpl(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<RefreshedSession>;
    const accessToken = body.accessToken?.trim();
    const rotatedRefreshToken = body.refreshToken?.trim();
    if (!accessToken || !rotatedRefreshToken) return undefined;
    return { accessToken, refreshToken: rotatedRefreshToken };
  } catch {
    return undefined;
  }
}

async function persistCredentialConfig(
  filePath: string,
  config: AdminConfig | UserConfig
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function refreshExpiredConfig<T extends AdminConfig | UserConfig>(
  filePath: string,
  config: T,
  apiUrl: string
): Promise<T> {
  if (!accessTokenNeedsRefresh(config.accessToken) || !config.refreshToken?.trim()) return config;
  const session = await refreshAgentCardSession(apiUrl, config.refreshToken);
  if (!session) return config;
  const refreshed = { ...config, ...session };
  await persistCredentialConfig(filePath, refreshed);
  return refreshed;
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

export async function loadAgentCardBenchmarkAdmin(): Promise<AgentCardBenchmarkAdmin> {
  let adminConfig: AdminConfig = {};
  let userConfig: UserConfig = {};
  const adminConfigPath = path.join(homedir(), '.agent-cards-admin.json');
  const userConfigPath = path.join(homedir(), '.agent-cards/config.json');
  try {
    adminConfig = JSON.parse(await readFile(adminConfigPath, 'utf8')) as AdminConfig;
  } catch {
    // The env token below supports CI and fresh developer machines.
  }
  try {
    userConfig = JSON.parse(await readFile(userConfigPath, 'utf8')) as UserConfig;
  } catch {
    // The legacy admin config remains enough for older local setups.
  }
  const adminApiUrl =
    process.env.ADMIN_API_URL?.trim() || adminConfig.apiUrl?.trim() || DEFAULT_ADMIN_API_URL;
  const walletApiUrl =
    process.env.AGENT_CARDS_API_URL?.trim() || userConfig.apiUrl?.trim() || adminApiUrl;
  adminConfig = await refreshExpiredConfig(adminConfigPath, adminConfig, adminApiUrl);
  userConfig = await refreshExpiredConfig(userConfigPath, userConfig, walletApiUrl);
  const walletToken = selectAgentCardBenchmarkWalletToken(userConfig, adminConfig);
  const token = selectAgentCardBenchmarkAdminToken(adminConfig) || walletToken;
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
