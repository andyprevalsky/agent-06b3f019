/**
 * Types for the generate-api-key domain.
 *
 * Structural types describing the subset of the Supabase SDK surface this
 * domain depends on, plus the request/response contracts for the handler.
 */

export interface SupabaseUser {
  id: string;
  [key: string]: unknown;
}

export interface SupabaseAuth {
  getUser(token: string): Promise<{
    data: { user: SupabaseUser | null };
    error: { message: string } | null;
  }>;
}

export interface SupabaseClient {
  auth: SupabaseAuth;
  from(table: string): unknown;
}

export type CreateClientFn = (url: string, key: string) => SupabaseClient;

/** Payload accepted by the edge function (after JSON parsing). */
export interface GenerateApiKeyRequestBody {
  name?: string | null;
}

/** Row returned by the RoseApiKey insert ... select('id, apiKey, createdAt'). */
export interface InsertedApiKeyRow {
  id: string;
  apiKey: string;
  createdAt: string;
}

/** Successful response shape emitted by the handler. */
export interface GenerateApiKeyResponseBody {
  apiKey: string;
  id: string;
  createdAt: string;
}

/** Typed error used to map business failures to HTTP responses. */
export class GenerateApiKeyError extends Error {
  public readonly status: number;
  public readonly details?: string;

  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = 'GenerateApiKeyError';
    this.status = status;
    this.details = details;
  }
}
