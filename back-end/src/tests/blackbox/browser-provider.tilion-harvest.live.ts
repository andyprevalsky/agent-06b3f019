/**
 * Live regression: a Tilion pause/replacement harvest keeps localStorage.
 *
 * The harvest is a fresh CDP client on a session another client drove, so
 * Playwright's storageState() alone returned origins=[] (lane E, 2026-10-21:
 * "Carried browser state into Tilion replacement ... cookies=1 origins=0").
 * Two live sessions, both released in finally. Opt in: RUN_TILION_HARVEST_LIVE=1.
 */
import { chromium } from 'playwright';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createTilionRecoverySession,
  releaseTilionRemoteSession,
} from '../../providers/browser/tilion';
import {
  harvestBrowserState,
  restoreTilionBrowserState,
} from '../../providers/browser/tilionState';
import { navigateKernelPage } from './browser-provider.helpers';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runLiveTilionHarvest(): Promise<number> {
  if (process.env.RUN_TILION_HARVEST_LIVE !== '1' || !process.env.TILION_API_KEY?.trim()) {
    console.log('SKIP live Tilion harvest regression (set RUN_TILION_HARVEST_LIVE=1)');
    return 0;
  }
  const created: string[] = [];
  try {
    const source = await createTilionRecoverySession(DEFAULT_GEOLOCATION);
    created.push(source.sessionId);
    // The "agent": drives the tab, writes localStorage, then detaches.
    const agent = source.validationBrowser ?? (await chromium.connectOverCDP(source.wsUrl));
    const page = agent.contexts()[0]?.pages()[0] ?? (await agent.contexts()[0]!.newPage());
    // Retries the known transient first-tunnel failures of a fresh residential exit.
    await navigateKernelPage(page, 'https://example.com/');
    await page.evaluate(() => localStorage.setItem('rose_tilion_harvest', 'kept'));
    await agent.close();

    const state = await harvestBrowserState({
      provider: 'tilion',
      sessionId: source.sessionId,
      wsUrl: null,
    });
    const origin = state?.origins.find((entry) => entry.origin === 'https://example.com');
    console.log(
      `live harvest: cookies=${state?.cookies.length ?? 'null'} origins=${state?.origins.length ?? 'null'} ` +
        `example.com keys=${origin?.localStorage.map((item) => item.name).join('|') ?? 'none'}`
    );
    assert(
      origin?.localStorage.some(
        (item) => item.name === 'rose_tilion_harvest' && item.value === 'kept'
      ),
      'Tilion harvest dropped localStorage (fresh client saw no origins)'
    );

    // The replacement (resume/rotation): restore into a new session and read it back.
    const replacement = await createTilionRecoverySession(DEFAULT_GEOLOCATION);
    created.push(replacement.sessionId);
    const browser =
      replacement.validationBrowser ?? (await chromium.connectOverCDP(replacement.wsUrl));
    try {
      const restored = await restoreTilionBrowserState(browser, state!);
      const target = browser.contexts()[0]!.pages()[0]!;
      await navigateKernelPage(target, 'https://example.com/');
      const value = await target.evaluate(() => localStorage.getItem('rose_tilion_harvest'));
      console.log(`live restore: origins=${restored.origins} rose_tilion_harvest=${String(value)}`);
      assert(value === 'kept', 'Tilion replacement lost the carried localStorage');
    } finally {
      await browser.close().catch(() => undefined);
    }
    console.log('PASS live Tilion harvest keeps localStorage across replacement');
    return 0;
  } catch (error) {
    console.error(
      `FAIL live Tilion harvest: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  } finally {
    for (const sessionId of created) {
      await releaseTilionRemoteSession(sessionId).catch((error: unknown) => {
        console.error(`FAIL release of live Tilion session ${sessionId}: ${String(error)}`);
      });
    }
    console.log(`released ${created.length} live Tilion session(s)`);
  }
}
