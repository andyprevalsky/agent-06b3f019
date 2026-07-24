import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_ADMIN_API_URL = 'https://api.agentcard.sh';
const DEFAULT_SANDBOX_FLOAT_CENTS = 50_000;

type FetchLike = typeof fetch;

interface AdminConfig {
  apiUrl?: string;
  accessToken?: string;
  jwt?: string;
  activeKeyId?: string;
  lastApiKey?: string;
  storedKeys?: Array<{ id?: string; key?: string }>;
}

interface UserConfig {
  apiUrl?: string;
  accessToken?: string;
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

export function selectAgentCardBenchmarkAdminToken(
  config: AdminConfig,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return (
    env.AGENT_CARDS_ADMIN_JWT?.trim() ||
    config.accessToken?.trim() ||
    activeStoredApiKey(config) ||
    config.lastApiKey?.trim() ||
    config.jwt?.trim()
  );
}

export function selectAgentCardBenchmarkWalletToken(
  userConfig: UserConfig,
  adminConfig: AdminConfig,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return (
    env.AGENT_CARDS_JWT?.trim() ||
    userConfig.accessToken?.trim() ||
    userConfig.jwt?.trim() ||
    env.AGENT_CARDS_ADMIN_JWT?.trim() ||
    adminConfig.accessToken?.trim() ||
    adminConfig.jwt?.trim()
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

async function readAdminConfig(configPath: string): Promise<AdminConfig> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as AdminConfig;
  } catch {
    return {};
  }
}

export async function loadAgentCardBenchmarkAdmin(
  homeDirectory = homedir()
): Promise<AgentCardBenchmarkAdmin> {
  const userConfig = (await readAdminConfig(
    path.join(homeDirectory, '.agent-cards', 'config.json')
  )) as UserConfig;
  const adminConfig = await readAdminConfig(path.join(homeDirectory, '.agent-cards-admin.json'));
  const unifiedFileToken = userConfig.accessToken?.trim() || userConfig.jwt?.trim();
  const walletToken = selectAgentCardBenchmarkWalletToken(userConfig, adminConfig);
  const token =
    process.env.AGENT_CARDS_JWT?.trim() ||
    process.env.AGENT_CARDS_ADMIN_JWT?.trim() ||
    unifiedFileToken ||
    selectAgentCardBenchmarkAdminToken(adminConfig, {}) ||
    walletToken;
  if (!token) {
    throw new Error('AgentCard admin login required; run npx agent-cards login');
  }
  return {
    apiUrl:
      process.env.AGENT_CARDS_API_URL?.trim() ||
      process.env.ADMIN_API_URL?.trim() ||
      userConfig.apiUrl?.trim() ||
      adminConfig.apiUrl?.trim() ||
      DEFAULT_ADMIN_API_URL,
    token,
    walletApiUrl:
      process.env.AGENT_CARDS_API_URL?.trim() ||
      userConfig.apiUrl?.trim() ||
      process.env.ADMIN_API_URL?.trim() ||
      adminConfig.apiUrl?.trim() ||
      DEFAULT_ADMIN_API_URL,
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
