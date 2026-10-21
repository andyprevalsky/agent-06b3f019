import { resumeBrowserSession } from '../../providers/browserSessionResume';
import { createAgentTransaction } from '../../domains/agents/repoMutations';
/** Owning DB/crypto regressions for lazy logical browser identity and baselines. */
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prisma } from '../../providers/database';
import { ensureLogicalBrowser, logicalBrowserTaskId } from '../../providers/browser/logicalSession';
import {
  EMPTY_BROWSER_BASELINE,
  readBrowserCheckpoint,
  writeBrowserCheckpoint,
  restoreLogicalBrowserCheckpoint,
} from '../../providers/browser/checkpoint';

export async function runLogicalBrowserCases() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/victoria_[\w-]+$/);
  assert.equal(
    logicalBrowserTaskId('00000000-0000-0000-0000-000000000001'),
    '8913beee-1a48-57d1-b6bf-77488272a44b'
  );
  const userId = `logical-${randomUUID()}`;
  const createdUser = `created-${randomUUID()}`;
  const createdAgent = randomUUID();
  const otherUser = `foreign-${randomUUID()}`;
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const saved = {
    key: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
    backend: process.env.CODE_SESSION_STORAGE_BACKEND,
    dir: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
    provider: process.env.BROWSER_PROVIDER,
  };
  const dir = await mkdtemp(join(tmpdir(), 'browser-logical-'));
  try {
    delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    process.env.BROWSER_PROVIDER = 'kernel';
    await prisma.agent.createMany({
      data: ids.map((id, index) => ({
        id,
        userId: index === 3 ? otherUser : userId,
        goal: 'logical browser owning regression',
      })),
    });
    const copies = await Promise.all(
      Array.from({ length: 8 }, () => ensureLogicalBrowser(userId, ids[0]!))
    );
    assert(
      copies.every((row) => row.id === logicalBrowserTaskId(ids[0]!) && row.sessionId === null)
    );
    assert.equal(copies[0]!.baselineCheckpointRef, EMPTY_BROWSER_BASELINE);
    await createAgentTransaction({
      agentId: createdAgent,
      userId: createdUser,
      parentAgentId: null,
      parentWorkflowId: null,
      depth: 0,
      busId: null,
      goal: 'empty baseline creation proof',
      model: 'test',
      reasoningMaxTokens: 0,
      source: 'WEB',
      tokenInPriceMicrodollars: null,
      tokenOutPriceMicrodollars: null,
      pauseState: true,
      responseSchema: undefined,
      proxyCountry: 'us',
      verifierType: 'FLOAT_LLM_JUDGE',
    });
    const created = await prisma.browserSession.findUniqueOrThrow({
      where: { logicalOwnerKey: `agent:${createdAgent}` },
    });
    assert.equal(created.sessionId, null);
    assert.equal(created.baselineCheckpointRef, EMPTY_BROWSER_BASELINE);
    await prisma.browserSession.update({ where: { id: created.id }, data: { provider: 'steel' } });
    await assert.rejects(resumeBrowserSession(created.id), /requires durable hydration custody/);
    assert.equal(
      (await prisma.browserSession.findUniqueOrThrow({ where: { id: created.id } })).sessionId,
      null
    );

    assert.equal(
      await prisma.browserSession.count({ where: { logicalOwnerKey: `agent:${ids[0]}` } }),
      1
    );
    await assert.rejects(ensureLogicalBrowser(userId, ids[3]!), /owner mismatch/);
    const sibling = await ensureLogicalBrowser(userId, ids[1]!);
    assert.notEqual(sibling.id, copies[0]!.id);
    const empty = await readBrowserCheckpoint(userId, EMPTY_BROWSER_BASELINE);
    assert.deepEqual(empty.storage, { cookies: [], origins: [] });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
    process.env.CODE_SESSION_STORAGE_LOCAL_DIR = dir;
    const ref = await writeBrowserCheckpoint({
      ...empty,
      sourceLogicalId: copies[0]!.id,
      sourceRevision: 1,
      storage: {
        cookies: [],
        origins: [
          {
            origin: 'https://example.com',
            localStorage: [{ name: 'private', value: 'secret-fixture-payload' }],
          },
        ],
      },
    });
    assert(!(await readFile(join(dir, ref), 'utf8')).includes('secret-fixture-payload'));
    assert.equal(
      (await readBrowserCheckpoint(userId, ref)).storage.origins[0]!.localStorage[0]!.value,
      'secret-fixture-payload'
    );
    await assert.rejects(readBrowserCheckpoint(otherUser, ref), /owner mismatch/);
    const home = await prisma.browserSession.findUniqueOrThrow({
      where: { logicalOwnerKey: `home:${userId}` },
    });
    await prisma.browserSession.update({
      where: { id: home.id },
      data: { checkpointRef: ref, checkpointRevision: 1 },
    });
    const later = await ensureLogicalBrowser(userId, ids[2]!);
    assert.equal(later.baselineCheckpointRef, ref);
    let restored: unknown;
    await restoreLogicalBrowserCheckpoint(later.id, {
      contexts: () => [
        {
          setStorageState: async (value: unknown) => {
            restored = value;
          },
          pages: () => [],
        },
      ],
    } as unknown as Browser);
    assert.deepEqual(restored, (await readBrowserCheckpoint(userId, ref)).storage);

    assert.equal(
      (await ensureLogicalBrowser(userId, ids[0]!)).baselineCheckpointRef,
      EMPTY_BROWSER_BASELINE
    );
    assert.equal(
      (await ensureLogicalBrowser(userId, ids[1]!)).baselineCheckpointRef,
      EMPTY_BROWSER_BASELINE
    );
    assert.equal(
      await prisma.toolSideEffect.count({
        where: { operationKey: { in: copies.map((x) => `steel-browser-task-lifecycle:${x.id}`) } },
      }),
      0
    );
    console.log('PASS logical browser identity/baseline (8 invariants, no provider allocation)');
  } finally {
    await prisma.browserContext.deleteMany({
      where: { userId: { in: [userId, otherUser, createdUser] } },
    });
    await prisma.agent.deleteMany({ where: { id: { in: [...ids, createdAgent] } } });
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      CLAUDE_CREDENTIAL_DECRYPTION_KEY: saved.key,
      CODE_SESSION_STORAGE_BACKEND: saved.backend,
      CODE_SESSION_STORAGE_LOCAL_DIR: saved.dir,
      BROWSER_PROVIDER: saved.provider,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
