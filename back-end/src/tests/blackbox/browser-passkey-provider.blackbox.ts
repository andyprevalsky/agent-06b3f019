#!/usr/bin/env tsx
/** Live CDP WebAuthn transfer: one Kernel passkey signs in on Steel, Tilion and Browser Use. */
import { randomUUID } from 'node:crypto';
import type { Browser, CDPSession, Page } from 'playwright';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createKernelRecoverySession,
  releaseKernelRemoteSession,
} from '../../providers/browser/kernel';
import { createSteelRecoverySession } from '../../providers/steel/sessionRecovery';
import { releaseSteelRemoteSession } from '../../providers/steel/session';
import {
  createBrowserUseRecoverySession,
  releaseBrowserUseRemoteSession,
} from '../../providers/browser/browserUse';
import {
  createTilionRecoverySession,
  releaseTilionRemoteSession,
} from '../../providers/browser/tilion';

type Credential = {
  credentialId: string;
  privateKey: string;
  rpId: string;
  signCount: number;
  isResidentCredential: boolean;
  userHandle?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function pageAndCdp(browser: Browser): Promise<{ page: Page; cdp: CDPSession }> {
  const context = browser.contexts()[0];
  assert(context, 'Provider CDP connection has no browser context');
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  assert((await page.title()) === 'Example Domain', 'WebAuthn test origin did not load');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  return { page, cdp };
}

async function addAuthenticator(cdp: CDPSession): Promise<string> {
  const result = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  assert(result.authenticatorId, 'Provider did not return a WebAuthn authenticator id');
  return result.authenticatorId;
}

async function register(browser: Browser): Promise<Credential> {
  const { page, cdp } = await pageAndCdp(browser);
  const authenticatorId = await addAuthenticator(cdp);
  const rawId = await page.evaluate(async () => {
    const created = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: 'example.com', name: 'Rose passkey provider test' },
        user: { id: new TextEncoder().encode('rose-test-user'), name: 'rose', displayName: 'Rose' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
      },
    });
    if (!created) throw new Error('WebAuthn registration returned no credential');
    return Array.from(new Uint8Array(created.rawId));
  });
  const stored = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const credential = stored.credentials.find((item) =>
    Buffer.from(item.credentialId, 'base64').equals(Buffer.from(rawId))
  );
  assert(credential?.privateKey, 'Kernel did not export the created passkey');
  assert(credential.rpId === 'example.com', 'Kernel registered the wrong relying party');
  return credential as Credential;
}

async function assertTransferredPasskey(
  provider: string,
  browser: Browser,
  key: Credential
): Promise<void> {
  const { page, cdp } = await pageAndCdp(browser);
  const authenticatorId = await addAuthenticator(cdp);
  if (provider === 'Browser Use') {
    const capabilities = await page.evaluate(async () => ({
      secure: isSecureContext,
      createAllowed: document.featurePolicy?.allowsFeature('publickey-credentials-create'),
      getAllowed: document.featurePolicy?.allowsFeature('publickey-credentials-get'),
      platformAvailable: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    }));
    console.log(`Browser Use WebAuthn capabilities: ${JSON.stringify(capabilities)}`);
  }
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: key });
  const before = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert(before.credentials.length === 1, `${provider} did not retain the transferred passkey`);
  const rawId = Array.from(Buffer.from(key.credentialId, 'base64'));
  let assertion: number[];
  try {
    await page.evaluate((id) => {
      const button = document.createElement('button');
      button.id = 'rose-passkey-sign-in';
      button.textContent = 'Sign in with passkey';
      button.onclick = async () => {
        try {
          const signed = await navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rpId: 'example.com',
              allowCredentials: [{ type: 'public-key', id: new Uint8Array(id) }],
              userVerification: 'required',
            },
          });
          if (!signed) throw new Error('WebAuthn assertion returned no credential');
          button.dataset.result = JSON.stringify(Array.from(new Uint8Array(signed.rawId)));
        } catch (cause) {
          button.dataset.error =
            cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        }
      };
      document.body.appendChild(button);
    }, rawId);
    await page.locator('#rose-passkey-sign-in').click();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('#rose-passkey-sign-in');
      return Boolean(button?.dataset.result || button?.dataset.error);
    });
    const outcome = await page.locator('#rose-passkey-sign-in').evaluate((button) => ({
      result: (button as HTMLButtonElement).dataset.result,
      error: (button as HTMLButtonElement).dataset.error,
    }));
    if (outcome.error) throw new Error(outcome.error);
    assert(outcome.result, 'WebAuthn assertion produced no result');
    assertion = JSON.parse(outcome.result) as number[];
  } catch (error) {
    const afterFailure = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    const diagnostic = await page.evaluate(async () => {
      try {
        const created = await navigator.credentials.create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { id: 'example.com', name: 'Rose passkey diagnostic' },
            user: { id: new TextEncoder().encode('rose-diag'), name: 'diag', displayName: 'Diag' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: {
              authenticatorAttachment: 'platform',
              userVerification: 'required',
            },
          },
        });
        return created ? 'registration succeeded' : 'registration returned null';
      } catch (cause) {
        return `registration failed: ${cause instanceof Error ? cause.name + ': ' + cause.message : String(cause)}`;
      }
    });
    console.log(
      `${provider} WebAuthn diagnostic: url=${page.url()} browser=${browser.version()} ` +
        `credentialCount=${afterFailure.credentials.length} signCount=${afterFailure.credentials[0]?.signCount} ${diagnostic}`
    );
    throw error;
  }
  assert(
    Buffer.from(assertion).equals(Buffer.from(rawId)),
    `${provider} signed with the wrong passkey`
  );
  const after = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert(
    after.credentials[0]?.signCount > before.credentials[0]?.signCount,
    `${provider} did not advance the passkey sign count`
  );
  console.log(`PASS ${provider} WebAuthn assertion with transferred Kernel passkey`);
}

async function run(): Promise<void> {
  // Every target leg runs by default; RUN_BROWSER_PASSKEY_PROVIDERS=tilion,steel narrows it.
  const legs = (process.env.RUN_BROWSER_PASSKEY_PROVIDERS ?? 'steel,tilion,browser-use')
    .split(',')
    .map((leg) => leg.trim())
    .filter(Boolean);
  const keys: Record<string, string> = {
    steel: 'STEEL_API_KEY',
    tilion: 'TILION_API_KEY',
    'browser-use': 'BROWSER_USE_API_KEY',
  };
  for (const leg of legs) assert(keys[leg], `unknown passkey provider leg ${leg}`);
  const required = ['KERNEL_API_KEY', ...legs.map((leg) => keys[leg])];
  for (const name of required) assert(process.env[name]?.trim(), `${name} is required`);
  let kernel: Awaited<ReturnType<typeof createKernelRecoverySession>> | undefined;
  let steel: Awaited<ReturnType<typeof createSteelRecoverySession>> | undefined;
  let tilion: Awaited<ReturnType<typeof createTilionRecoverySession>> | undefined;
  let browserUse: Awaited<ReturnType<typeof createBrowserUseRecoverySession>> | undefined;
  let failure: unknown;
  try {
    kernel = await createKernelRecoverySession(randomUUID(), DEFAULT_GEOLOCATION, {
      omitManagedProxy: true,
    });
    assert(kernel.validationBrowser, 'Kernel validation browser unavailable');
    const key = await register(kernel.validationBrowser);
    await kernel.validationBrowser.close();

    if (legs.includes('steel')) {
      steel = await createSteelRecoverySession({
        proxyLocation: DEFAULT_GEOLOCATION,
        proxyMode: 'managed',
      });
      assert(steel.validationBrowser, 'Steel validation browser unavailable');
      await assertTransferredPasskey('Steel', steel.validationBrowser, key);
      await steel.validationBrowser.close();
    }

    if (legs.includes('tilion')) {
      tilion = await createTilionRecoverySession(DEFAULT_GEOLOCATION);
      assert(tilion.validationBrowser, 'Tilion validation browser unavailable');
      await assertTransferredPasskey('Tilion', tilion.validationBrowser, key);
      await tilion.validationBrowser.close();
    }

    if (legs.includes('browser-use')) {
      browserUse = await createBrowserUseRecoverySession(DEFAULT_GEOLOCATION);
      assert(browserUse.validationBrowser, 'Browser Use validation browser unavailable');
      await assertTransferredPasskey('Browser Use', browserUse.validationBrowser, key);
      await browserUse.validationBrowser.close();
    }
  } catch (error) {
    failure = error;
  } finally {
    const results = await Promise.allSettled([
      kernel?.validationBrowser?.close(),
      steel?.validationBrowser?.close(),
      tilion?.validationBrowser?.close(),
      browserUse?.validationBrowser?.close(),
      kernel && releaseKernelRemoteSession(kernel.sessionId),
      steel && releaseSteelRemoteSession(steel.sessionId),
      tilion && releaseTilionRemoteSession(tilion.sessionId),
      browserUse && releaseBrowserUseRemoteSession(browserUse.sessionId),
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected' && failure === undefined) failure = rejected.reason;
  }
  if (failure !== undefined) throw failure;
}

if (process.env.RUN_BROWSER_PASSKEY_LIVE === '1') {
  run().catch((error) => {
    console.error(
      `FAIL live browser passkey transfer: ${error instanceof Error ? error.stack : String(error)}`
    );
    process.exitCode = 1;
  });
} else {
  console.log('SKIP live browser passkey transfer (set RUN_BROWSER_PASSKEY_LIVE=1)');
}
