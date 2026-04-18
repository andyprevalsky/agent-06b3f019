/**
 * Types for the delete-api-key domain.
 *
 * Includes the narrow Supabase client interface used by the repo/service,
 * the factory signature, and typed arg/result types used between layers.
 */

export interface SupabaseAuthUser {
  id: string;
  [key: string]: unknown;
}

export interface SupabaseGetUserResult {
  data: { user: SupabaseAuthUser | null };
  error: { message: string } | null;
}

export interface SupabaseClient {
  auth: {
    getUser(token: string): Promise<SupabaseGetUserResult>;
  };
  from(table: string): unknown;
}

export type CreateClientFn = (url: string, key: string) => SupabaseClient;

/** Args for the repo-layer delete operation. */
export interface DeleteApiKeyRepoArgs {
  supabase: SupabaseClient;
  keyId: string;
  userId: string;
}

/** Result of the repo-layer delete operation. */
export interface DeleteApiKeyRepoResult {
  error: { message: string } | null;
}

/** Args for the service-layer delete operation. */
export interface DeleteApiKeyServiceArgs {
  supabase: SupabaseClient;
  token: string;
  keyId: string;
}

/** Success result of the service-layer delete operation. */
export interface DeleteApiKeyServiceResult {
  success: true;
  message: string;
}

/** Error codes surfaced by the service layer, mapped to HTTP status in the handler. */
export type DeleteApiKeyErrorCode =
  | 'unauthorized'
  | 'missing_key_id'
  | 'db_error';

/** Typed error thrown by the service layer. */
export class DeleteApiKeyError extends Error {
  public readonly code: DeleteApiKeyErrorCode;
  public readonly details?: string;

  public constructor(code: DeleteApiKeyErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'DeleteApiKeyError';
    this.code = code;
    this.details = details;
  }
}
