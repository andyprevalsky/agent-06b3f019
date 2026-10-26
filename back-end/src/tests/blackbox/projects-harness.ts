/**
 * Shared HTTP helpers for the projects / project-workspace black-box suites.
 */
import { config } from 'dotenv';

config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const API_KEY = process.env.BACKEND_API_KEY || '';

export interface Res {
  status: number;
  data: Record<string, unknown>;
  text: string;
}

export interface Session {
  token: string;
  userId: string;
}

export async function call(
  path: string,
  init: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> } = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers };
  if (init.auth !== undefined) headers.Authorization = `Bearer ${init.auth}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, text };
}

export function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${res.status} ${res.text.slice(0, 400)}`);
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function anonymousSession(): Promise<Session> {
  const res = await call('/api/auth/anonymous', { method: 'POST' });
  expectStatus(res, 200, 'anonymous session');
  const data = res.data as { session: { access_token: string }; user: { id: string } };
  return { token: data.session.access_token, userId: data.user.id };
}

export function apiKeyHeaders(userId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': userId };
}
