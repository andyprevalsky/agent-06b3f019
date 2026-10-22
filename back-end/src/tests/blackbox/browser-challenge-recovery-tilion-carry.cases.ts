/**
 * A Tilion run switching to Kernel or Steel carries the worker-captured state.
 * The backend cannot harvest a live Tilion session (one CDP client), so the
 * request's storage_state is the only copy of the tab's cookies/localStorage;
 * a non-Tilion replacement must restore it (lane E live: "Kernel switch lost
 * the carried Tilion localStorage"). Registered by browser-challenge-recovery.blackbox.ts.
 */
import { rotateBrowserProxy } from '../../providers/browserSessionResume';
import type { TilionCarriedState } from '../../providers/browser/tilion';
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
        // A Tilion replacement consumes the carry inside the Tilion adapter.
        assert(restores.length === 0, 'Tilion replacement restored the carry twice');
        const second = await rotate1();
        assert(second.provider === 'kernel', `rotation 2: ${second.provider}`);
        const third = await rotate1();
        assert(third.provider === 'steel', `rotation 3: ${third.provider}`);
        // A rotation that carries nothing restores nothing.
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
}
