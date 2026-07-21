import assert from 'assert';
import {
  syncJwtUser,
  type JwtUserInput,
  type JwtUserSnapshot,
  type JwtUserStore,
} from '../../providers/hybridAuthUser';

const INPUT: JwtUserInput = {
  userId: 'user-1',
  isAnonymous: true,
  phone: null,
};

interface StoreCalls {
  finds: number;
  creates: number;
  phoneUpdates: string[];
}

function fakeStore(options?: { users?: Array<JwtUserSnapshot | null>; createError?: unknown }): {
  store: JwtUserStore;
  calls: StoreCalls;
} {
  const calls: StoreCalls = { finds: 0, creates: 0, phoneUpdates: [] };
  const users = [...(options?.users ?? [{ phone: null }])];
  const store: JwtUserStore = {
    async findUser() {
      calls.finds += 1;
      return users.shift() ?? null;
    },
    async createUser() {
      calls.creates += 1;
      if (options?.createError !== undefined) throw options.createError;
    },
    async updatePhone(_userId, phone) {
      calls.phoneUpdates.push(phone);
    },
    isUniqueViolation(error) {
      return error === options?.createError;
    },
  };
  return { store, calls };
}

async function testExistingUserIsReadOnly(): Promise<void> {
  const { store, calls } = fakeStore();
  const created = await syncJwtUser(store, INPUT);
  assert.equal(created, false);
  assert.deepEqual(calls, { finds: 1, creates: 0, phoneUpdates: [] });
}

async function testNewUserIsCreatedOnce(): Promise<void> {
  const { store, calls } = fakeStore({ users: [null] });
  const created = await syncJwtUser(store, INPUT);
  assert.equal(created, true);
  assert.deepEqual(calls, { finds: 1, creates: 1, phoneUpdates: [] });
}

async function testChangedPhoneIsTheOnlyExistingUserWrite(): Promise<void> {
  const { store, calls } = fakeStore({ users: [{ phone: '+15550000001' }] });
  const created = await syncJwtUser(store, { ...INPUT, phone: '+15550000002' });
  assert.equal(created, false);
  assert.deepEqual(calls, { finds: 1, creates: 0, phoneUpdates: ['+15550000002'] });
}

async function testConcurrentCreateWinnerDoesNotDuplicateNewUserEffects(): Promise<void> {
  const uniqueViolation = new Error('unique');
  const { store, calls } = fakeStore({
    users: [null, { phone: null }],
    createError: uniqueViolation,
  });
  const created = await syncJwtUser(store, INPUT);
  assert.equal(created, false);
  assert.deepEqual(calls, { finds: 2, creates: 1, phoneUpdates: [] });
}

async function testNonUniqueCreateErrorPropagates(): Promise<void> {
  const createError = new Error('database unavailable');
  const { store } = fakeStore({ users: [null], createError });
  store.isUniqueViolation = () => false;
  await assert.rejects(() => syncJwtUser(store, INPUT), createError);
}

async function main(): Promise<void> {
  await testExistingUserIsReadOnly();
  await testNewUserIsCreatedOnce();
  await testChangedPhoneIsTheOnlyExistingUserWrite();
  await testConcurrentCreateWinnerDoesNotDuplicateNewUserEffects();
  await testNonUniqueCreateErrorPropagates();
  process.stdout.write('hybrid auth user sync tests passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
