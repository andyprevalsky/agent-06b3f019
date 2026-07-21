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
  isUniqueViolation: (error: unknown) => boolean;
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
 */
export async function syncJwtUser(store: JwtUserStore, input: JwtUserInput): Promise<boolean> {
  const existing = await store.findUser(input.userId);
  if (existing !== null) {
    await syncExistingPhone(store, input, existing);
    return false;
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
