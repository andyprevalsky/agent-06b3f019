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
  let encodedBytes = 0;
  let deliveredBytes = 0;
  const stringify = JSON.stringify;
  // Measure serialization work, not a host-dependent CPU deadline. The actual
  // SQL-to-browser path must not repeatedly encode the unsent origin suffix.
  JSON.stringify = function (value, replacer, space) {
    const text = stringify(value, replacer, space);
    if (typeof text === 'string' && text.length >= 64 * 1024) {
      encodedBytes += Buffer.byteLength(text);
    }
    return text;
  };
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
  let pageUrl = 'about:blank';
  let pageCloses = 0;
  const browser = {
    contexts: () => [
      {
        addCookies: async () => undefined,
        addInitScript: async () => undefined,
        newCDPSession: async () => ({ send: async () => undefined }),
        newPage: async () => ({
          route: async () => undefined,
          url: () => pageUrl,
          goto: async (url: string) => {
            pageUrl = url;
          },
          close: async () => {
            pageCloses++;
          },
          evaluate: async (script: string) => {
            scriptCount++;
            if (!script.includes('indexedDB')) return;
            deliveredBytes += Buffer.byteLength(stringify({ source: script }));
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
            return runInContext(script, receiver);
          },
        }),
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
    assert(pageCloses === 1, 'origin preparation did not retire its owned restore page');
    assert(
      encodedBytes <= deliveredBytes * 8,
      `origin packet sizing amplified serialization: ${encodedBytes} encoded bytes for ${deliveredBytes} delivered bytes`
    );
    const rssMb = process.resourceUsage().maxRSS / 1024;
    assert(rssMb < MAX_RSS_MB, `origin preparation exceeded ${MAX_RSS_MB}MB RSS: ${rssMb}`);
    console.log(
      JSON.stringify({
        originMemoryReceipt: true,
        deliveredHash,
        rssMb,
        scriptCount,
        encodedBytes,
        deliveredBytes,
      })
    );
  } finally {
    JSON.stringify = stringify;
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
    // Aggregate serialized records before one JSONB parse: jsonb_agg retains
    // the full nested object accumulator and can exhaust the shared Docker VM.
    await prisma.$executeRaw`
      INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
      SELECT ${randomUUID()}, ${userId}, ${bigOrigin},
        ('[{"name":"DocsErrors","objectStores":[{"name":"Errors","records":[' ||
          (SELECT string_agg(jsonb_build_object('key', 'record-key-' || i,
              'value', jsonb_build_object('key', 'record-key-' || i,
                'value', md5(i::text) || md5((i * 7)::text)))::text, ',' ORDER BY i)
            FROM generate_series(1, ${RECORDS}::int) i) || ']}]}]')::jsonb,
        'synthetic-origin', now()`;
    const [expected] = await prisma.$queryRaw<
      Array<{ hash: string; bytes: number; records: number }>
    >`
      SELECT md5(databases::text) AS hash, octet_length(databases::text)::int AS bytes,
        jsonb_array_length(databases->0->'objectStores'->0->'records') AS records
      FROM "IndexedDBOrigin" WHERE "userId" = ${userId} AND origin = ${bigOrigin}`;
    assert(expected.bytes > 70_000_000, 'fixture lost the observed large-origin shape');
    assert(expected.records === RECORDS, 'fixture lost records during construction');
    assert(
      expected.bytes === 78_617_865 && expected.hash === '9e9427f49de602f7a41fffc175aec0d8',
      'fixture canonical bytes changed during construction'
    );
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
        // Production skips origins over 8 MiB; this measures the transfer
        // path's memory when an operator raises both bounds explicitly.
        env: {
          ...process.env,
          BROWSER_STATE_INJECTION_TIMEOUT_MS: '60000',
          BROWSER_STATE_ORIGIN_PAYLOAD_MAX_BYTES: String(256 * 1024 * 1024),
        },
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
