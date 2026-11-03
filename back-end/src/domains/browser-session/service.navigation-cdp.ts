import { chromium } from 'playwright';
import { steelCdpConnectionUrl } from '../../providers/steel/urls';

/** Root and confirmed-detached auth handoffs. Disconnect leaves the browser running. */
export async function navigateRootBrowser(
  wsUrl: string | null,
  action: 'back' | 'forward' | 'reload',
  deadline: number,
  checkBinding: () => Promise<void>
): Promise<string | null> {
  if (wsUrl === null || wsUrl === '') throw new Error('Live browser has no CDP connection');
  const remaining = () => Math.max(1, deadline - Date.now());
  const browser = await chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl), {
    timeout: remaining(),
  });
  const timer = setTimeout(() => {
    void browser.close().catch(() => undefined);
  }, remaining());
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const observations = await Promise.all(
      pages.map(async (page) => ({
        page,
        state: await page.evaluate<{ focused: boolean; visible: boolean }>(
          "({ focused: document.hasFocus(), visible: document.visibilityState === 'visible' })"
        ),
      }))
    );
    const focused = observations.filter((item) => item.state.focused);
    const visible = observations.filter((item) => item.state.visible);
    const page =
      focused.length === 1
        ? focused[0].page
        : visible.length === 1
          ? visible[0].page
          : pages.length === 1
            ? pages[0]
            : undefined;
    if (page === undefined) throw new Error('Unable to identify the foreground browser tab');
    await checkBinding();
    if (Date.now() >= deadline) throw new Error('Navigation deadline expired');
    const options = { timeout: remaining(), waitUntil: 'domcontentloaded' as const };
    if (action === 'back') await page.goBack(options);
    else if (action === 'forward') await page.goForward(options);
    else await page.reload(options);
    return page.url() || null;
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
