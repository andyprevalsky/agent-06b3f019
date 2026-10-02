import { retryWithBackoff } from '../../providers/retry';
import {
  createBrowserUseRecoverySession,
  getBrowserUseSessionHealth,
  listBrowserUseSessionFiles,
  readBrowserUseSessionFile,
  releaseBrowserUseRemoteSession,
} from '../../providers/browser/browserUse';
import { assert } from './browser-provider.helpers';

export async function runOptionalLiveBrowserUseProvider(): Promise<number> {
  let failed = 0;
  if (process.env.RUN_BROWSER_USE_LIVE === '1') {
    let session: Awaited<ReturnType<typeof createBrowserUseRecoverySession>> | null = null;
    try {
      session = await createBrowserUseRecoverySession({ country: 'US' });
      const health = await getBrowserUseSessionHealth(session.sessionId);
      assert(health.status === 'active', 'Browser Use live session did not become active');
      const context = session.validationBrowser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert((await page.title()) === 'Example Domain', 'Browser Use live CDP navigation failed');
      const downloadPage = await context.newPage();
      const cdp = await context.newCDPSession(downloadPage);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: '/tmp/downloads',
        eventsEnabled: true,
      });
      const downloaded = downloadPage.waitForEvent('download');
      await downloadPage
        .goto(
          'https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dbrowser-use-probe.txt&Content-Type=text%2Fplain',
          { waitUntil: 'commit', timeout: 20_000 }
        )
        .catch(() => {});
      await downloaded;
      const files = await retryWithBackoff(() => listBrowserUseSessionFiles(session.sessionId), {
        maxRetries: 20,
        fixedDelays: Array(19).fill(1_000),
        shouldRetryResult: (listed) =>
          !listed.some((file) => file.path.endsWith('browser-use-probe.txt')),
        component: 'Browser Use native download listing',
      });
      const file = files.find((item) => item.path.endsWith('browser-use-probe.txt'));
      assert(file !== undefined, `Browser Use did not list CDP download: ${JSON.stringify(files)}`);
      const downloadedBytes = await readBrowserUseSessionFile(session.sessionId, file.path);
      assert(downloadedBytes.length > 0, 'Browser Use download bytes are empty');
      const blobDownloaded = downloadPage.waitForEvent('download');
      await downloadPage.evaluate(() => {
        const url = URL.createObjectURL(new Blob(['browser-use-blob-proof']));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'browser-use-blob-proof.txt';
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
      });
      await blobDownloaded;
      const blobFiles = await retryWithBackoff(
        () => listBrowserUseSessionFiles(session.sessionId),
        {
          maxRetries: 20,
          fixedDelays: Array(19).fill(1_000),
          shouldRetryResult: (listed) =>
            !listed.some((file) => file.path.endsWith('browser-use-blob-proof.txt')),
          component: 'Browser Use Blob download listing',
        }
      );
      const blobFile = blobFiles.find((item) => item.path.endsWith('browser-use-blob-proof.txt'));
      assert(blobFile !== undefined, 'Browser Use did not list the browser-created Blob download');
      assert(
        (await readBrowserUseSessionFile(session.sessionId, blobFile.path)).toString() ===
          'browser-use-blob-proof',
        'Browser Use Blob download bytes did not survive'
      );
      await downloadPage.evaluate(
        'document.documentElement.insertAdjacentHTML(\'beforeend\', \'<input type="file" id="browser-use-upload-check">\')'
      );
      const document = await cdp.send('DOM.getDocument');
      const input = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#browser-use-upload-check',
      });
      assert(input.nodeId, 'Browser Use remote upload verification input unavailable');
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: input.nodeId,
        files: ['/tmp/downloads/browser-use-blob-proof.txt'],
      });
      const uploadedName = await downloadPage.evaluate(
        "document.querySelector('#browser-use-upload-check').files?.[0]?.name"
      );
      assert(uploadedName === 'browser-use-blob-proof.txt', 'Browser Use remote file path failed');

      // Exercise the production solveCaptchas session option against a real
      // verifier. A populated token alone can precede an unsolved image grid;
      // Google's submitted success page is the outcome that matters.
      await page.goto('https://www.google.com/recaptcha/api2/demo', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      const anchor = page.frameLocator('iframe[title="reCAPTCHA"]').locator('#recaptcha-anchor');
      try {
        await anchor.waitFor({ state: 'visible', timeout: 15_000 });
        if ((await anchor.getAttribute('aria-checked')) !== 'true') {
          const box = await anchor.boundingBox();
          assert(box, 'Browser Use reCAPTCHA checkbox has no visible bounds');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await page
          .frameLocator('iframe[title="reCAPTCHA"]')
          .locator('#recaptcha-anchor[aria-checked="true"]')
          .waitFor({ state: 'visible', timeout: 45_000 });
      } catch (error) {
        const snapshotPath = process.env.BROWSER_USE_LIVE_SCREENSHOT_PATH;
        if (snapshotPath) await page.screenshot({ path: snapshotPath }).catch(() => {});
        throw error;
      }
      const challengeFrame = page.locator('iframe[src*="/bframe"]');
      await challengeFrame.waitFor({ state: 'hidden', timeout: 30_000 });
      const verification = await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }),
        page
          .locator('form')
          .first()
          .evaluate((form: HTMLFormElement) => form.submit()),
      ]);
      assert(verification[0]?.ok(), 'Google reCAPTCHA demo did not return a successful response');
      assert(
        (await page.locator('body').innerText()).includes('Verification Success'),
        'Google reCAPTCHA demo rejected the solved challenge'
      );
      console.log(
        'PASS live Browser Use create, CDP, health, transfers, and reCAPTCHA verification'
      );
    } catch (error) {
      failed++;
      console.error(
        `FAIL live Browser Use provider: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (session) {
        await session.validationBrowser.close().catch(() => {});
        await releaseBrowserUseRemoteSession(session.sessionId).catch((error) => {
          failed++;
          console.error(`FAIL live Browser Use cleanup: ${String(error)}`);
        });
      }
    }
  }

  return failed;
}
