/**
 * API Keys Domain — Types
 *
 * Shared TypeScript interfaces for the list-api-keys edge function.
 * This layer imports nothing domain-specific; only external/provider types.
 */

export interface AuthUser {
  id: string;
  [key: string]: unknown;
}

export interface SupabaseClient {
  auth: {
    getUser(token: string): Promise<{
      data: { user: AuthUser | null };
      error: { message: string } | null;
    }>;
  };
  from(table: string): unknown;
}

export type CreateClientFn = (url: string, key: string) => SupabaseClient;

export interface ApiKeyRow {
  id: string;
  name: string | null;
  apiKey: string;
  createdAt: string;
}

export interface MaskedApiKey {
  id: string;
  name: string | null;
  createdAt: string;
  maskedApiKey: string;
}

export interface ListApiKeysSuccess {
  kind: 'ok';
  keys: MaskedApiKey[];
}

export interface ListApiKeysFailure {
  kind: 'error';
  status: number;
  error: string;
  details?: string;
}

export type ListApiKeysResult = ListApiKeysSuccess | ListApiKeysFailure;
