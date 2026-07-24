import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_ADMIN_API_URL = 'https://api.agentcard.sh';
const DEFAULT_SANDBOX_FLOAT_CENTS = 50_000;
const ADMIN_CONFIG_PATH = path.join(homedir(), '.agent-cards-admin.json');

type FetchLike = typeof fetch;

interface AdminConfig {
  apiUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  jwt?: string;
}

interface WalletResponse {
  settings?: { sandbox_balance_cents?: number };
  sandboxWalletBalanceCents?: number;
}

interface RefreshResponse {
  accessToken?: string;
  refreshToken?: string;
}

export interface AgentCardBenchmarkAdmin {
  apiUrl: string;
  token: string;
  refreshToken?: string;
  persistTokens?: (accessToken: string, refreshToken: string) => Promise<void>;
}

function asWalletResponse(value: unknown): WalletResponse {
  return typeof value === 'object' && value !== null ? (value as WalletResponse) : {};
}

function asRefreshResponse(value: unknown): RefreshResponse {
  return typeof value === 'object' && value !== null ? (value as RefreshResponse) : {};
}

async function refreshAdminSession(
  admin: AgentCardBenchmarkAdmin,
  fetchImpl: FetchLike
): Promise<boolean> {
  if (!admin.refreshToken) return false;
  const response = await fetchImpl(`${admin.apiUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: admin.refreshToken }),
  });
  if (!response.ok) return false;
  const body = asRefreshResponse(await response.json().catch(() => ({})));
  const accessToken = body.accessToken?.trim();
  const refreshToken = body.refreshToken?.trim();
  if (!accessToken || !refreshToken) return false;
  admin.token = accessToken;
  admin.refreshToken = refreshToken;
  await admin.persistTokens?.(accessToken, refreshToken);
  return true;
}

async function adminRequest(
  admin: AgentCardBenchmarkAdmin,
  pathname: string,
  init: RequestInit,
  fetchImpl: FetchLike
): Promise<WalletResponse> {
  const request = () =>
    fetchImpl(`${admin.apiUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${admin.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  let response = await request();
  if (response.status === 401 && (await refreshAdminSession(admin, fetchImpl))) {
    response = await request();
  }
  const body = asWalletResponse(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(`AgentCard sandbox float request failed with HTTP ${response.status}`);
  }
  return body;
}

export async function loadAgentCardBenchmarkAdmin(): Promise<AgentCardBenchmarkAdmin> {
  let config: AdminConfig = {};
  let configLoaded = false;
  try {
    config = JSON.parse(await readFile(ADMIN_CONFIG_PATH, 'utf8')) as AdminConfig;
    configLoaded = true;
  } catch {
    // The env token below supports CI and fresh developer machines.
  }
  const token =
    process.env.AGENT_CARDS_ADMIN_JWT?.trim() || config.accessToken?.trim() || config.jwt?.trim();
  if (!token) {
    throw new Error('AgentCard admin login required; run npx agent-cards-admin login');
  }
  return {
    apiUrl: process.env.ADMIN_API_URL?.trim() || config.apiUrl?.trim() || DEFAULT_ADMIN_API_URL,
    token,
    refreshToken:
      process.env.AGENT_CARDS_ADMIN_REFRESH_TOKEN?.trim() || config.refreshToken?.trim(),
    ...(configLoaded && {
      persistTokens: async (accessToken: string, refreshToken: string) => {
        let latest = config;
        try {
          latest = JSON.parse(await readFile(ADMIN_CONFIG_PATH, 'utf8')) as AdminConfig;
        } catch {
          // Preserve the successfully loaded snapshot if a concurrent read fails.
        }
        const next: AdminConfig = { ...latest, accessToken, refreshToken };
        delete next.jwt;
        const temporaryPath = `${ADMIN_CONFIG_PATH}.tmp-${process.pid}`;
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, ADMIN_CONFIG_PATH);
        await chmod(ADMIN_CONFIG_PATH, 0o600);
        config = next;
      },
    }),
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
