import { canonicalPhone } from './phoneAccountLookup';

export interface JwtUserSnapshot {
  phone: string | null;
}

export interface JwtUserInput {
  userId: string;
  isAnonymous: boolean;
  phone: string | null;
}

export interface JwtUserStore {
  findUser: (userId: string) => Promise<JwtUserSnapshot | null>;
  createUser: (input: JwtUserInput) => Promise<void>;
  updatePhone: (userId: string, phone: string) => Promise<void>;
  /** userId of the oldest account that owns this phone (+/no-plus forms), or null. */
  findPhoneOwner: (phone: string) => Promise<string | null>;
  isUniqueViolation: (error: unknown) => boolean;
}

export const PHONE_ACCOUNT_EXISTS_CODE = 'phone_account_exists';

/**
 * A valid token names a user we have never seen, but its phone already belongs
 * to another account. Creating a row would give one phone two accounts, so the
 * request is refused and the client must sign in again with phone OTP, which
 * resolves the phone to the existing account.
 */
export class PhoneAccountExistsError extends Error {
  readonly code = PHONE_ACCOUNT_EXISTS_CODE;

  constructor() {
    // Starts with "Unauthorized" so the web client's existing auth-failure
    // handling (login modal on send) treats it as a sign-in prompt.
    super(
      'Unauthorized: this phone number already belongs to another account. Sign in again with your phone number.'
    );
    this.name = 'PhoneAccountExistsError';
  }
}

async function syncExistingPhone(
  store: JwtUserStore,
  input: JwtUserInput,
  existing: JwtUserSnapshot
): Promise<void> {
  if (input.phone === null || input.phone === existing.phone) return;
  // Never move a phone onto this account while another account owns it; the
  // user stays signed in, the phone simply is not copied.
  const ownerId = await store.findPhoneOwner(input.phone);
  if (ownerId !== null && ownerId !== input.userId) return;
  try {
    await store.updatePhone(input.userId, input.phone);
  } catch (error) {
    // Another account claimed the phone after the owner check (unique index).
    if (!store.isUniqueViolation(error)) throw error;
  }
}

/**
 * Ensure a JWT-authenticated user exists without locking the same User row on
 * every read-only request. Most authenticated traffic is for an existing user,
 * so that path must remain a SELECT. Writes are reserved for first creation or
 * an actual phone change.
 *
 * Returns true only for the request that created the user. A concurrent create
 * winner is treated as an existing user so initial-credit side effects run once.
 *
 * One phone maps to one account: a new user whose token phone is already owned
 * by a different account is rejected with PhoneAccountExistsError instead of
 * being created, including when a concurrent request wins the unique phone
 * index. Tokens without a phone (anonymous sessions) store a NULL phone.
 */
export async function syncJwtUser(store: JwtUserStore, tokenInput: JwtUserInput): Promise<boolean> {
  // Stored phones are canonical `+digits`; a blank token phone is stored as NULL.
  const input: JwtUserInput = { ...tokenInput, phone: canonicalPhone(tokenInput.phone) };
  const existing = await store.findUser(input.userId);
  if (existing !== null) {
    await syncExistingPhone(store, input, existing);
    return false;
  }

  if (input.phone !== null) {
    const ownerId = await store.findPhoneOwner(input.phone);
    if (ownerId !== null && ownerId !== input.userId) {
      throw new PhoneAccountExistsError();
    }
  }

  try {
    await store.createUser(input);
    return true;
  } catch (error) {
    if (!store.isUniqueViolation(error)) throw error;

    const racedUser = await store.findUser(input.userId);
    if (racedUser !== null) {
      await syncExistingPhone(store, input, racedUser);
      return false;
    }
    // A concurrent request created a different account for this phone between
    // the owner check and the insert; the unique phone index refused this one.
    if (input.phone !== null) {
      const ownerId = await store.findPhoneOwner(input.phone);
      if (ownerId !== null && ownerId !== input.userId) throw new PhoneAccountExistsError();
    }
    throw error;
  }
}
