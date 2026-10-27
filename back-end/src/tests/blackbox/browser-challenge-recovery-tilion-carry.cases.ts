/**
 * A Tilion run switching to Kernel or Steel carries the worker-captured state.
 * The backend cannot harvest a live Tilion session (one CDP client), so the
 * request's storage_state is the only copy of the tab's cookies/localStorage;
 * a non-Tilion replacement must restore it (lane E live: "Kernel switch lost
 * the carried Tilion localStorage"). Registered by browser-challenge-recovery.blackbox.ts.
 */
import { prisma } from '../../providers/database';
import { rotateBrowserProxy } from '../../providers/browserSessionResume';
import { TilionUncarriedStateError, type TilionCarriedState } from '../../providers/browser/tilion';
import {
  assert,
  fakeProviderOperations,
  seedRun,
  TILION_DEFAULT_ENV,
  withEnv,
  type RegisterTest,
} from './browser-challenge-recovery-tilion.support';

const WORKER_STATE: TilionCarriedState = {
  cookies: [
    {
      name: 'cart',
      value: 'three-items',
      domain: '.shop.example.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [
    {
      origin: 'https://shop.example.com',
      localStorage: [{ name: 'rose_tilion_parity', value: 'kept' }],
    },
  ],
};

export function registerTilionCarryCases(test: RegisterTest): void {
  async function testTilionSwitchToKernelAndSteelRestoresCarriedState(): Promise<void> {
    const run = await seedRun('tilion', 'residential');
    const fake = fakeProviderOperations();
    const restores: Array<{ provider: string; state: TilionCarriedState }> = [];
    let rowProvider = 'tilion';
    const rotate = fake.dependencies.rotateProxy;
    fake.dependencies.rotateProxy = async (taskId, step, options) => {
      const result = await rotate(taskId, step, options);
      rowProvider = step.provider;
      return result;
    };
    fake.dependencies.restoreCarriedState = async (_browser, state) => {
      restores.push({ provider: rowProvider, state });
      return { cookies: state.cookies.length, origins: 0 };
    };
    try {
      await withEnv(TILION_DEFAULT_ENV, async () => {
        const carry = { carriedState: WORKER_STATE };
        const rotate1 = () =>
          rotateBrowserProxy(run.session.id, run.owner.userId, undefined, carry, fake.dependencies);
        const first = await rotate1();
        assert(first.provider === 'tilion', `rotation 1: ${first.provider}`);
        const datacenter = await rotate1();
        assert(
          datacenter.provider === 'tilion' && datacenter.proxy_tier === 'direct',
          `rotation 2: ${datacenter.provider}/${datacenter.proxy_tier}`
        );
        // A Tilion replacement consumes the carry inside the Tilion adapter.
        assert(restores.length === 0, 'Tilion replacement restored the carry twice');
        const second = await rotate1();
        assert(second.provider === 'kernel', `rotation 3: ${second.provider}`);
        const third = await rotate1();
        assert(third.provider === 'steel', `rotation 4: ${third.provider}`);
        // A rotation that carries nothing restores nothing (budget reopened for one more).
        await prisma.browserSession.update({
          where: { id: run.session.id },
          data: { proxyRotationCount: 3 },
        });
        await rotateBrowserProxy(
          run.session.id,
          run.owner.userId,
          undefined,
          {},
          fake.dependencies
        );
      });
      assert(
        JSON.stringify(restores.map((restore) => restore.provider)) ===
          JSON.stringify(['kernel', 'steel']),
        `carried state restored on: ${JSON.stringify(restores.map((r) => r.provider))}`
      );
      assert(
        restores.every((restore) => restore.state === WORKER_STATE),
        'the replacement did not receive the worker-captured storage_state'
      );
      assert(
        JSON.stringify(fake.closedValidation) === JSON.stringify(fake.replacements),
        'validation clients left open after restoring the carry'
      );
    } finally {
      await run.cleanup();
    }
  }

  test(
    'a Tilion -> Kernel and -> Steel switch restores the worker-carried storage_state',
    testTilionSwitchToKernelAndSteelRestoresCarriedState
  );

  /** No request-level state: a live Tilion row cannot switch off Tilion; a paused one carries its snapshot. */
  async function testSwitchOffTilionFailsClosedLiveAndCarriesPausedSnapshot(): Promise<void> {
    const run = await seedRun('tilion', 'residential');
    const fake = fakeProviderOperations();
    const restored: TilionCarriedState[] = [];
    fake.dependencies.restoreCarriedState = async (_browser, state) => {
      restored.push(state);
      return { cookies: state.cookies.length, origins: 0 };
    };
    try {
      await withEnv(TILION_DEFAULT_ENV, async () => {
        const rotate = () =>
          rotateBrowserProxy(run.session.id, run.owner.userId, undefined, {}, fake.dependencies);
        assert((await rotate()).provider === 'tilion', 'rotation 1 stays on Tilion in place');
        assert((await rotate()).provider === 'tilion', 'rotation 2 is the Tilion datacenter exit');

        // Rotation 3 switches to Kernel while the Tilion browser is still live.
        fake.dependencies.tilionSessionLive = async () => true;
        let refused: unknown = null;
        await rotate().catch((error: unknown) => {
          refused = error;
        });
        assert(refused instanceof TilionUncarriedStateError, `live switch: ${String(refused)}`);
        const afterRefusal = await prisma.browserSession.findUniqueOrThrow({
          where: { id: run.session.id },
        });
        assert(afterRefusal.provider === 'tilion', 'refused switch replaced the browser');
        assert(afterRefusal.proxyRotationCount === 2, 'refused switch kept its rotation');

        // Paused: the durable snapshot is the state source for the Kernel replacement.
        await prisma.browserSession.update({
          where: { id: run.session.id },
          data: { status: 'PAUSED', pausedBrowserState: WORKER_STATE as unknown as object },
        });
        fake.dependencies.tilionSessionLive = async () => false;
        const switched = await rotate();
        assert(switched.provider === 'kernel', `paused switch: ${switched.provider}`);
        assert(
          restored.length === 1 &&
            restored[0]!.cookies[0]?.value === 'three-items' &&
            restored[0]!.origins[0]?.localStorage[0]?.value === 'kept',
          `paused snapshot not restored: ${JSON.stringify(restored)}`
        );
        const after = await prisma.browserSession.findUniqueOrThrow({
          where: { id: run.session.id },
        });
        assert(after.pausedBrowserState === null, 'consumed paused snapshot was not cleared');
      });
    } finally {
      await run.cleanup();
    }
  }

  test(
    'switching off Tilion fails closed while live and carries the paused snapshot',
    testSwitchOffTilionFailsClosedLiveAndCarriesPausedSnapshot
  );
}
