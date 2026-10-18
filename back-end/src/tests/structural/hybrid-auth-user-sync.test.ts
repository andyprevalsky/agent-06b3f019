import assert from 'assert';
import {
  PHONE_ACCOUNT_EXISTS_CODE,
  PhoneAccountExistsError,
  syncJwtUser,
  type JwtUserInput,
  type JwtUserSnapshot,
  type JwtUserStore,
} from '../../providers/hybridAuthUser';
import {
  canonicalPhone,
  isUniqueViolation,
  phoneLookupVariants,
} from '../../providers/phoneAccountLookup';

const INPUT: JwtUserInput = {
  userId: 'user-1',
  isAnonymous: true,
  phone: null,
};

interface StoreCalls {
  finds: number;
  creates: number;
  phoneUpdates: string[];
  ownerLookups?: string[];
  createdPhones?: Array<string | null>;
}

function fakeStore(options?: {
  users?: Array<JwtUserSnapshot | null>;
  createError?: unknown;
  updateError?: unknown;
  phoneOwner?: string | null;
}): {
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
    async createUser(input) {
      calls.creates += 1;
      if (options?.createError !== undefined) throw options.createError;
      calls.createdPhones = [...(calls.createdPhones ?? []), input.phone];
    },
    async updatePhone(_userId, phone) {
      calls.phoneUpdates.push(phone);
      if (options?.updateError !== undefined) throw options.updateError;
    },
    async findPhoneOwner(phone) {
      calls.ownerLookups = [...(calls.ownerLookups ?? []), phone];
      return options?.phoneOwner ?? null;
    },
    isUniqueViolation(error) {
      return (
        error !== undefined && (error === options?.createError || error === options?.updateError)
      );
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
  assert.deepEqual(calls, { finds: 1, creates: 1, phoneUpdates: [], createdPhones: [null] });
}

async function testChangedPhoneIsTheOnlyExistingUserWrite(): Promise<void> {
  const { store, calls } = fakeStore({ users: [{ phone: '+15550000001' }] });
  const created = await syncJwtUser(store, { ...INPUT, phone: '+15550000002' });
  assert.equal(created, false);
  assert.deepEqual(calls, {
    finds: 1,
    creates: 0,
    phoneUpdates: ['+15550000002'],
    ownerLookups: ['+15550000002'],
  });
}

async function testPhoneOwnedElsewhereIsNotCopiedToExistingUser(): Promise<void> {
  const { store, calls } = fakeStore({
    users: [{ phone: '+15550000001' }],
    phoneOwner: 'user-oldest',
  });
  const created = await syncJwtUser(store, { ...INPUT, phone: '+15550000002' });
  assert.equal(created, false, 'existing user stays signed in');
  assert.deepEqual(calls.phoneUpdates, [], 'a phone owned by another account is never copied');
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

const PHONE_INPUT: JwtUserInput = { userId: 'user-new', isAnonymous: false, phone: '19729777432' };

async function testNewPhoneCreatesAccount(): Promise<void> {
  const { store, calls } = fakeStore({ users: [null], phoneOwner: null });
  const created = await syncJwtUser(store, PHONE_INPUT);
  assert.equal(created, true);
  assert.deepEqual(calls, {
    finds: 1,
    creates: 1,
    phoneUpdates: [],
    ownerLookups: ['+19729777432'],
    createdPhones: ['+19729777432'],
  });
}

async function testOwnedPhoneRejectsNewAccountWithoutCreating(): Promise<void> {
  const { store, calls } = fakeStore({ users: [null], phoneOwner: 'user-oldest' });
  await assert.rejects(
    () => syncJwtUser(store, PHONE_INPUT),
    (error: unknown) =>
      error instanceof PhoneAccountExistsError && error.code === PHONE_ACCOUNT_EXISTS_CODE
  );
  assert.equal(calls.creates, 0, 'an owned phone must never create a second account');
}

async function testOwnPhoneOwnershipDoesNotReject(): Promise<void> {
  const { store, calls } = fakeStore({ users: [null], phoneOwner: PHONE_INPUT.userId });
  const created = await syncJwtUser(store, PHONE_INPUT);
  assert.equal(created, true);
  assert.equal(calls.creates, 1);
}

async function testExistingUserSkipsPhoneOwnerLookup(): Promise<void> {
  const { store, calls } = fakeStore({
    users: [{ phone: '+19729777432' }],
    phoneOwner: 'user-oldest',
  });
  const created = await syncJwtUser(store, { ...PHONE_INPUT, phone: '+19729777432' });
  assert.equal(created, false);
  assert.equal(calls.ownerLookups, undefined, 'existing users stay a single read');
}

async function testPhonelessTokensSkipOwnerLookup(): Promise<void> {
  for (const phone of [null, '', '   ']) {
    const { store, calls } = fakeStore({ users: [null], phoneOwner: 'user-oldest' });
    const created = await syncJwtUser(store, { ...INPUT, phone });
    assert.equal(created, true, `anonymous token with phone=${JSON.stringify(phone)} creates`);
    assert.equal(calls.ownerLookups, undefined);
    // A blank phone is stored as NULL so anonymous accounts never collide on
    // the unique User.phone index.
    assert.deepEqual(calls.createdPhones, [null], `phone=${JSON.stringify(phone)} stores NULL`);
  }
}

async function testSupabaseBarePhoneMatchesStoredCanonicalPhone(): Promise<void> {
  // Supabase phone claims omit '+'; the stored canonical form has it. Same
  // number, so an existing user's request stays a single read.
  const { store, calls } = fakeStore({ users: [{ phone: '+19729777432' }] });
  const created = await syncJwtUser(store, { ...PHONE_INPUT, phone: '19729777432' });
  assert.equal(created, false);
  assert.deepEqual(calls, { finds: 1, creates: 0, phoneUpdates: [] });
}

async function testCreateRaceLostToAnotherAccountIsPhoneAccountExists(): Promise<void> {
  // Owner check saw no owner, then a concurrent request created a different
  // account with this phone and the unique index refused this insert.
  const uniqueViolation = new Error('unique phone');
  let ownerLookups = 0;
  const { store, calls } = fakeStore({ users: [null, null], createError: uniqueViolation });
  store.findPhoneOwner = async () => (ownerLookups++ === 0 ? null : 'user-winner');
  await assert.rejects(
    () => syncJwtUser(store, PHONE_INPUT),
    (error: unknown) => error instanceof PhoneAccountExistsError
  );
  assert.equal(calls.creates, 1);
  assert.equal(ownerLookups, 2, 'the owner is re-read after the unique violation');
}

async function testCreateUniqueViolationWithoutAnyOwnerPropagates(): Promise<void> {
  const uniqueViolation = new Error('unique, but no row is visible');
  const { store } = fakeStore({ users: [null, null], createError: uniqueViolation });
  await assert.rejects(() => syncJwtUser(store, PHONE_INPUT), uniqueViolation);
}

async function testPhoneClaimedDuringExistingUserUpdateKeepsSession(): Promise<void> {
  const updateError = new Error('unique phone on update');
  const { store, calls } = fakeStore({ users: [{ phone: null }], updateError });
  const created = await syncJwtUser(store, { ...INPUT, phone: '+15550000003' });
  assert.equal(created, false, 'the user stays signed in; the phone is simply not copied');
  assert.deepEqual(calls.phoneUpdates, ['+15550000003']);
}

async function testExistingUserUpdateNonUniqueErrorPropagates(): Promise<void> {
  const updateError = new Error('database unavailable');
  const { store } = fakeStore({ users: [{ phone: null }], updateError });
  store.isUniqueViolation = () => false;
  await assert.rejects(() => syncJwtUser(store, { ...INPUT, phone: '+15550000004' }), updateError);
}

function testCanonicalPhoneIsTheStoredForm(): void {
  for (const input of ['+19729777432', '19729777432', '+1 (972) 977-7432', '0019729777432']) {
    assert.equal(canonicalPhone(input), '+19729777432', `canonical form of ${input}`);
  }
  for (const blank of [null, undefined, '', '   ', '()']) {
    assert.equal(canonicalPhone(blank), null, `blank ${JSON.stringify(blank)} stores NULL`);
  }
  assert.equal(isUniqueViolation({ code: 'P2002' }), true);
  assert.equal(isUniqueViolation({ code: 'P2025' }), false);
  assert.equal(isUniqueViolation(null), false);
}

function testPhoneVariantsCoverEveryStoredForm(): void {
  const expected = ['+19729777432', '19729777432'];
  for (const input of ['+19729777432', '19729777432', '0019729777432', '+0019729777432']) {
    assert.deepEqual(phoneLookupVariants(input), expected, `variants for ${input}`);
  }
  assert.deepEqual(phoneLookupVariants('+1 (972) 977-7432'), expected);
  assert.equal(phoneLookupVariants(''), null);
  assert.equal(phoneLookupVariants('()'), null);
}

async function main(): Promise<void> {
  testPhoneVariantsCoverEveryStoredForm();
  testCanonicalPhoneIsTheStoredForm();
  await testExistingUserIsReadOnly();
  await testNewUserIsCreatedOnce();
  await testChangedPhoneIsTheOnlyExistingUserWrite();
  await testPhoneOwnedElsewhereIsNotCopiedToExistingUser();
  await testConcurrentCreateWinnerDoesNotDuplicateNewUserEffects();
  await testNonUniqueCreateErrorPropagates();
  await testNewPhoneCreatesAccount();
  await testOwnedPhoneRejectsNewAccountWithoutCreating();
  await testOwnPhoneOwnershipDoesNotReject();
  await testExistingUserSkipsPhoneOwnerLookup();
  await testPhonelessTokensSkipOwnerLookup();
  await testSupabaseBarePhoneMatchesStoredCanonicalPhone();
  await testCreateRaceLostToAnotherAccountIsPhoneAccountExists();
  await testCreateUniqueViolationWithoutAnyOwnerPropagates();
  await testPhoneClaimedDuringExistingUserUpdateKeepsSession();
  await testExistingUserUpdateNonUniqueErrorPropagates();
  process.stdout.write('hybrid auth user sync tests passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
