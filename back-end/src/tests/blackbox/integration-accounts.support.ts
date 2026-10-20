/** HTTP helpers + wire schemas for the integration-accounts blackbox domain. */
import { config } from 'dotenv';
import { z } from 'zod';
config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

export interface Session {
  token: string;
  userId: string;
}

export interface Res {
  status: number;
  data: Record<string, unknown>;
}

export async function call(
  path: string,
  init: RequestInit & { auth?: string; internalUserId?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.auth !== undefined) headers.Authorization = `Bearer ${init.auth}`;
  if (init.internalUserId !== undefined) {
    headers['X-API-Key'] = API_KEY;
    headers['X-User-Id'] = init.internalUserId;
  }
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

export async function anonymousSession(): Promise<Session> {
  const res = await call('/api/auth/anonymous', { method: 'POST' });
  expectStatus(res, 200, 'anonymous session');
  const data = res.data as { session: { access_token: string }; user: { id: string } };
  return { token: data.session.access_token, userId: data.user.id };
}

export function postProgress(
  token: string,
  provider: string,
  accountId: string,
  body: Record<string, unknown>
): Promise<Res> {
  return call(`/api/integrations/${provider}/accounts/${encodeURIComponent(accountId)}/progress`, {
    method: 'POST',
    auth: token,
    body: JSON.stringify(body),
  });
}

const nullableNumber = z.number().nullable();

/** The UI contract (syncAccountsContract.IntegrationAccount), strictly. */
export const AccountSchema = z
  .object({
    provider: z.string(),
    accountId: z.string().min(1),
    label: z.string().nullable(),
    state: z.enum(['idle', 'syncing', 'synced', 'failed', 'needs_reconnect']),
    progress: z
      .object({
        pct: nullableNumber,
        done: nullableNumber,
        total: nullableNumber,
        unit: z.string().nullable(),
        eta_sec: nullableNumber,
        phase: z.string().nullable(),
        startedAt: z.string().nullable(),
        updatedAt: z.string().nullable(),
      })
      .strict(),
    lastSyncAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();

export type Account = z.infer<typeof AccountSchema>;

export const ListResponse = z.object({
  integrations: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
        accountId: z.string(),
        status: z.string(),
        accounts: z.array(AccountSchema),
      })
      .passthrough()
  ),
  count: z.number(),
  authenticatedDomains: z.array(z.string()),
  accountsByProvider: z.record(z.array(AccountSchema)),
});

export const DeltaResponse = z
  .object({
    cursor: z.string(),
    changed: z.boolean(),
    accountsByProvider: z.record(z.array(AccountSchema)).optional(),
  })
  .strict();

/** All accounts of one provider from GET /api/integrations (schema-checked). */
export async function accountsOf(token: string, provider: string): Promise<Account[]> {
  const res = await call('/api/integrations', { auth: token });
  expectStatus(res, 200, 'GET /api/integrations');
  return ListResponse.parse(res.data).accountsByProvider[provider] ?? [];
}
