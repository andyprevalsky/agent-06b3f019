/**
 * acquireResolvingSession against real Chromium "workers". A DNS-dead worker is a
 * browser launched with `--host-resolver-rules=MAP * ~NOTFOUND`: every lookup fails
 * natively with net::ERR_NAME_NOT_RESOLVED for the life of the browser, as the
 * Tilion worker the live parity landed on did for every navigation of a session.
 *
 *   create ─► session on dead worker ─► first goto ERR_NAME_NOT_RESOLVED ─► release ─┐
 *     ▲                                                                              │
 *     └──────────────────────── fresh session (next worker) ◄────────────────────────┘
 */
import { chromium, type Browser, type Page } from 'playwright';
import { assert, navigateKernelPage } from './browser-provider.helpers';
import { acquireResolvingSession } from './browser-provider.tilion-live.support';

const TARGET_URL = 'https://example.com/';
const DNS_FAILURE = `page.goto: net::ERR_NAME_NOT_RESOLVED at ${TARGET_URL}`;
const REPLACEMENT_WARNING = '[tilion-live] replacing session';

type WorkerKind = 'dns-dead' | 'healthy' | 'refused';
type FakeSession = { sessionId: string; kind: WorkerKind; browser: Browser; page: Page };

async function openSession(kind: WorkerKind, index: number): Promise<FakeSession> {
  const browser = await chromium.launch({
    headless: true,
    args: kind === 'dns-dead' ? ['--host-resolver-rules=MAP * ~NOTFOUND'] : [],
  });
  const page = await browser.newPage();
  if (kind === 'healthy') {
    await page.route(TARGET_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Example Domain</title>',
      })
    );
  } else if (kind === 'refused') {
    await page.route(TARGET_URL, (route) => route.abort('connectionrefused'));
  }
  return { sessionId: `sess_${kind}_${index}`, kind, browser, page };
}

/** Runs acquireResolvingSession over sessions that land on `workers` in order. */
async function acquireOver(workers: WorkerKind[]) {
  const created: FakeSession[] = [];
  const released: string[] = [];
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith(REPLACEMENT_WARNING)) warnings.push(line);
    else original(...args);
  };
  let session: FakeSession | null = null;
  let failure: string | null = null;
  try {
    session = await acquireResolvingSession(
      async () => {
        const kind = workers[created.length];
        assert(kind !== undefined, `created more sessions than the ${workers.length} expected`);
        const next = await openSession(kind, created.length);
        created.push(next);
        return next;
      },
      async (candidate) => {
        await navigateKernelPage(candidate.page, TARGET_URL);
      },
      async (candidate) => {
        released.push(candidate.sessionId);
        await candidate.browser.close();
      },
      3
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    console.warn = original;
  }
  const title = session ? await session.page.title() : null;
  for (const fake of created) await fake.browser.close().catch(() => undefined);
  return { session, failure, title, created, released, warnings };
}

async function assertDnsDeadWorkerSessionIsReplaced(): Promise<void> {
  const result = await acquireOver(['dns-dead', 'healthy']);
  assert(result.failure === null, `expected a fresh session to succeed, got: ${result.failure}`);
  assert(result.session?.kind === 'healthy', 'acquired session is not the replacement');
  assert(result.title === 'Example Domain', `replacement loaded the wrong page: ${result.title}`);
  assert(
    JSON.stringify(result.released) === JSON.stringify(['sess_dns-dead_0']),
    `expected only the DNS-dead session released, got ${JSON.stringify(result.released)}`
  );
  assert(
    result.warnings.length === 1 &&
      result.warnings[0].includes('sess_dns-dead_0') &&
      result.warnings[0].includes(DNS_FAILURE),
    `expected one warning naming the session and DNS failure: ${JSON.stringify(result.warnings)}`
  );
}

async function assertPersistentDnsFailureSurfacesNatively(): Promise<void> {
  const result = await acquireOver(['dns-dead', 'dns-dead', 'dns-dead']);
  assert(
    result.failure?.includes(DNS_FAILURE),
    `expected the native DNS failure after three sessions, got: ${result.failure}`
  );
  assert(result.created.length === 3, `expected 3 sessions, created ${result.created.length}`);
  assert(result.released.length === 3, `expected all 3 sessions released: ${result.released}`);
  assert(result.warnings.length === 2, `expected a warning per replacement: ${result.warnings}`);
}

async function assertOtherFirstNavigationFailuresAreNotReplaced(): Promise<void> {
  const result = await acquireOver(['refused']);
  assert(
    result.failure?.includes('net::ERR_CONNECTION_REFUSED'),
    `expected the native refusal, got: ${result.failure}`
  );
  assert(result.created.length === 1, 'a non-DNS failure must not create a replacement session');
  assert(result.released.length === 1, 'the failed session must still be released');
  assert(result.warnings.length === 0, `unexpected replacement warning: ${result.warnings}`);
}

export const tilionDnsWorkerCases: Array<[string, () => Promise<void>]> = [
  [
    'Tilion direct session on a DNS-dead worker is replaced by a fresh session',
    assertDnsDeadWorkerSessionIsReplaced,
  ],
  [
    'Tilion direct sessions that never resolve DNS surface the native failure',
    assertPersistentDnsFailureSurfacesNatively,
  ],
  [
    'Tilion direct session first-navigation failures other than DNS are not replaced',
    assertOtherFirstNavigationFailuresAreNotReplaced,
  ],
];
