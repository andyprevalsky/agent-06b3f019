/** Shared synthetic HTTP listener; unchanged ephemeral-loopback binding. */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
);

export interface ProviderCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  authorization?: string;
  idempotencyKey?: string;
}

export const SYNTHETIC_AUTH_LOSS_UNKNOWN = {
  status: 'unknown' as const,
  usage: {
    model: 'synthetic-auth-loss',
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    totalCostCents: 0,
  },
};

export interface Lease {
  id: string;
  status: string;
  queuePosition?: number | null;
  controlOwner?: string;
  [key: string]: unknown;
}
export interface ApiData extends Record<string, unknown> {
  lease?: Lease;
  operation?: { id: string; status: string; errorCode: string | null; result: unknown };
}
export interface ApiResult {
  status: number;
  data: ApiData;
  headers: Headers;
  bytes: Uint8Array;
}
