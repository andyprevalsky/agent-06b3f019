#!/usr/bin/env tsx
/** Realm preparation must transfer opaque origin blobs without an ORM object graph. */
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import type { Browser } from 'playwright';
import { assertLocalDatabase } from './assertLocalDatabase';
import { prisma } from '../../providers/database';
import { injectUserData } from '../../providers/steel/injection';

assertLocalDatabase();
const HEAP_MB = 512;
const MAX_RSS_MB = 1200;
const RECORDS = 540_000;
const realm = 'origin-memory.test';
const bigOrigin = `https://drive.${realm}`;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function child(userId: string, sessionId: string) {
  let deliveredHash = '';
  let scriptCount = 0;
  const receiver = createContext({
    window: { location: { origin: bigOrigin } },
    JSON: {
      parse: (text: string) => {
        deliveredHash = createHash('md5').update(text).digest('hex');
        return [];
      },
    },
    indexedDB: {
      open: () => {
        throw new Error('opaque receiver must not open a database');
      },
    },
  });
  // The receiver observes the wire bytes before the browser decodes them. The
  // payload is deliberately opaque to this Node process, as it is in transfer.
  const browser = {
    contexts: () => [
      {
        addCookies: async () => undefined,
        addInitScript: async (script: string) => {
          scriptCount++;
          if (!script.includes('indexedDB')) return;
          const transferRssMb = process.resourceUsage().maxRSS / 1024;
          console.log(JSON.stringify({ transferMemorySample: true, rssMb: transferRssMb }));
          assert(
            transferRssMb < MAX_RSS_MB,
            `origin transfer exceeded ${MAX_RSS_MB}MB RSS: ${transferRssMb}`
          );
          assert(
            Buffer.byteLength(script, 'utf8') <= 1024 * 1024,
            'origin transfer sent an unbounded CDP script'
          );
          runInContext(script, receiver);
        },
      },
    ],
    close: async () => {
      throw new Error('caller-owned connection was closed');
    },
  } as unknown as Browser;
  try {
    const result = await injectUserData(sessionId, userId, `https://www.${realm}`, { browser });
    assert(
      result.indexedDB.injected && result.indexedDB.originCount === 1,
      'large origin was omitted from realm preparation'
    );
    assert(deliveredHash.length === 32, 'receiver did not observe opaque origin payload');
    const rssMb = process.resourceUsage().maxRSS / 1024;
    assert(rssMb < MAX_RSS_MB, `origin preparation exceeded ${MAX_RSS_MB}MB RSS: ${rssMb}`);
    console.log(JSON.stringify({ originMemoryReceipt: true, deliveredHash, rssMb, scriptCount }));
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const userId = `origin-injection-memory-${randomUUID()}`;
  const sessionId = `origin-memory-session-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId } });
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId,
      wsUrl: 'ws://origin-memory.test',
      provider: 'kernel',
      status: 'ACTIVE',
    },
  });
  try {
    // Build in Postgres so fixture construction cannot be the Node memory sink.
    await prisma.$executeRaw`
      INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
      SELECT ${randomUUID()}, ${userId}, ${bigOrigin},
        jsonb_build_array(jsonb_build_object('name', 'DocsErrors',
          'objectStores', jsonb_build_array(jsonb_build_object('name', 'Errors',
            'records', (SELECT jsonb_agg(jsonb_build_object('key', 'record-key-' || i,
              'value', jsonb_build_object('key', 'record-key-' || i,
                'value', md5(i::text) || md5((i * 7)::text))))
              FROM generate_series(1, ${RECORDS}::int) i))))),
        'synthetic-origin', now()`;
    const [expected] = await prisma.$queryRaw<Array<{ hash: string; bytes: number }>>`
      SELECT md5(databases::text) AS hash, octet_length(databases::text)::int AS bytes
      FROM "IndexedDBOrigin" WHERE "userId" = ${userId} AND origin = ${bigOrigin}`;
    assert(expected.bytes > 70_000_000, 'fixture lost the observed large-origin shape');
    const proc = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--child',
        userId,
        sessionId,
      ],
      {
        env: { ...process.env, BROWSER_STATE_INJECTION_TIMEOUT_MS: '15000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => {
      stdout += String(b);
    });
    proc.stderr.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-12000);
    });
    const deadline = setTimeout(() => proc.kill('SIGKILL'), 120000);
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        proc.on('error', reject);
        proc.on('exit', (code, signal) => resolve({ code, signal }));
      }
    );
    clearTimeout(deadline);
    assert(
      exit.code === 0,
      `real realm-preparation child failed: code=${exit.code} signal=${exit.signal}\n${stderr}`
    );
    const receipt = stdout
      .split('\n')
      .flatMap((line) => {
        try {
          const r = JSON.parse(line);
          return r.originMemoryReceipt ? [r] : [];
        } catch {
          return [];
        }
      })
      .at(-1);
    assert(receipt?.deliveredHash === expected.hash, 'large origin bytes changed during transfer');
    console.log(
      `✅ origin preparation transferred ${expected.bytes} unchanged bytes; peak RSS ${receipt.rssMb.toFixed(0)}MB`
    );
  } finally {
    await prisma.indexedDBOrigin.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
}

(process.argv[2] === '--child' ? child(process.argv[3], process.argv[4]) : main()).catch(
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
