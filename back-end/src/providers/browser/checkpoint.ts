/** Private browser checkpoints use the existing encrypted artifact store. */
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import { encryptProjectSecret, decryptProjectSecret } from '../projects/secrets';
import { getCheckpointObject, putCheckpointObject } from '../codeSessions/artifactStore';
import { prisma } from '../database';
import { connectValidatedBrowser } from '../steel/sessionConnection';

type Storage = Awaited<ReturnType<ReturnType<Browser['contexts']>[number]['storageState']>>;
export type BrowserCheckpoint = {
  version: 1;
  userId: string;
  sourceLogicalId: string | null;
  sourceRevision: number;
  storage: Storage;
  tabs: Array<{ url: string; sessionStorage: Array<{ name: string; value: string }> }>;
  limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'];
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const EMPTY_BROWSER_BASELINE = 'browser-checkpoint:empty:v1';
const userPrefix = (userId: string) => `user/${digest(userId)}/browser-checkpoints/`;

async function assertLogicalBinding(taskId: string, nativeId: string | null): Promise<void> {
  const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
  if (
    row.sessionId !== nativeId ||
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

export async function emptyBrowserCheckpoint(_userId: string): Promise<string> {
  return EMPTY_BROWSER_BASELINE;
}

/** Called before provider release; failure must prevent a successful pause. */
export async function checkpointLogicalBrowser(nativeId: string): Promise<void> {
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
    const storage = await context.storageState({ indexedDB: true });
    const tabs = await Promise.all(
      context
        .pages()
        .filter((page) => /^https?:/.test(page.url()))
        .map(async (page) => ({
          url: page.url(),
          sessionStorage: await page.evaluate<Array<{ name: string; value: string }>>(
            'Object.entries(sessionStorage).map(([name,value]) => ({name,value}))'
          ),
        }))
    );
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
    const changed = await prisma.browserSession.updateMany({
      where: {
        id: row.id,
        sessionId: nativeId,
        checkpointRevision: row.checkpointRevision,
        OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
      },
      data: { checkpointRef: ref, checkpointRevision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new Error('Browser checkpoint binding changed');
  } finally {
    await browser.close();
  }
}

/** First materialization restores a frozen Home baseline, never a mutable profile. */
export async function restoreLogicalBrowserCheckpoint(
  taskId: string,
  browser: Browser
): Promise<void> {
  const row = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
    include: { context: true },
  });
  if (!row.logicalOwnerKey) return;
  const ref = row.checkpointRef ?? row.baselineCheckpointRef;
  if (!ref) throw new Error('Logical browser has no baseline');
  const checkpoint = await readBrowserCheckpoint(row.context.userId, ref);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser checkpoint restore context missing');
  await assertLogicalBinding(taskId, row.sessionId);
  await context.setStorageState(checkpoint.storage);
  const targets = checkpoint.tabs.length
    ? checkpoint.tabs
    : [row.currentUrl ?? row.startUrl]
        .filter((value): value is string => value !== null)
        .map((url) => ({ url, sessionStorage: [] }));
  await assertLogicalBinding(taskId, row.sessionId);
  const blank = context.pages().find((page) => page.url() === 'about:blank');
  for (let index = 0; index < targets.length; index++) {
    await assertLogicalBinding(taskId, row.sessionId);
    const target = targets[index]!;
    const origin = new URL(target.url).origin;
    const page = index === 0 && blank ? blank : await context.newPage();
    const cdp = target.sessionStorage.length ? await context.newCDPSession(page) : null;
    const script = cdp
      ? await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `if (location.origin === ${JSON.stringify(origin)}) { for (const {name,value} of ${JSON.stringify(target.sessionStorage)}) sessionStorage.setItem(name,value); }`,
        })
      : null;
    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } finally {
      if (cdp && script)
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: script.identifier,
        });
      await cdp?.detach();
    }
  }
}
