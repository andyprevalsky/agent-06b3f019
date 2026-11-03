/** Private browser checkpoints use the existing encrypted artifact store. */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, CDPSession, Frame, Page } from 'playwright';
import { encryptProjectSecret, decryptProjectSecret } from '../projects/secrets';
import { getCheckpointObject, putCheckpointObject } from '../codeSessions/artifactStore';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { connectValidatedBrowser } from '../steel/sessionConnection';
import type { HydrationTarget } from './resumeLifecycle';
import type { SteelLifecycleMutation } from '../steel/lifecycleClaim';
import { captureFrameIndexedDB, restoreFrameIndexedDB } from './checkpointIndexedDB';

const log = createLogger('BrowserCheckpoint');

type Storage = Awaited<ReturnType<ReturnType<Browser['contexts']>[number]['storageState']>>;
type FrameStorage = {
  origin: string;
  sessionStorage: Array<{ name: string; value: string }>;
  localStorage?: Array<{ name: string; value: string }>;
  indexedDB?: string;
};
export type BrowserCheckpoint = {
  version: 1;
  userId: string;
  sourceLogicalId: string | null;
  sourceRevision: number;
  storage: Storage;
  tabs: Array<{
    url: string;
    sessionStorage: Array<{ name: string; value: string; origin?: string }>;
    frames?: FrameStorage[];
  }>;
  limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'];
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const EMPTY_BROWSER_BASELINE = 'browser-checkpoint:empty:v1';
const userPrefix = (userId: string) => `user/${digest(userId)}/browser-checkpoints/`;

async function assertLogicalBinding(
  taskId: string,
  expected: {
    contextId: string;
    sessionId: string | null;
    checkpointRef: string | null;
    checkpointRevision: number;
  }
): Promise<void> {
  const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  if (
    row.contextId !== expected.contextId ||
    row.sessionId !== expected.sessionId ||
    row.checkpointRef !== expected.checkpointRef ||
    row.checkpointRevision !== expected.checkpointRevision ||
    (row.controlState !== 'AGENT' &&
      (row.controlLeaseExpiresAt === null || row.controlLeaseExpiresAt.getTime() > Date.now()))
  )
    throw new Error('Logical browser ownership changed');
}

export async function writeBrowserCheckpoint(checkpoint: BrowserCheckpoint): Promise<string> {
  const encrypted = Buffer.from(encryptProjectSecret(JSON.stringify(checkpoint)));
  const ref = `${userPrefix(checkpoint.userId)}${digest(encrypted)}.envelope`;
  await putCheckpointObject(ref, encrypted);
  const stored = await getCheckpointObject(ref);
  if (stored === null || !stored.equals(encrypted))
    throw new Error('Browser checkpoint write not verified');
  return ref;
}

export async function readBrowserCheckpoint(
  userId: string,
  ref: string
): Promise<BrowserCheckpoint> {
  if (ref === EMPTY_BROWSER_BASELINE)
    return {
      version: 1,
      userId,
      sourceLogicalId: null,
      sourceRevision: 0,
      storage: { cookies: [], origins: [] },
      tabs: [],
      limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'],
    };
  if (!ref.startsWith(userPrefix(userId))) throw new Error('Browser checkpoint owner mismatch');
  const encrypted = await getCheckpointObject(ref);
  if (encrypted === null || ref !== `${userPrefix(userId)}${digest(encrypted)}.envelope`)
    throw new Error('Browser checkpoint integrity failure');
  const plaintext = decryptProjectSecret(encrypted.toString());
  if (plaintext === null) throw new Error('Browser checkpoint cannot be decrypted');
  const value = JSON.parse(plaintext) as BrowserCheckpoint;
  if (
    value.version !== 1 ||
    value.userId !== userId ||
    !Array.isArray(value.storage?.cookies) ||
    !Array.isArray(value.storage?.origins) ||
    !Array.isArray(value.tabs)
  )
    throw new Error('Invalid browser checkpoint');
  return value;
}

/** Validate saved state before native allocation, and again under the same owner before hydration. */
export async function loadLogicalBrowserCheckpoint(taskId: string, requireSaved = false) {
  const row = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
    include: { context: true },
  });
  if (!row.logicalOwnerKey) throw new Error('Browser checkpoint requires a logical owner');
  if ((requireSaved || row.checkpointRevision > 0) && !row.checkpointRef)
    throw new Error('Logical browser saved checkpoint is missing');
  const ref = row.checkpointRef ?? row.baselineCheckpointRef;
  if (!ref) throw new Error('Logical browser checkpoint baseline is missing');
  const checkpoint = await readBrowserCheckpoint(row.context.userId, ref);
  if (
    row.checkpointRef &&
    ref !== EMPTY_BROWSER_BASELINE &&
    (checkpoint.sourceLogicalId !== row.id || checkpoint.sourceRevision !== row.checkpointRevision)
  )
    throw new Error('Logical browser checkpoint revision or owner changed');
  await assertLogicalBinding(taskId, row);
  return { row, checkpoint };
}

export async function emptyBrowserCheckpoint(_userId: string): Promise<string> {
  return EMPTY_BROWSER_BASELINE;
}

/** Called before provider release; failure must prevent a successful pause. */
export async function checkpointLogicalBrowser(
  nativeId: string,
  mutateOwned?: SteelLifecycleMutation
): Promise<void> {
  const row = await prisma.browserSession.findUnique({
    where: { sessionId: nativeId },
    include: { context: true },
  });
  if (!row?.logicalOwnerKey) return;
  if (
    row.controlState !== 'AGENT' &&
    (row.controlLeaseExpiresAt === null || row.controlLeaseExpiresAt.getTime() > Date.now())
  )
    throw new Error('Browser checkpoint cannot interrupt user control');
  if (!row.wsUrl) throw new Error('Browser checkpoint requires a live binding');
  const browser = await connectValidatedBrowser(row.wsUrl);
  if (!browser) throw new Error('Browser checkpoint connection failed');
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browser checkpoint context missing');
    const previous = row.checkpointRef
      ? (await loadLogicalBrowserCheckpoint(row.id)).checkpoint
      : null;
    const knownOrigins = new Set(
      previous?.tabs.flatMap((tab) => [
        new URL(tab.url).origin,
        ...(tab.frames ?? []).map((frame) => frame.origin),
        ...tab.sessionStorage.flatMap((entry) => (entry.origin ? [entry.origin] : [])),
      ]) ?? []
    );
    const capturedTabs = await Promise.allSettled(
      context
        .pages()
        .filter((page) => /^https?:/.test(page.url()))
        .map(async (page) => {
          const frames = new Map<string, FrameStorage>();
          const origin = new URL(page.url()).origin;
          for (const frame of page.frames()) {
            const captured = await readFrameStorage(frame, origin);
            if (captured && captured.origin !== origin) frames.set(captured.origin, captured);
          }
          const missing = [...knownOrigins].filter(
            (value) => value !== origin && !frames.has(value)
          );
          for (const [key, values] of await detachedTabStorage(page, missing)) {
            if (values.sessionStorage.length || values.localStorage?.length || values.indexedDB)
              frames.set(key, values);
          }
          return {
            url: page.url(),
            sessionStorage: [
              ...(await page.evaluate<Array<{ name: string; value: string }>>(
                'Object.entries(sessionStorage).map(([name,value]) => ({name,value}))'
              )),
              ...[...frames.values()].flatMap((frame) =>
                frame.sessionStorage.map((entry) => ({ ...entry, origin: frame.origin }))
              ),
            ],
            frames: [...frames.values()],
          };
        })
    );
    // Join every capture's exact cleanup before disconnecting, including when
    // one concurrent tab failed preparation.
    const failedCapture = capturedTabs.find((capture) => capture.status === 'rejected');
    if (failedCapture?.status === 'rejected') throw failedCapture.reason;
    const tabs = capturedTabs.map((capture) => {
      if (capture.status === 'rejected') throw capture.reason;
      return capture.value;
    });
    // A fresh CDP connection has no visited-origin history. Register the
    // existing origins on a private, locally fulfilled page for first-party
    // localStorage/IndexedDB. Frame DOM storage is captured in its partition above.
    // Existing tabs must not navigate merely to take a checkpoint.
    const origins = new Set(
      tabs.flatMap((tab) => [new URL(tab.url).origin, ...tab.frames.map((frame) => frame.origin)])
    );
    for (const origin of knownOrigins) origins.add(origin);
    const capturePage = origins.size ? await context.newPage() : null;
    let captureCdp: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
    let storage: Storage;
    try {
      if (capturePage) {
        captureCdp = await context.newCDPSession(capturePage);
        // Routing does not intercept service-worker responses. Scope bypass to
        // this disposable target so capture cannot execute the site's worker.
        await captureCdp!.send('Network.enable');
        await captureCdp!.send('Network.setBypassServiceWorker', { bypass: true });
        await capturePage.route('**/*', (route) => route.fulfill({ body: '<!doctype html>' }));
        for (const origin of origins) {
          await assertLogicalBinding(row.id, row);
          await capturePage.goto(`${origin}/.rose-checkpoint-${randomUUID()}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
        }
      }
      storage = await context.storageState({ indexedDB: true });
    } finally {
      try {
        await captureCdp?.detach();
      } finally {
        await capturePage?.close();
      }
    }
    const empty = storage.cookies.length === 0 && storage.origins.length === 0 && tabs.length === 0;
    const ref = empty
      ? EMPTY_BROWSER_BASELINE
      : await writeBrowserCheckpoint({
          version: 1,
          userId: row.context.userId,
          sourceLogicalId: row.id,
          sourceRevision: row.checkpointRevision + 1,
          storage,
          tabs,
          limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'],
        });
    const publish = (database: typeof prisma | import('@prisma/client').Prisma.TransactionClient) =>
      database.browserSession.updateMany({
        where: {
          id: row.id,
          contextId: row.contextId,
          context: { userId: row.context.userId },
          sessionId: nativeId,
          checkpointRevision: row.checkpointRevision,
          OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
        },
        data: { checkpointRef: ref, checkpointRevision: { increment: 1 } },
      });
    const changed = mutateOwned ? await mutateOwned(publish) : await publish(prisma);
    if (changed.count !== 1) throw new Error('Browser checkpoint binding changed');
  } finally {
    await browser.close();
  }
}

/** First materialization restores a frozen Home baseline, never a mutable profile. */
export async function restoreLogicalBrowserCheckpoint(
  taskId: string,
  browser: Browser,
  recovery?: {
    targets?: HydrationTarget[];
    assertOwned?: () => Promise<void>;
    prepared?: (targets: HydrationTarget[]) => Promise<void>;
  }
): Promise<void> {
  const { row, checkpoint } = await loadLogicalBrowserCheckpoint(taskId);
  const assertRestoreBinding = async () => {
    await assertLogicalBinding(taskId, row);
    await recovery?.assertOwned?.();
  };
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser checkpoint restore context missing');
  await assertRestoreBinding();
  if (!recovery?.targets) {
    log.info('Browser checkpoint restore phase', {
      task_id: taskId,
      phase: 'storage_started',
      cookies: checkpoint.storage.cookies.length,
      origins: checkpoint.storage.origins.length,
      tabs: checkpoint.tabs.length,
    });
    await context.setStorageState(checkpoint.storage);
    log.info('Browser checkpoint restore phase', { task_id: taskId, phase: 'storage_completed' });
  }
  const targets = checkpoint.tabs.length
    ? checkpoint.tabs
    : [row.currentUrl ?? row.startUrl]
        .filter((value): value is string => value !== null)
        .map((url) => ({ url, sessionStorage: [] }));
  await assertRestoreBinding();
  const targetId = async (page: Page) => {
    const cdp = await context.newCDPSession(page);
    try {
      return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    } finally {
      await cdp.detach();
    }
  };
  const existing = new Map<string, Page>();
  if (recovery?.targets) {
    if (
      new Set(recovery.targets.map((target) => target.targetId)).size !== recovery.targets.length ||
      recovery.targets.length !== targets.length ||
      recovery.targets.some((target, index) => target.urlHash !== digest(targets[index]?.url ?? ''))
    )
      throw new Error('Acknowledged browser hydration checkpoint targets changed');
    for (const page of context.pages()) existing.set(await targetId(page), page);
    if (
      existing.size !== recovery.targets.length ||
      recovery.targets.some((target) => !existing.has(target.targetId))
    )
      throw new Error('Acknowledged browser hydration pages changed');
    if (
      recovery.targets.some((target, index) => {
        const url = existing.get(target.targetId)!.url();
        if (url === 'about:blank' || digest(url) === target.urlHash) return false;
        try {
          return (
            !target.seedUrlHash ||
            digest(url) !== target.seedUrlHash ||
            new URL(url).origin !== new URL(targets[index]!.url).origin
          );
        } catch {
          return true;
        }
      })
    )
      throw new Error('Acknowledged browser hydration page navigation changed');
  }
  if (recovery?.targets) {
    await assertRestoreBinding();
    await context.setStorageState(checkpoint.storage);
  }
  const blank = context.pages().find((page) => page.url() === 'about:blank');
  const prepared: Array<{ page: Page; url: string; seedUrlHash?: string }> = [];
  log.info('Browser checkpoint restore phase', { task_id: taskId, phase: 'seeding_started' });
  for (let index = 0; index < targets.length; index++) {
    await assertRestoreBinding();
    const target = targets[index]!;
    const page = recovery?.targets
      ? existing.get(recovery.targets[index]!.targetId)!
      : index === 0 && blank
        ? blank
        : await context.newPage();
    const seedUrl = await seedTabSessionStorage(page, target);
    prepared.push({
      page,
      url: target.url,
      ...(seedUrl && page.url() === seedUrl ? { seedUrlHash: digest(seedUrl) } : {}),
    });
  }
  if (recovery?.prepared) {
    // Tracking failure never changes first-hydration semantics; it disables acknowledgement.
    try {
      const pages = context.pages();
      if (
        pages.length === prepared.length &&
        pages.every((page) => prepared.some((p) => p.page === page))
      ) {
        const owned = await Promise.all(
          prepared.map(async ({ page, url, seedUrlHash }) => ({
            targetId: await targetId(page),
            urlHash: digest(url),
            ...(seedUrlHash ? { seedUrlHash } : {}),
          }))
        );
        await recovery.prepared(owned);
      }
    } catch {
      /* The caller retains unknown custody if provenance cannot be recorded. */
    }
  }
  log.info('Browser checkpoint restore phase', { task_id: taskId, phase: 'navigation_started' });
  for (const { page, url } of prepared) {
    await assertRestoreBinding();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  log.info('Logical browser tabs restored', { taskId, tabs: prepared.length });
}

/** Seed each origin in the destination tab's storage namespace, including late-created frames. */
async function seedTabSessionStorage(page: Page, target: BrowserCheckpoint['tabs'][number]) {
  // Both version-1 layouts exist: older callers put child entries in this
  // array with an origin; partition-aware checkpoints also carry frames.
  const origin = new URL(target.url).origin;
  const framesByOrigin = new Map(
    (target.frames ?? []).map((frame) => [
      frame.origin,
      { ...frame, sessionStorage: [...frame.sessionStorage] },
    ])
  );
  const mainEntries = target.sessionStorage.filter(
    (entry) => !entry.origin || entry.origin === origin
  );
  for (const entry of target.sessionStorage) {
    if (!entry.origin || entry.origin === origin) continue;
    const frame = framesByOrigin.get(entry.origin) ?? { origin: entry.origin, sessionStorage: [] };
    if (!frame.sessionStorage.some((saved) => saved.name === entry.name))
      frame.sessionStorage.push({ name: entry.name, value: entry.value });
    framesByOrigin.set(entry.origin, frame);
  }
  const frames = [...framesByOrigin.values()];
  if (
    !target.sessionStorage.length &&
    !frames.some(
      (frame) => frame.sessionStorage.length || frame.localStorage?.length || frame.indexedDB
    )
  )
    return;
  const seedUrl = `${origin}/.rose-session-restore-${randomUUID()}`;
  const cdp = await page.context().newCDPSession(page);
  const fulfill = (route: import('playwright').Route) => route.fulfill({ body: '<!doctype html>' });
  try {
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await page.route('**/*', fulfill);
    await page.goto(seedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.evaluate((entries) => {
      for (const { name, value } of entries) sessionStorage.setItem(name, value);
    }, mainEntries);
    for (const saved of frames) {
      await withOriginFrame(page, saved.origin, async (frame) => {
        await frame.evaluate((saved) => {
          for (const { name, value } of saved.sessionStorage) sessionStorage.setItem(name, value);
          for (const { name, value } of saved.localStorage ?? []) localStorage.setItem(name, value);
        }, saved);
        if (saved.indexedDB) await restoreFrameIndexedDB(frame, saved.indexedDB);
      });
    }
    return seedUrl;
  } finally {
    try {
      await page.unroute('**/*', fulfill);
    } finally {
      try {
        await cdp.send('Network.setBypassServiceWorker', { bypass: false });
      } finally {
        await cdp.detach();
      }
    }
  }
}

/** A popup clones its opener's whole session namespace, including currently unloaded origins. */
async function detachedTabStorage(page: Page, origins: string[]) {
  const result = new Map<string, FrameStorage>();
  if (!origins.length) return result;
  const topOrigin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  let popup: Page | undefined;
  let popupPending: Promise<Page> | undefined;
  let popupCdp: CDPSession | undefined;
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'rose-checkpoint',
    });
    // Isolated-world builtins avoid any merchant override of window.open.
    const marker = `about:blank#rose-checkpoint-${randomUUID()}`;
    popupPending = page.waitForEvent('popup', {
      timeout: 30_000,
      predicate: async (candidate) =>
        candidate.url() === marker && (await candidate.opener()) === page,
    });
    await cdp.send('Runtime.evaluate', {
      expression: `window.open(${JSON.stringify(marker)}, "_blank")`,
      contextId: executionContextId,
      userGesture: true,
    });
    popup = await popupPending;
    popupCdp = await page.context().newCDPSession(popup);
    await popupCdp.send('Network.enable');
    await popupCdp.send('Network.setBypassServiceWorker', { bypass: true });
    await popup.route('**/*', (route) => route.fulfill({ body: '<!doctype html>' }));
    // Keep the opener's top-level site: navigating the clone to each child
    // origin would select its first-party storage instead of the saved partition.
    await popup.goto(`${topOrigin}/.rose-checkpoint-${randomUUID()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    for (const origin of origins) {
      const saved = await withOriginFrame(popup, origin, (frame) =>
        readFrameStorage(frame, topOrigin)
      );
      if (saved) result.set(origin, saved);
    }
    return result;
  } finally {
    try {
      await popupCdp?.detach();
    } finally {
      try {
        await (popup ?? (await popupPending?.catch(() => undefined)))?.close();
      } finally {
        await cdp.detach();
      }
    }
  }
}

/** Read through the initialized frame, not its still-empty CDP URL projection. */
async function readFrameStorage(frame: Frame, topOrigin: string): Promise<FrameStorage | null> {
  const state = await frame.evaluate<FrameStorage | null>(`(() => {
    if (globalThis.origin === 'null') return null;
    if (!/^https?:$/.test(location.protocol) || location.origin === ${JSON.stringify(topOrigin)}) return null;
    const entries = storage => Object.entries(storage).map(([name,value]) => ({name,value}));
    return { origin: location.origin, sessionStorage: entries(sessionStorage), localStorage: entries(localStorage) };
  })()`);
  if (state) state.indexedDB = await captureFrameIndexedDB(frame);
  return state;
}

/** Local route fulfillment on the caller-owned page keeps the top-level storage partition. */
async function withOriginFrame<T>(page: Page, origin: string, use: (frame: Frame) => Promise<T>) {
  const url = `${origin}/.rose-checkpoint-${randomUUID()}`;
  const element = await page.evaluateHandle(`(() => {
    const iframe = document.createElement('iframe');
    iframe.src = ${JSON.stringify(url)};
    document.body.append(iframe);
    return iframe;
  })()`);
  try {
    const frame = await element.asElement()?.contentFrame();
    if (!frame) throw new Error('Browser checkpoint frame storage target missing');
    await frame.waitForURL(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await use(frame);
  } finally {
    await element.dispose();
  }
}
