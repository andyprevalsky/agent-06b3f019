#!/usr/bin/env tsx

import {
  createPostgrestSeedClient,
  createSeedRemoteClient,
} from '../../../scripts/seed-remote-source';
import { Prisma } from '@prisma/client';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

test('PostgREST seed reads preserve bigint, date, JSON, empty-string, and null values', async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });
    if (url.pathname.endsWith('/Cookie')) {
      return new Response(
        [
          'id,userId,domain,name,path,value,expiresUtc,isSecure,isHttpOnly,browserSource,syncedAt,creationUtc,hasExpires,isPersistent,lastAccessUtc,lastUpdateUtc,priority,sameSite,sourcePort,sourceScheme,topFrameSiteKey,browserProfile',
          'cookie-1,user-1,.example.com,session,/,"",13380123456789012,true,false,chrome,2026-07-29T22:10:11.123Z,,true,true,13380123456789013,13380123456789014,1,-1,443,2,"",Default',
        ].join('\n'),
        { status: 206, headers: { 'content-type': 'text/csv', 'content-range': '2-2/*' } }
      );
    }
    if (url.pathname.endsWith('/EmailIntegrationCredential')) {
      return Response.json([
        {
          id: 'email-1',
          userId: 'user-1',
          scopes: ['mail.read', 'mail.send'],
        },
      ]);
    }
    if (url.pathname.endsWith('/GoalBlueprint')) {
      return Response.json([
        {
          id: 'blueprint-1',
          blueprint: 'STATUS: SUCCESS',
          created_at: '2026-07-29T00:00:00.000Z',
        },
      ]);
    }
    return Response.json([
      {
        id: 'origin-1',
        userId: 'user-1',
        origin: 'https://example.com',
        entries: { token: 'abc', count: 2 },
        hash: 'hash-1',
        updatedAt: '2026-07-29T22:10:12.456Z',
      },
    ]);
  };
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    fetchImpl,
  });

  const cookies = await client.cookie.findMany({
    where: {
      userId: 'user-1',
      OR: [
        { domain: 'example.com' },
        { domain: '.example.com' },
        { domain: { endsWith: '.example.com' } },
      ],
    },
    orderBy: { id: 'asc' },
    skip: 2,
    take: 2,
  });
  const origins = await client.localStorageOrigin.findMany({
    where: { userId: 'user-1', origin: { contains: '://example.com/' } },
  });
  const emailCredentials = await client.emailIntegrationCredential.findMany({
    where: { userId: 'user-1' },
    select: { id: true, userId: true, scopes: true },
  });
  const blueprints = await client.goalBlueprint.findMany({
    where: { userId: 'user-1' },
    select: { id: true, blueprint: true, createdAt: true },
  });

  assert(cookies.length === 1, `expected one Cookie row, got ${cookies.length}`);
  const cookie = cookies[0];
  assert(cookie.value === '', 'quoted CSV empty string must stay an empty string');
  assert(cookie.creationUtc === null, 'unquoted CSV empty field must become null');
  assert(
    cookie.expiresUtc === 13_380_123_456_789_012n,
    `expected lossless bigint, got ${String(cookie.expiresUtc)}`
  );
  assert(cookie.syncedAt instanceof Date, 'DateTime fields must become Date instances');
  assert(cookie.isSecure === true && cookie.isHttpOnly === false, 'booleans must be typed');
  assert(cookie.sourcePort === 443, 'integer fields must be typed');
  assert(
    JSON.stringify(origins[0]?.entries) === '{"token":"abc","count":2}',
    `JSON field was not decoded: ${JSON.stringify(origins[0]?.entries)}`
  );
  assert(
    JSON.stringify(emailCredentials[0]?.scopes) === '["mail.read","mail.send"]',
    'scalar-list fields must remain typed arrays'
  );
  assert(
    blueprints[0]?.blueprint === 'STATUS: SUCCESS',
    'JSON scalar strings must not be parsed as nested JSON documents'
  );
  assert(
    blueprints[0]?.createdAt instanceof Date,
    'mapped database columns must return their Prisma field name and type'
  );
  const blueprintRequest = requests.find((request) =>
    request.url.pathname.endsWith('/GoalBlueprint')
  );
  assert(
    blueprintRequest?.url.searchParams.get('select')?.includes('created_at') === true,
    'Prisma field names must map to database column names in PostgREST queries'
  );

  const cookieRequest = requests[0];
  assert(cookieRequest.url.pathname === '/rest/v1/Cookie', 'expected the quoted Prisma table name');
  assert(
    cookieRequest.url.searchParams.get('userId') === 'eq.user-1',
    'expected user scope at the HTTP boundary'
  );
  assert(
    cookieRequest.url.searchParams.get('or')?.includes('domain.like.*.example.com') === true,
    'expected suffix-safe domain OR filter at the HTTP boundary'
  );
  assert(cookieRequest.url.searchParams.get('order') === 'id.asc', 'expected stable ordering');
  assert(requestHeader(cookieRequest.init, 'range') === '2-3', 'expected exact requested range');
  assert(
    requestHeader(cookieRequest.init, 'authorization') === 'Bearer service-secret',
    'expected service-role authorization header'
  );
  assert(
    !cookieRequest.url.toString().includes('service-secret'),
    'service-role key must never appear in the URL'
  );
});

test('PostgREST seed reads page beyond the server row limit without duplicates', async () => {
  const ranges: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const range = requestHeader(init, 'range') ?? '';
    ranges.push(range);
    const start = Number(range.split('-')[0]);
    const count = start === 0 ? 1000 : 2;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = start + index;
      return {
        id: `tool-${id}`,
        name: `tool_name_${id}`,
        description: `description_${id}`,
        createdAt: '2026-07-29T00:00:00.000Z',
      };
    });
    return Response.json(rows, {
      status: 206,
    });
  };
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    fetchImpl,
  });

  const tools = await client.tool.findMany();

  assert(tools.length === 1002, `expected 1002 rows across pages, got ${tools.length}`);
  assert(
    ranges.join(',') === '0-999,1000-1999',
    `expected bounded consecutive HTTP pages, got ${ranges.join(',')}`
  );
  assert(tools[1000]?.id === 'tool-1000', 'second page must continue at the exact next row');
});

test('PostgREST seed reads chunk long IN filters and reapply global order and limit', async () => {
  const personIds = Array.from({ length: 205 }, (_, index) => `person-${index}`);
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = requestUrl(input);
    requests.push(url);
    const inFilter = url.searchParams.get('personId') ?? '';
    const chunk = inFilter.includes('person-200')
      ? { id: 'message-mid', timestamp: '2026-07-28T00:00:00.000Z' }
      : inFilter.includes('person-100')
        ? { id: 'message-new', timestamp: '2026-07-29T00:00:00.000Z' }
        : { id: 'message-old', timestamp: '2026-07-27T00:00:00.000Z' };
    return Response.json([
      {
        ...chunk,
        personId: 'person-any',
        channel: 'IMESSAGE',
        from: 'sender',
        to: 'recipient',
        message: 'content',
        externalId: null,
        createdAt: chunk.timestamp,
      },
    ]);
  };
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    fetchImpl,
  });

  const messages = await client.messageRecord.findMany({
    where: { personId: { in: personIds } },
    orderBy: { timestamp: 'desc' },
    take: 2,
  });

  assert(requests.length === 3, `expected 3 bounded IN requests, got ${requests.length}`);
  assert(
    requests.every((url) => (url.searchParams.get('personId')?.length ?? 0) < 2000),
    'each IN filter must remain URL-safe'
  );
  assert(
    messages.map((row) => row.id).join(',') === 'message-new,message-mid',
    `expected global order and limit after chunking, got ${messages.map((row) => row.id).join(',')}`
  );
});

test('auto transport falls back only when PostgreSQL is unreachable', async () => {
  let disconnects = 0;
  const postgres = {
    $queryRawUnsafe: async () => {
      const error = new Error('Can’t reach database server');
      Object.assign(error, { code: 'P1001' });
      throw error;
    },
    $disconnect: async () => {
      disconnects += 1;
    },
  };
  let httpsReads = 0;
  const client = await createSeedRemoteClient({
    databaseUrl: 'postgresql://remote.invalid/postgres',
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    createPostgresClient: () => postgres,
    fetchImpl: async () => {
      httpsReads += 1;
      return Response.json([
        {
          id: 'tool-1',
          name: 'example',
          description: 'Example',
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ]);
    },
  });

  const tools = await client.tool.findMany({ take: 1 });

  assert(
    disconnects === 1,
    `expected unreachable PostgreSQL client to disconnect once, got ${disconnects}`
  );
  assert(httpsReads === 1, `expected one HTTPS fallback read, got ${httpsReads}`);
  assert(tools[0]?.name === 'example', 'expected the HTTPS source to satisfy the same model read');
});

test('auto transport recognizes Prisma 5 connectivity errors that omit P1001', async () => {
  let httpsReads = 0;
  const client = await createSeedRemoteClient({
    databaseUrl: 'postgresql://remote.invalid/postgres',
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    createPostgresClient: () => ({
      $queryRawUnsafe: async () => {
        throw new Prisma.PrismaClientInitializationError(
          "Can't reach database server at `remote.invalid:6543`",
          '5.22.0',
          undefined
        );
      },
      $disconnect: async () => {},
    }),
    fetchImpl: async () => {
      httpsReads += 1;
      return Response.json([
        {
          id: 'tool-1',
          name: 'example',
          description: 'Example',
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ]);
    },
  });

  const tools = await client.tool.findMany({ take: 1 });

  assert(httpsReads === 1, `expected one typed no-code fallback read, got ${httpsReads}`);
  assert(tools[0]?.name === 'example', 'expected the typed Prisma fallback to read over HTTPS');
});

test('auto transport never hides a non-connectivity PostgreSQL failure', async () => {
  let disconnects = 0;
  const postgres = {
    $queryRawUnsafe: async () => {
      const error = new Error('Authentication failed');
      Object.assign(error, { code: 'P1000' });
      throw error;
    },
    $disconnect: async () => {
      disconnects += 1;
    },
  };
  let httpsReads = 0;
  let message = '';
  try {
    await createSeedRemoteClient({
      databaseUrl: 'postgresql://remote.invalid/postgres',
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: 'service-secret',
      createPostgresClient: () => postgres,
      fetchImpl: async () => {
        httpsReads += 1;
        return new Response('', { status: 200 });
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message.includes('Authentication failed'), `expected original failure, got ${message}`);
  assert(
    httpsReads === 0,
    'authentication/schema failures must not fall through to another transport'
  );
  assert(
    disconnects === 1,
    `expected failed PostgreSQL client to disconnect once, got ${disconnects}`
  );
});

test('auto transport never trusts connectivity text on a generic code-less error', async () => {
  let disconnects = 0;
  let httpsReads = 0;
  let message = '';
  try {
    await createSeedRemoteClient({
      databaseUrl: 'postgresql://remote.invalid/postgres',
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: 'service-secret',
      createPostgresClient: () => ({
        $queryRawUnsafe: async () => {
          throw new Error("Can't reach database server");
        },
        $disconnect: async () => {
          disconnects += 1;
        },
      }),
      fetchImpl: async () => {
        httpsReads += 1;
        return Response.json([]);
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(
    message.includes("Can't reach database server"),
    `expected original failure, got ${message}`
  );
  assert(httpsReads === 0, `expected no code-less fallback reads, got ${httpsReads}`);
  assert(disconnects === 1, `expected failed PostgreSQL client cleanup, got ${disconnects}`);
});

test('PostgREST seed transport refuses to send a service-role key over plaintext HTTP', async () => {
  let fetches = 0;
  let message = '';
  try {
    createPostgrestSeedClient({
      supabaseUrl: 'http://project.supabase.co',
      serviceRoleKey: 'service-secret',
      fetchImpl: async () => {
        fetches += 1;
        return Response.json([]);
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message.includes('must use HTTPS'), `expected an HTTPS guard, got ${message}`);
  assert(fetches === 0, `expected no plaintext requests, got ${fetches}`);
});

test('PostgREST seed reads retry a transient socket reset at the failed page boundary', async () => {
  let fetches = 0;
  const socketReset = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw socketReset;
      return Response.json([
        {
          id: 'tool-1',
          name: 'example',
          description: 'Example',
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ]);
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);

  const tools = await client.tool.findMany({ take: 1 });

  assert(fetches === 2, `expected one bounded socket retry, got ${fetches} fetches`);
  assert(tools[0]?.id === 'tool-1', 'the retried page must return its rows exactly once');
});

test('PostgREST seed reads retry transient HTTP responses', async () => {
  let fetches = 0;
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) return new Response('rate limited', { status: 429 });
      if (fetches === 2) return new Response('temporarily unavailable', { status: 503 });
      return Response.json([
        {
          id: 'tool-1',
          name: 'example',
          description: 'Example',
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ]);
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);

  const tools = await client.tool.findMany({ take: 1 });

  assert(fetches === 3, `expected two bounded HTTP retries, got ${fetches} fetches`);
  assert(tools[0]?.id === 'tool-1', 'the retried HTTP page must return its rows');
});

test('PostgREST seed reads retry a non-TypeError timeout', async () => {
  let fetches = 0;
  const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw timeout;
      return Response.json([
        {
          id: 'tool-1',
          name: 'example',
          description: 'Example',
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ]);
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);

  const tools = await client.tool.findMany({ take: 1 });

  assert(fetches === 2, `expected one bounded timeout retry, got ${fetches} fetches`);
  assert(tools[0]?.id === 'tool-1', 'the retried timeout page must return its rows');
});

test('PostgREST seed reads bound persistent transport retries', async () => {
  let fetches = 0;
  const socketReset = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestAttempts: 3,
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      throw socketReset;
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);
  let failure: unknown;

  try {
    await client.tool.findMany({ take: 1 });
  } catch (error) {
    failure = error;
  }

  assert(fetches === 3, `expected exactly 3 transport attempts, got ${fetches}`);
  assert(failure === socketReset, 'the final transport failure must remain the original error');
});

test('PostgREST seed reads preserve the final transient HTTP failure after bounded retries', async () => {
  let fetches = 0;
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestAttempts: 3,
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(`temporarily unavailable ${fetches}`, { status: 503 });
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);
  let message = '';

  try {
    await client.tool.findMany({ take: 1 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(fetches === 3, `expected exactly 3 transient HTTP attempts, got ${fetches}`);
  assert(message.includes('HTTP 503'), `expected the final HTTP status, got ${message}`);
  assert(
    message.includes('temporarily unavailable 3'),
    `expected the readable final response body, got ${message}`
  );
});

test('PostgREST seed reads fail fast on non-transient HTTP responses', async () => {
  let fetches = 0;
  const client = createPostgrestSeedClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-secret',
    requestAttempts: 3,
    requestRetryDelayMs: 0,
    fetchImpl: async () => {
      fetches += 1;
      return new Response('invalid service role', { status: 401 });
    },
  } as Parameters<typeof createPostgrestSeedClient>[0]);
  let message = '';

  try {
    await client.tool.findMany({ take: 1 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(fetches === 1, `expected an authentication failure to fail fast, got ${fetches} fetches`);
  assert(message.includes('HTTP 401'), `expected the original HTTP status, got ${message}`);
});

async function main(): Promise<void> {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  ❌ ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
}

void main();
