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
}

interface WalletResponse {
  settings?: { sandbox_balance_cents?: number };
  sandboxWalletBalanceCents?: number;
}

export interface AgentCardBenchmarkAdmin {
  apiUrl: string;
  token: string;
}

function asWalletResponse(value: unknown): WalletResponse {
  return typeof value === 'object' && value !== null ? (value as WalletResponse) : {};
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
    throw new Error(`AgentCard sandbox float request failed with HTTP ${response.status}`);
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
  const config = await readAdminConfig(path.join(homeDirectory, '.agent-cards', 'config.json'));
  const legacyConfig = await readAdminConfig(path.join(homeDirectory, '.agent-cards-admin.json'));
  const token =
    process.env.AGENT_CARDS_JWT?.trim() ||
    process.env.AGENT_CARDS_ADMIN_JWT?.trim() ||
    config.accessToken?.trim() ||
    config.jwt?.trim() ||
    legacyConfig.accessToken?.trim() ||
    legacyConfig.jwt?.trim();
  if (!token) {
    throw new Error('AgentCard admin login required; run npx agent-cards login');
  }
  return {
    apiUrl:
      process.env.AGENT_CARDS_API_URL?.trim() ||
      process.env.ADMIN_API_URL?.trim() ||
      config.apiUrl?.trim() ||
      legacyConfig.apiUrl?.trim() ||
      DEFAULT_ADMIN_API_URL,
    token,
  };
}

export async function ensureAgentCardSandboxFloat(
  admin: AgentCardBenchmarkAdmin,
  orgId: string,
  targetCents = DEFAULT_SANDBOX_FLOAT_CENTS,
  fetchImpl: FetchLike = fetch
): Promise<{ previousCents: number; balanceCents: number; addedCents: number }> {
  const wallet = await adminRequest(admin, `/orgs/${orgId}/wallet`, {}, fetchImpl);
  const previousCents = wallet.settings?.sandbox_balance_cents;
  if (!Number.isInteger(previousCents) || previousCents === undefined || previousCents < 0) {
    throw new Error('AgentCard wallet response omitted sandbox balance');
  }
  const addedCents = Math.max(0, targetCents - previousCents);
  if (addedCents === 0) return { previousCents, balanceCents: previousCents, addedCents };

  const funded = await adminRequest(
    admin,
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
