import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { navigateRootBrowser } from '../../domains/browser-session/service.navigation-cdp';

async function run() {
  const server = await chromium.launchServer({
    headless: true,
    args: ['--no-sandbox', '--enable-automation', '--remote-debugging-port=0'],
  });
  // launchServer exposes Playwright, so obtain Chromium's own browser CDP endpoint.
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('data:text/html,<title>first</title>');
    await page.goto('data:text/html,<title>second</title>');
    const root = await browser.newBrowserCDPSession();
    const info = await root.send('Browser.getBrowserCommandLine');
    // Read the ephemeral devtools endpoint from Chromium's user-data-dir.
    const dir = info.arguments
      .find((arg: string) => arg.startsWith('--user-data-dir='))!
      .slice('--user-data-dir='.length);
    const { readFile } = await import('node:fs/promises');
    const [port, path] = (await readFile(`${dir}/DevToolsActivePort`, 'utf8')).trim().split('\n');
    let checks = 0;
    const check = async () => {
      checks++;
    };
    const ws = `ws://127.0.0.1:${port}${path}`;
    assert.ok(
      (await navigateRootBrowser(ws, 'back', Date.now() + 10000, check))?.includes('first')
    );
    assert.ok(
      (await navigateRootBrowser(ws, 'forward', Date.now() + 10000, check))?.includes('second')
    );
    assert.equal(await page.title(), 'second', 'remote browser stays alive after disconnect');
    assert.equal(checks, 2);
    const background = await context.newPage();
    await background.goto('data:text/html,<title>background</title>');
    await assert.rejects(navigateRootBrowser(ws, 'back', Date.now() + 10000, check), /foreground/);
    assert.equal(
      await background.title(),
      'background',
      'ambiguous focus must not navigate an arbitrary tab'
    );
    process.stdout.write('PASS Root CDP actual back/forward and remote browser preservation');
  } finally {
    await browser.close();
    await server.close();
  }
}
run().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
