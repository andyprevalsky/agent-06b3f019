/**
 * Blackbox Tests for API Key Management Domain
 *
 * Covers three edge functions:
 *   POST /generate-api-key  -- create a new API key
 *   GET  /api-keys          -- list user's API keys (masked)
 *   DELETE /delete-api-key   -- delete an API key by ID
 *
 * Tests call the extracted handler functions directly with a Supabase stub,
 * so no running server or real Supabase credentials are needed.
 *
 * Boundary: Supabase SDK (auth.getUser + RoseApiKey table queries)
 *   - Stubbed via createSupabaseStub() which records all boundary calls
 *   - Each test asserts on captured boundary calls (table, filters, data)
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { createHandler as createListHandler } from '../supabase/functions/api-keys/handler.ts';
import { createHandler as createGenerateHandler } from '../supabase/functions/generate-api-key/handler.ts';
import { createHandler as createDeleteHandler } from '../supabase/functions/delete-api-key/handler.ts';
import {
  type BoundaryCapture,
  createSupabaseStub,
  type StubConfig,
} from './utils/supabase-stub.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:54321/functions/v1';
const TEST_TOKEN = 'test-jwt-token-abc123';
const TEST_USER = { id: 'user-001', email: 'test@roselabs.ai' };

function makeRequest(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  return new Request(`${BASE_URL}${path}`, init);
}

async function parseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json();
}

function buildHandler(
  // deno-lint-ignore no-explicit-any
  factory: (createClient: any) => (req: Request) => Promise<Response>,
  config: StubConfig,
) {
  const handler = factory(
    // deno-lint-ignore no-explicit-any
    (_url: string, _key: string) => createSupabaseStub(config) as any,
  );
  return handler;
}

// Set required env vars for the handlers
Deno.env.set('SUPABASE_URL', 'https://test.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

// ============================================================================
// POST /generate-api-key
// ============================================================================

Deno.test(
  'generate-api-key: CORS preflight returns 200 with correct headers',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      captures,
    });

    const response = await handler(
      new Request(`${BASE_URL}/generate-api-key`, { method: 'OPTIONS' }),
    );

    assertEquals(response.status, 200);
    assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
    assertEquals(
      response.headers.get('Access-Control-Allow-Headers'),
      'authorization, x-client-info, apikey, content-type',
    );
    assertEquals(captures.length, 0);
  },
);

Deno.test(
  'generate-api-key: rejects request without Authorization header',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      captures,
    });

    const response = await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        body: { name: 'Test' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 401);
    assertEquals(data.error, 'Missing or invalid authorization header');
    assertEquals(captures.length, 0);
  },
);

Deno.test(
  'generate-api-key: rejects request with non-Bearer auth',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      captures,
    });

    const req = new Request(`${BASE_URL}/generate-api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify({ name: 'Test' }),
    });

    const response = await handler(req);
    const data = await parseJson(response);

    assertEquals(response.status, 401);
    assertEquals(data.error, 'Missing or invalid authorization header');
    assertEquals(captures.length, 0);
  },
);

Deno.test(
  'generate-api-key: rejects invalid JWT (Supabase auth fails)',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: null,
      authError: 'Invalid JWT',
      captures,
    });

    const response = await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: 'bad-token',
        body: { name: 'Test' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 401);
    assertEquals(data.error, 'Unauthorized');
    const authCapture = captures.find((c) => c.type === 'auth.getUser');
    assertExists(authCapture);
    assertEquals(authCapture!.token, 'bad-token');
    assertEquals(captures.filter((c) => c.type.startsWith('db.')).length, 0);
  },
);

Deno.test(
  'generate-api-key: creates key with name and returns 200',
  async () => {
    const generatedId = 'key-uuid-001';
    const generatedApiKey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const createdAt = '2026-01-15T10:00:00.000Z';
    const captures: BoundaryCapture[] = [];

    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      insertResults: {
        RoseApiKey: {
          data: { id: generatedId, apiKey: generatedApiKey, createdAt },
          error: null,
        },
      },
      captures,
    });

    const response = await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: { name: 'My Key' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    assertEquals(data.apiKey, generatedApiKey);
    assertEquals(data.id, generatedId);
    assertEquals(data.createdAt, createdAt);
    assertEquals(response.headers.get('Content-Type'), 'application/json');

    const authCapture = captures.find((c) => c.type === 'auth.getUser');
    assertExists(authCapture);
    assertEquals(authCapture!.token, TEST_TOKEN);

    const insertCapture = captures.find((c) => c.type === 'db.insert');
    assertExists(insertCapture);
    assertEquals(insertCapture!.table, 'RoseApiKey');
    // deno-lint-ignore no-explicit-any
    assertEquals((insertCapture!.data as any).userId, TEST_USER.id);
    // deno-lint-ignore no-explicit-any
    assertEquals((insertCapture!.data as any).name, 'My Key');
    // deno-lint-ignore no-explicit-any
    assertEquals((insertCapture!.data as any).apiKey.length, 32);
  },
);

Deno.test(
  'generate-api-key: creates key without name (name defaults to null)',
  async () => {
    const captures: BoundaryCapture[] = [];

    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      insertResults: {
        RoseApiKey: {
          data: {
            id: 'key-002',
            apiKey: 'b'.repeat(32),
            createdAt: '2026-01-15T11:00:00.000Z',
          },
          error: null,
        },
      },
      captures,
    });

    const response = await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: {},
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    assertExists(data.apiKey);
    assertExists(data.id);

    const insertCapture = captures.find((c) => c.type === 'db.insert');
    assertExists(insertCapture);
    // When body is {} the destructured name is undefined, not null
    // (null only occurs when req.json() fails entirely)
    // deno-lint-ignore no-explicit-any
    assertEquals((insertCapture!.data as any).name, undefined);
  },
);

Deno.test('generate-api-key: handles DB insert error', async () => {
  const captures: BoundaryCapture[] = [];

  const handler = buildHandler(createGenerateHandler, {
    user: TEST_USER,
    insertResults: {
      RoseApiKey: {
        data: null,
        error: { message: 'duplicate key value violates unique constraint' },
      },
    },
    captures,
  });

  const response = await handler(
    makeRequest('/generate-api-key', {
      method: 'POST',
      token: TEST_TOKEN,
      body: { name: 'Dup' },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 500);
  assertEquals(data.error, 'Failed to create API key');
  assertEquals(data.details, 'duplicate key value violates unique constraint');
});

Deno.test(
  'generate-api-key: error shape is consistent { error, details }',
  async () => {
    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      insertResults: {
        RoseApiKey: {
          data: null,
          error: { message: 'connection timeout' },
        },
      },
      captures: [],
    });

    const response = await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: { name: 'X' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 500);
    assertEquals(typeof data.error, 'string');
    assertEquals(typeof data.details, 'string');
  },
);

Deno.test(
  'generate-api-key: generated API key is 32 chars without dashes',
  async () => {
    const captures: BoundaryCapture[] = [];

    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      insertResults: {
        RoseApiKey: {
          data: {
            id: 'key-003',
            apiKey: 'c'.repeat(32),
            createdAt: '2026-01-15T12:00:00.000Z',
          },
          error: null,
        },
      },
      captures,
    });

    await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: { name: 'HexTest' },
      }),
    );

    const insertCapture = captures.find((c) => c.type === 'db.insert');
    assertExists(insertCapture);
    // deno-lint-ignore no-explicit-any
    const generatedKey = (insertCapture!.data as any).apiKey as string;
    assertEquals(generatedKey.length, 32);
    assertEquals(generatedKey.includes('-'), false);
  },
);

// ============================================================================
// GET /api-keys
// ============================================================================

Deno.test('api-keys: CORS preflight returns 200', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createListHandler, {
    user: TEST_USER,
    captures,
  });

  const response = await handler(
    new Request(`${BASE_URL}/api-keys`, { method: 'OPTIONS' }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(captures.length, 0);
});

Deno.test('api-keys: rejects request without auth', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createListHandler, {
    user: TEST_USER,
    captures,
  });

  const response = await handler(makeRequest('/api-keys'));
  const data = await parseJson(response);

  assertEquals(response.status, 401);
  assertEquals(data.error, 'Missing or invalid authorization header');
  assertEquals(captures.length, 0);
});

Deno.test('api-keys: rejects invalid JWT', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createListHandler, {
    user: null,
    authError: 'expired token',
    captures,
  });

  const response = await handler(
    makeRequest('/api-keys', { token: 'expired-token' }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 401);
  assertEquals(data.error, 'Unauthorized');
  assertEquals(
    captures.find((c) => c.type === 'auth.getUser')!.token,
    'expired-token',
  );
  assertEquals(captures.filter((c) => c.type.startsWith('db.')).length, 0);
});

Deno.test(
  'api-keys: returns empty array when user has no keys',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createListHandler, {
      user: TEST_USER,
      queryResults: { RoseApiKey: { data: [], error: null } },
      captures,
    });

    const response = await handler(
      makeRequest('/api-keys', { token: TEST_TOKEN }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    assertEquals(data.keys, []);

    const selectCapture = captures.find((c) => c.type === 'db.select');
    assertExists(selectCapture);
    assertEquals(selectCapture!.table, 'RoseApiKey');
    assertEquals(selectCapture!.filters!.userId, TEST_USER.id);
  },
);

Deno.test(
  'api-keys: returns masked keys for authenticated user',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createListHandler, {
      user: TEST_USER,
      queryResults: {
        RoseApiKey: {
          data: [
            {
              id: 'key-1',
              name: 'Production',
              apiKey: 'abcdef1234567890abcdef1234567890',
              createdAt: '2026-01-10T00:00:00Z',
            },
            {
              id: 'key-2',
              name: 'Dev',
              apiKey: 'xxxxyyyyzzzzwwwwxxxxyyyyzzzzwwww',
              createdAt: '2026-01-09T00:00:00Z',
            },
          ],
          error: null,
        },
      },
      captures,
    });

    const response = await handler(
      makeRequest('/api-keys', { token: TEST_TOKEN }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    // deno-lint-ignore no-explicit-any
    const keys = data.keys as any[];
    assertEquals(keys.length, 2);

    assertEquals(keys[0].id, 'key-1');
    assertEquals(keys[0].name, 'Production');
    assertEquals(keys[0].createdAt, '2026-01-10T00:00:00Z');
    assertEquals(keys[0].maskedApiKey, '...7890');
    assertEquals(keys[0].apiKey, undefined);

    assertEquals(keys[1].id, 'key-2');
    assertEquals(keys[1].maskedApiKey, '...wwww');
    assertEquals(keys[1].apiKey, undefined);
  },
);

Deno.test(
  'api-keys: maskedApiKey format is ...XXXX (7 chars total)',
  async () => {
    const handler = buildHandler(createListHandler, {
      user: TEST_USER,
      queryResults: {
        RoseApiKey: {
          data: [
            {
              id: 'key-1',
              name: 'A',
              apiKey: 'abcdefghijklmnopqrstuvwxyz123456',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          error: null,
        },
      },
      captures: [],
    });

    const response = await handler(
      makeRequest('/api-keys', { token: TEST_TOKEN }),
    );
    const data = await parseJson(response);

    // deno-lint-ignore no-explicit-any
    const key = (data.keys as any[])[0];
    assertEquals(key.maskedApiKey.startsWith('...'), true);
    assertEquals(key.maskedApiKey.length, 7);
    assertEquals(key.maskedApiKey, '...3456');
  },
);

Deno.test(
  'api-keys: handles null data from DB gracefully',
  async () => {
    const handler = buildHandler(createListHandler, {
      user: TEST_USER,
      queryResults: { RoseApiKey: { data: null, error: null } },
      captures: [],
    });

    const response = await handler(
      makeRequest('/api-keys', { token: TEST_TOKEN }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    assertEquals(data.keys, []);
  },
);

Deno.test('api-keys: handles DB query error', async () => {
  const handler = buildHandler(createListHandler, {
    user: TEST_USER,
    queryResults: {
      RoseApiKey: {
        data: null,
        error: { message: 'relation not found' },
      },
    },
    captures: [],
  });

  const response = await handler(
    makeRequest('/api-keys', { token: TEST_TOKEN }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 500);
  assertEquals(data.error, 'Failed to fetch API keys');
  assertEquals(data.details, 'relation not found');
});

Deno.test('api-keys: response Content-Type is application/json', async () => {
  const handler = buildHandler(createListHandler, {
    user: TEST_USER,
    queryResults: { RoseApiKey: { data: [], error: null } },
    captures: [],
  });

  const response = await handler(
    makeRequest('/api-keys', { token: TEST_TOKEN }),
  );
  assertEquals(response.headers.get('Content-Type'), 'application/json');
});

// ============================================================================
// DELETE /delete-api-key
// ============================================================================

Deno.test('delete-api-key: CORS preflight returns 200', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createDeleteHandler, {
    user: TEST_USER,
    captures,
  });

  const response = await handler(
    new Request(`${BASE_URL}/delete-api-key`, { method: 'OPTIONS' }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(captures.length, 0);
});

Deno.test('delete-api-key: rejects request without auth', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createDeleteHandler, {
    user: TEST_USER,
    captures,
  });

  const response = await handler(
    makeRequest('/delete-api-key', {
      method: 'DELETE',
      body: { keyId: 'key-1' },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 401);
  assertEquals(data.error, 'Missing or invalid authorization header');
  assertEquals(captures.length, 0);
});

Deno.test('delete-api-key: rejects invalid JWT', async () => {
  const captures: BoundaryCapture[] = [];
  const handler = buildHandler(createDeleteHandler, {
    user: null,
    captures,
  });

  const response = await handler(
    makeRequest('/delete-api-key', {
      method: 'DELETE',
      token: 'bad-jwt',
      body: { keyId: 'key-1' },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 401);
  assertEquals(data.error, 'Unauthorized');
  assertEquals(
    captures.find((c) => c.type === 'auth.getUser')!.token,
    'bad-jwt',
  );
});

Deno.test(
  'delete-api-key: returns 400 when keyId is missing',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures,
    });

    const response = await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: {},
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 400);
    assertEquals(data.error, 'Missing required field: keyId');
    assertEquals(
      captures.filter((c) => c.type.startsWith('db.')).length,
      0,
    );
  },
);

Deno.test(
  'delete-api-key: returns 400 when keyId is null',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures,
    });

    const response = await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: null },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 400);
    assertEquals(data.error, 'Missing required field: keyId');
  },
);

Deno.test(
  'delete-api-key: returns 400 when keyId is empty string',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures,
    });

    const response = await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: '' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 400);
    assertEquals(data.error, 'Missing required field: keyId');
  },
);

Deno.test(
  'delete-api-key: successfully deletes key owned by user',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      deleteResults: { RoseApiKey: { data: null, error: null } },
      captures,
    });

    const response = await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: 'key-to-delete' },
      }),
    );
    const data = await parseJson(response);

    assertEquals(response.status, 200);
    assertEquals(data.success, true);
    assertEquals(data.message, 'API key deleted successfully');

    const deleteCapture = captures.find((c) => c.type === 'db.delete');
    assertExists(deleteCapture);
    assertEquals(deleteCapture!.table, 'RoseApiKey');
    assertEquals(deleteCapture!.filters!.id, 'key-to-delete');
    assertEquals(deleteCapture!.filters!.userId, TEST_USER.id);
  },
);

Deno.test(
  'delete-api-key: tenant isolation - delete filters by userId',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: { id: 'user-attacker', email: 'evil@test.com' },
      deleteResults: { RoseApiKey: { data: null, error: null } },
      captures,
    });

    await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: 'victim-key-id' },
      }),
    );

    const deleteCapture = captures.find((c) => c.type === 'db.delete');
    assertExists(deleteCapture);
    assertEquals(deleteCapture!.filters!.userId, 'user-attacker');
    assertEquals(deleteCapture!.filters!.id, 'victim-key-id');
  },
);

Deno.test('delete-api-key: handles DB delete error', async () => {
  const handler = buildHandler(createDeleteHandler, {
    user: TEST_USER,
    deleteResults: {
      RoseApiKey: {
        data: null,
        error: { message: 'foreign key constraint' },
      },
    },
    captures: [],
  });

  const response = await handler(
    makeRequest('/delete-api-key', {
      method: 'DELETE',
      token: TEST_TOKEN,
      body: { keyId: 'key-1' },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 500);
  assertEquals(data.error, 'Failed to delete API key');
  assertEquals(data.details, 'foreign key constraint');
});

// ============================================================================
// Cross-cutting invariants
// ============================================================================

Deno.test(
  'invariant: all error responses have { error: string } shape',
  async () => {
    const errorResponses: { name: string; response: Response }[] = [];

    const h1 = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      captures: [],
    });
    errorResponses.push({
      name: 'generate no-auth',
      response: await h1(
        makeRequest('/generate-api-key', { method: 'POST', body: {} }),
      ),
    });

    const h2 = buildHandler(createGenerateHandler, {
      user: null,
      captures: [],
    });
    errorResponses.push({
      name: 'generate bad-jwt',
      response: await h2(
        makeRequest('/generate-api-key', {
          method: 'POST',
          token: 'bad',
          body: {},
        }),
      ),
    });

    const h3 = buildHandler(createListHandler, {
      user: TEST_USER,
      captures: [],
    });
    errorResponses.push({
      name: 'list no-auth',
      response: await h3(makeRequest('/api-keys')),
    });

    const h4 = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures: [],
    });
    errorResponses.push({
      name: 'delete no-auth',
      response: await h4(
        makeRequest('/delete-api-key', {
          method: 'DELETE',
          body: { keyId: 'x' },
        }),
      ),
    });

    const h5 = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures: [],
    });
    errorResponses.push({
      name: 'delete missing-keyId',
      response: await h5(
        makeRequest('/delete-api-key', {
          method: 'DELETE',
          token: TEST_TOKEN,
          body: {},
        }),
      ),
    });

    for (const { name, response } of errorResponses) {
      const data = await parseJson(response);
      assertEquals(
        typeof data.error,
        'string',
        `${name}: error field must be a string`,
      );
    }
  },
);

Deno.test(
  'invariant: auth boundary - all endpoints reject missing auth',
  async () => {
    const endpoints: {
      // deno-lint-ignore no-explicit-any
      factory: any;
      path: string;
      method: string;
      body?: unknown;
    }[] = [
      { factory: createListHandler, path: '/api-keys', method: 'GET' },
      {
        factory: createGenerateHandler,
        path: '/generate-api-key',
        method: 'POST',
        body: { name: 'x' },
      },
      {
        factory: createDeleteHandler,
        path: '/delete-api-key',
        method: 'DELETE',
        body: { keyId: 'x' },
      },
    ];

    for (const ep of endpoints) {
      const handler = buildHandler(ep.factory, {
        user: TEST_USER,
        captures: [],
      });
      const response = await handler(
        makeRequest(ep.path, { method: ep.method, body: ep.body }),
      );
      assertEquals(
        response.status,
        401,
        `${ep.method} ${ep.path} should return 401 without auth`,
      );
    }
  },
);

Deno.test(
  'invariant: auth boundary - all endpoints reject invalid JWT',
  async () => {
    const endpoints: {
      // deno-lint-ignore no-explicit-any
      factory: any;
      path: string;
      method: string;
      body?: unknown;
    }[] = [
      { factory: createListHandler, path: '/api-keys', method: 'GET' },
      {
        factory: createGenerateHandler,
        path: '/generate-api-key',
        method: 'POST',
        body: { name: 'x' },
      },
      {
        factory: createDeleteHandler,
        path: '/delete-api-key',
        method: 'DELETE',
        body: { keyId: 'x' },
      },
    ];

    for (const ep of endpoints) {
      const handler = buildHandler(ep.factory, {
        user: null,
        captures: [],
      });
      const response = await handler(
        makeRequest(ep.path, {
          method: ep.method,
          token: 'invalid',
          body: ep.body,
        }),
      );
      assertEquals(
        response.status,
        401,
        `${ep.method} ${ep.path} should return 401 for invalid JWT`,
      );
    }
  },
);

Deno.test(
  'invariant: CORS headers present on all responses',
  async () => {
    const scenarios: {
      // deno-lint-ignore no-explicit-any
      factory: any;
      req: Request;
    }[] = [
      {
        factory: createListHandler,
        req: makeRequest('/api-keys', { token: TEST_TOKEN }),
      },
      {
        factory: createListHandler,
        req: makeRequest('/api-keys'),
      },
      {
        factory: createGenerateHandler,
        req: makeRequest('/generate-api-key', {
          method: 'POST',
          token: TEST_TOKEN,
          body: { name: 'x' },
        }),
      },
      {
        factory: createDeleteHandler,
        req: makeRequest('/delete-api-key', {
          method: 'DELETE',
          token: TEST_TOKEN,
          body: { keyId: 'x' },
        }),
      },
    ];

    for (const s of scenarios) {
      const handler = buildHandler(s.factory, {
        user: TEST_USER,
        queryResults: { RoseApiKey: { data: [], error: null } },
        deleteResults: { RoseApiKey: { data: null, error: null } },
        captures: [],
      });
      const response = await handler(s.req);
      assertEquals(
        response.headers.get('Access-Control-Allow-Origin'),
        '*',
        `CORS missing on ${s.req.method} ${s.req.url}`,
      );
    }
  },
);

Deno.test(
  'invariant: tenant isolation - list queries filter by userId',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createListHandler, {
      user: { id: 'tenant-abc' },
      queryResults: { RoseApiKey: { data: [], error: null } },
      captures,
    });

    await handler(makeRequest('/api-keys', { token: TEST_TOKEN }));

    const selectCapture = captures.find((c) => c.type === 'db.select');
    assertExists(selectCapture);
    assertEquals(selectCapture!.filters!.userId, 'tenant-abc');
  },
);

Deno.test(
  'invariant: tenant isolation - generate inserts with userId',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: { id: 'tenant-xyz' },
      insertResults: {
        RoseApiKey: {
          data: {
            id: 'k',
            apiKey: 'd'.repeat(32),
            createdAt: '2026-01-01T00:00:00Z',
          },
          error: null,
        },
      },
      captures,
    });

    await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: { name: 'x' },
      }),
    );

    const insertCapture = captures.find((c) => c.type === 'db.insert');
    assertExists(insertCapture);
    // deno-lint-ignore no-explicit-any
    assertEquals((insertCapture!.data as any).userId, 'tenant-xyz');
  },
);

Deno.test(
  'invariant: tenant isolation - delete filters by both keyId AND userId',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: { id: 'tenant-999' },
      deleteResults: { RoseApiKey: { data: null, error: null } },
      captures,
    });

    await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: 'target-key' },
      }),
    );

    const deleteCapture = captures.find((c) => c.type === 'db.delete');
    assertExists(deleteCapture);
    assertEquals(deleteCapture!.filters!.id, 'target-key');
    assertEquals(deleteCapture!.filters!.userId, 'tenant-999');
  },
);

Deno.test(
  'invariant: same-input reproducibility',
  async () => {
    const dbData = [
      {
        id: 'k1',
        name: 'A',
        apiKey: 'a'.repeat(32),
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const handler = buildHandler(createListHandler, {
        user: TEST_USER,
        queryResults: { RoseApiKey: { data: dbData, error: null } },
        captures: [],
      });
      const response = await handler(
        makeRequest('/api-keys', { token: TEST_TOKEN }),
      );
      results.push(await response.text());
    }

    assertEquals(results[0], results[1]);
    assertEquals(results[1], results[2]);
  },
);

Deno.test(
  'invariant: validation failures produce zero boundary DB calls',
  async () => {
    const endpoints: {
      // deno-lint-ignore no-explicit-any
      factory: any;
      method: string;
      body?: unknown;
    }[] = [
      { factory: createListHandler, method: 'GET' },
      { factory: createGenerateHandler, method: 'POST', body: { name: 'x' } },
      {
        factory: createDeleteHandler,
        method: 'DELETE',
        body: { keyId: 'x' },
      },
    ];

    for (const ep of endpoints) {
      const captures: BoundaryCapture[] = [];
      const handler = buildHandler(ep.factory, {
        user: TEST_USER,
        captures,
      });
      await handler(
        makeRequest('/test', { method: ep.method, body: ep.body }),
      );
      assertEquals(
        captures.filter((c) => c.type.startsWith('db.')).length,
        0,
        'No DB calls should happen when auth is missing',
      );
    }
  },
);

Deno.test(
  'invariant: delete with missing keyId produces zero DB calls',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      captures,
    });

    await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: {},
      }),
    );

    assertEquals(
      captures.filter((c) => c.type.startsWith('db.')).length,
      0,
      'No DB delete should happen when keyId is missing',
    );
  },
);

// ============================================================================
// Boundary call ordering
// ============================================================================

Deno.test(
  'boundary: generate-api-key call order is auth.getUser -> db.insert',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createGenerateHandler, {
      user: TEST_USER,
      insertResults: {
        RoseApiKey: {
          data: {
            id: 'k',
            apiKey: 'e'.repeat(32),
            createdAt: '2026-01-01T00:00:00Z',
          },
          error: null,
        },
      },
      captures,
    });

    await handler(
      makeRequest('/generate-api-key', {
        method: 'POST',
        token: TEST_TOKEN,
        body: { name: 'Order Test' },
      }),
    );

    assertEquals(captures.length, 2);
    assertEquals(captures[0].type, 'auth.getUser');
    assertEquals(captures[1].type, 'db.insert');
  },
);

Deno.test(
  'boundary: list-api-keys call order is auth.getUser -> db.select',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createListHandler, {
      user: TEST_USER,
      queryResults: { RoseApiKey: { data: [], error: null } },
      captures,
    });

    await handler(makeRequest('/api-keys', { token: TEST_TOKEN }));

    assertEquals(captures.length, 2);
    assertEquals(captures[0].type, 'auth.getUser');
    assertEquals(captures[1].type, 'db.select');
  },
);

Deno.test(
  'boundary: delete-api-key call order is auth.getUser -> db.delete',
  async () => {
    const captures: BoundaryCapture[] = [];
    const handler = buildHandler(createDeleteHandler, {
      user: TEST_USER,
      deleteResults: { RoseApiKey: { data: null, error: null } },
      captures,
    });

    await handler(
      makeRequest('/delete-api-key', {
        method: 'DELETE',
        token: TEST_TOKEN,
        body: { keyId: 'x' },
      }),
    );

    assertEquals(captures.length, 2);
    assertEquals(captures[0].type, 'auth.getUser');
    assertEquals(captures[1].type, 'db.delete');
  },
);
