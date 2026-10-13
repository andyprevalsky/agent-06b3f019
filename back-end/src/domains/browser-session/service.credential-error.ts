import type { AuthOptionsResponse } from '../../providers/authOptionsTypes';
import type { SerializedPasskey, SerializedPassword } from './types';
import { serializePasskeys, serializePasswords } from './service.serializers';

export interface SessionCredentialPayload {
  auth_realm: string;
  auth_options: AuthOptionsResponse;
  passwords: SerializedPassword[];
  passkeys: SerializedPasskey[];
}

export function buildSessionCredentialPayload(
  auth_realm: string,
  auth_options: AuthOptionsResponse,
  passwords: Parameters<typeof serializePasswords>[0],
  passkeys: Parameters<typeof serializePasskeys>[0]
): SessionCredentialPayload {
  const enabledPasswordIds = new Set(
    auth_options.passwords.filter((password) => !password.disabled).map((password) => password.id)
  );
  const selectedPasswords = passwords.filter((password) => enabledPasswordIds.has(password.id));
  const returnedPasswordIds = new Set(selectedPasswords.map((password) => password.id));
  const missingPasswordIds = [...enabledPasswordIds].filter((id) => !returnedPasswordIds.has(id));

  const enabledPasskeyIds = new Set(
    auth_options.passkeys.filter((passkey) => !passkey.disabled).map((passkey) => passkey.id)
  );
  const returnedPasskeyIds = new Set(passkeys.map((passkey) => passkey.id));
  const missingPasskeyIds = [...enabledPasskeyIds].filter((id) => !returnedPasskeyIds.has(id));

  if (missingPasswordIds.length > 0 || missingPasskeyIds.length > 0) {
    throw new Error(
      `Credential payload incomplete for ${auth_realm}: ` +
        `missing passwords [${missingPasswordIds.join(', ')}], ` +
        `missing passkeys [${missingPasskeyIds.join(', ')}]`
    );
  }

  return {
    auth_realm,
    auth_options,
    passwords: serializePasswords(selectedPasswords),
    passkeys: serializePasskeys(passkeys),
  };
}

export async function preserveSessionCredentialPayload<T>(
  inject: () => Promise<T>,
  credentialPayload: SessionCredentialPayload
): Promise<T> {
  try {
    return await inject();
  } catch (error) {
    throw new SessionCredentialInjectionError(error, credentialPayload);
  }
}

export class SessionCredentialInjectionError extends Error {
  readonly code = 'BROWSER_CREDENTIAL_INJECTION_FAILED';
  readonly #credentialPayload: SessionCredentialPayload;

  constructor(cause: unknown, credentialPayload: SessionCredentialPayload) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SessionCredentialInjectionError';
    // Keep encrypted credential material out of ordinary Error inspection/logging.
    this.#credentialPayload = credentialPayload;
  }

  get credentialPayload(): SessionCredentialPayload {
    return this.#credentialPayload;
  }
}
