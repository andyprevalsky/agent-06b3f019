/**
 * Sign-ins are shared across providers (T82). A SteelSessionAuth on a
 * Tilion-default deployment is harvested once from its Steel profile into the
 * provider-neutral stores; the Steel session is released; the next run reuses
 * the migrated state without starting Steel; a failed harvest is typed.
 * DB-backed; only the Steel SDK and the CDP connect are faked.
 */
import nodeAssert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { steel } from '../../providers/steel/session';
import {
  shareSteelProfileSignIn,
  SteelProfileAuthMigrationError,
  STEEL_PROFILE_MIGRATION_SOURCE,
} from '../../providers/browser/steelProfileAuthMigration';
import { steelProfileForSelectedProvider } from '../../domains/browser-session/service.profile-binding';
import { buildTilionWorkerApplyPayload } from '../../domains/browser-session/service.worker-apply';

const REALM = `steelshare-${randomUUID().slice(0, 8)}.example`;
const PROFILE = `steel-profile-${randomUUID()}`;
const LIVE = Math.floor(Date.now() / 1000) + 3600;

function fakeSteelBrowser(cookies: Array<Record<string, unknown>>) {
  const frame = {
    url: () => `https://www.${REALM}/account`,
    evaluate: async () => ({
      origin: `https://www.${REALM}`,
      localStorage: [{ name: 'dd_session_hint', value: 'signed-in' }],
      indexedDB: [
        {
          name: 'app',
          version: 1,
          stores: [{ name: 'kv', keyPath: null, records: [{ key: 'k', value: 1 }] }],
        },
      ],
    }),
  };
  const page = { frames: () => [frame], goto: async () => null };
  const context = {
    storageState: async () => ({ cookies, origins: [] }),
    pages: () => [page],
    newPage: async () => page,
  };
  return { contexts: () => [context], close: async () => undefined };
}

async function withFakeSteel<T>(
  cookies: Array<Record<string, unknown>>,
  run: (calls: { created: string[]; released: string[] }) => Promise<T>,
  options: { connectFails?: boolean } = {}
): Promise<T> {
  const calls = { created: [] as string[], released: [] as string[] };
  const sessions = steel.sessions as unknown as Record<string, unknown>;
  const previous = {
    create: sessions.create,
    release: sessions.release,
    connect: chromium.connectOverCDP,
  };
  const previousKey = process.env.STEEL_API_KEY;
  process.env.STEEL_API_KEY = 'fake-steel-key';
  sessions.create = async (body: {
    sessionId: string;
    profileId: string;
    persistProfile: boolean;
  }) => {
    nodeAssert.equal(body.persistProfile, false, 'the harvest must not write the profile back');
    calls.created.push(body.sessionId);
    return { id: body.sessionId, profileId: body.profileId };
  };
  sessions.release = async (id: string) => {
    calls.released.push(id);
    return {};
  };
  chromium.connectOverCDP = (async () => {
    if (options.connectFails) throw new Error('connect refused');
    return fakeSteelBrowser(cookies);
  }) as unknown as typeof chromium.connectOverCDP;
  try {
    return await run(calls);
  } finally {
    sessions.create = previous.create;
    sessions.release = previous.release;
    chromium.connectOverCDP = previous.connect;
    if (previousKey === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = previousKey;
  }
}

async function withSteelBoundUser<T>(run: (userId: string) => Promise<T>): Promise<T> {
  const userId = `steel-share-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.steelSessionAuth.create({ data: { userId, contextId: PROFILE, authRealm: REALM } });
  try {
    return await run(userId);
  } finally {
    await prisma.indexedDBOrigin.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.cookieBundle.deleteMany({ where: { userId } });
    await prisma.steelSessionAuth.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

const SIGNED_IN_COOKIES = [
  {
    name: 'dd_session_id',
    value: 'secret',
    domain: `.${REALM}`,
    path: '/',
    expires: LIVE,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
];

export async function assertSteelBoundSignInIsSharedWithTilion(): Promise<void> {
  const previousProvider = process.env.BROWSER_PROVIDER;
  process.env.BROWSER_PROVIDER = 'tilion';
  process.env.TILION_API_KEY ||= 'fake-tilion-key';
  try {
    await withSteelBoundUser(async (userId) => {
      await withFakeSteel(SIGNED_IN_COOKIES, async (calls) => {
        // The run does not get forced onto Steel: no required Steel profile.
        const required = await steelProfileForSelectedProvider(
          userId,
          `https://www.${REALM}/`,
          PROFILE
        );
        nodeAssert.equal(required, null, 'a non-Steel provider must not be forced onto Steel');
        nodeAssert.equal(calls.created.length, 1, 'one harvest session on the bound profile');
        nodeAssert.deepEqual(
          calls.released,
          calls.created,
          'the harvest Steel session was released'
        );

        // The harvested sign-in is what the Tilion session gets injected.
        const { payload } = await buildTilionWorkerApplyPayload(userId, `https://www.${REALM}/`);
        nodeAssert.deepEqual(
          payload.cookies.map((c) => c.name),
          ['dd_session_id']
        );
        nodeAssert.deepEqual(payload.local_storage, [
          {
            origin: `https://www.${REALM}`,
            entries: [{ key: 'dd_session_hint', value: 'signed-in' }],
          },
        ]);
        const bundle = await prisma.cookieBundle.findFirstOrThrow({
          where: { userId, authRealm: REALM },
        });
        nodeAssert.equal(bundle.browserSource, STEEL_PROFILE_MIGRATION_SOURCE);
        const idb = await prisma.indexedDBOrigin.findFirstOrThrow({ where: { userId } });
        nodeAssert.equal(JSON.stringify(idb.databases).includes('objectStores'), true);
        // The binding stays enabled: a Steel-selected run is unchanged.
        const auth = await prisma.steelSessionAuth.findFirstOrThrow({ where: { userId } });
        nodeAssert.equal(auth.disabledAt, null);

        // Second run: migrated state reused, no Steel session.
        const second = await shareSteelProfileSignIn(userId, `https://www.${REALM}/`, 'tilion');
        nodeAssert.equal(second.status, 'already_migrated');
        nodeAssert.equal(calls.created.length, 1, 'the second run started Steel again');
      });
    });
  } finally {
    if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previousProvider;
  }
}

export async function assertSteelSignInShareFailsClosed(): Promise<void> {
  await withSteelBoundUser(async (userId) => {
    // Harvest failure: typed error, Steel session still released, nothing persisted.
    await withFakeSteel(
      SIGNED_IN_COOKIES,
      async (calls) => {
        await nodeAssert.rejects(
          shareSteelProfileSignIn(userId, `https://www.${REALM}/`, 'tilion'),
          SteelProfileAuthMigrationError
        );
        nodeAssert.deepEqual(
          calls.released,
          calls.created,
          'failed harvest leaked the Steel session'
        );
      },
      { connectFails: true }
    );
    // A profile without a signed-in cookie for the realm never claims authentication.
    await withFakeSteel(
      [
        {
          name: 'prefs',
          value: 'x',
          domain: `.${REALM}`,
          path: '/',
          expires: LIVE,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      async () => {
        await nodeAssert.rejects(
          shareSteelProfileSignIn(userId, `https://www.${REALM}/`, 'tilion'),
          /no signed-in cookie/
        );
      }
    );
    nodeAssert.equal(await prisma.cookieBundle.count({ where: { userId } }), 0);
    nodeAssert.equal(await prisma.localStorageOrigin.count({ where: { userId } }), 0);
    // Steel selected: unchanged, the bound profile is still required and nothing is harvested.
    const previousProvider = process.env.BROWSER_PROVIDER;
    const previousKey = process.env.STEEL_API_KEY;
    process.env.BROWSER_PROVIDER = 'steel';
    process.env.STEEL_API_KEY ||= 'fake-steel-key';
    try {
      let shared = 0;
      const required = await steelProfileForSelectedProvider(
        userId,
        `https://www.${REALM}/`,
        PROFILE,
        async () => {
          shared += 1;
          return { status: 'not_needed' };
        }
      );
      nodeAssert.equal(required, PROFILE);
      nodeAssert.equal(shared, 0);
    } finally {
      if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
      else process.env.BROWSER_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.STEEL_API_KEY;
      else process.env.STEEL_API_KEY = previousKey;
    }
  });
}

export const steelAuthShareCases: Array<[string, () => Promise<void>]> = [
  [
    'a Steel-bound sign-in is shared with Tilion once, then reused',
    assertSteelBoundSignInIsSharedWithTilion,
  ],
  [
    'sharing a Steel-bound sign-in fails closed and keeps Steel unchanged',
    assertSteelSignInShareFailsClosed,
  ],
];
