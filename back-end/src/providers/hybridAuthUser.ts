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

function hasPhone(phone: string | null): phone is string {
  return phone !== null && phone.trim() !== '';
}

async function syncExistingPhone(
  store: JwtUserStore,
  input: JwtUserInput,
  existing: JwtUserSnapshot
): Promise<void> {
  if (input.phone !== null && input.phone !== existing.phone) {
    await store.updatePhone(input.userId, input.phone);
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
 * being created. Tokens without a phone (anonymous sessions) are unaffected.
 */
export async function syncJwtUser(store: JwtUserStore, input: JwtUserInput): Promise<boolean> {
  const existing = await store.findUser(input.userId);
  if (existing !== null) {
    await syncExistingPhone(store, input, existing);
    return false;
  }

  if (hasPhone(input.phone)) {
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
    if (racedUser === null) throw error;
    await syncExistingPhone(store, input, racedUser);
    return false;
  }
}
