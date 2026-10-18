import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  encryptPayload,
  crypto,
  assert,
  createAnonSession,
  impersonatedTokenFor,
  MACHINE_DATA_INGEST_ROUTES,
  prisma,
} from './integrations.context';
import {
  ErrorResponse,
  CookiesUploadResponse,
  LocalStorageUploadResponse,
  IndexedDBUploadResponse,
  FingerprintUploadResponse,
  PermissionsUploadResponse,
  CacheStorageUploadResponse,
  PasswordsUploadResponse,
} from './integrations.schemas';

// ==================== ENCRYPTED PAYLOAD UPLOADS ====================

export async function testCookiesUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x', iv: 'y' }), // missing key
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies missing fields');
}

export async function testCookiesUpload_invalidBrowser() {
  const encrypted = encryptPayload([]);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'firefox' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies invalid browser');
}

export async function testCookiesUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies bad encryption');
}

export async function testCookiesUpload_happyPath() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'test_cookie',
      value: 'test_value',
      path: '/',
      expires_utc: '13300000000000000',
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CookiesUploadResponse, res.data, 'cookies happy');
  const body = res.data as { cookieCount: number };
  assert(body.cookieCount === 1, `Expected cookieCount=1, got ${body.cookieCount}`);
}

/**
 * No machine-data ingest route may accept an impersonated session.
 *
 * Runs against a dedicated target user: a cookie upload is a SNAPSHOT — an empty
 * array deletes that browser's stored cookies — so sharing a user with the other
 * upload tests would let this test destroy their fixtures (and vice versa).
 */
export async function testMachineDataIngest_rejectsImpersonatedSession() {
  const [target, operator] = await Promise.all([createAnonSession(), createAnonSession()]);
  const token = impersonatedTokenFor(target.userId, operator.userId);
  const accepted: string[] = [];

  for (const route of MACHINE_DATA_INGEST_ROUTES) {
    const method = route.method ?? 'POST';
    const payload = route.body();
    const res = await request(`${BASE_URL}${route.path}`, {
      method,
      headers: authHeaders(token),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    // 403 is the only correct answer. A 400/422 would mean the request merely
    // failed validation, which does not prove containment, so those count as
    // accepted too — the guard must reject BEFORE any payload parsing.
    if (res.status !== 403) accepted.push(`${route.path} -> ${res.status}`);
  }

  assert(
    accepted.length === 0,
    `machine-data ingest accepted an impersonated session on ${accepted.length}/` +
      `${MACHINE_DATA_INGEST_ROUTES.length} route(s): ${accepted.join(', ')}`
  );
}

/**
 * The containment must be a real write barrier, not just a status code: assert
 * the operator's cookie never lands in the viewed user's account.
 */
export async function testCookiesUpload_impersonatedSessionWritesNothing() {
  const [target, operator] = await Promise.all([createAnonSession(), createAnonSession()]);
  const token = impersonatedTokenFor(target.userId, operator.userId);
  const domain = '.operator-machine-leak.test';
  const encrypted = encryptPayload([
    {
      host_key: domain,
      name: 'operator_machine_cookie',
      value: 'leaked-secret',
      path: '/',
      expires_utc: '13300000000000000',
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    },
  ]);

  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 403, res.data);

  const leaked = await prisma.cookie.count({ where: { userId: target.userId, domain } });
  assert(
    leaked === 0,
    `operator machine cookie leaked into the impersonated account: ${leaked} row(s) for ${domain}`
  );
}

/** Containment must not touch ordinary sessions — the same upload still works. */
export async function testCookiesUpload_ownSessionStillAccepted() {
  const own = await createAnonSession();
  const domain = '.own-session-allowed.test';
  const encrypted = encryptPayload([
    {
      host_key: domain,
      name: 'own_cookie',
      value: 'kept',
      path: '/',
      expires_utc: '13300000000000000',
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    },
  ]);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(own.accessToken),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  const stored = await prisma.cookie.count({ where: { userId: own.userId, domain } });
  assert(stored === 1, `own-session upload should persist 1 cookie, found ${stored}`);
}

export async function testLocalStorageUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }), // missing iv and key
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'localStorage missing fields');
}

export async function testLocalStorageUpload_happyPath() {
  const payload = {
    byOrigin: {
      'https://example.com': [{ key: 'testKey', value: 'testValue' }],
    },
    hashes: { 'https://example.com': 'abc123' },
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 1,
    originCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage happy');
}

export async function testIndexedDBUpload_happyPath() {
  const payload = {
    origins: [
      {
        origin: 'https://example.com',
        databases: [
          {
            name: 'testDB',
            objectStores: [{ name: 'store1', records: [{ key: 'k1', value: 'v1' }] }],
          },
        ],
      },
    ],
    hashes: { 'https://example.com': 'hash123' },
    batchIndex: 0,
    totalBatches: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(IndexedDBUploadResponse, res.data, 'indexedDB happy');
}

export async function testFingerprintUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint missing fields');
}

export async function testFingerprintUpload_invalidPayload() {
  const encrypted = encryptPayload({ foo: 'bar' }); // missing navigator and screen
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint invalid');
}

export async function testFingerprintUpload_happyPath() {
  const fingerprint = {
    navigator: { userAgent: 'TestAgent/1.0', language: 'en-US', platform: 'MacIntel' },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
  };
  const encrypted = encryptPayload(fingerprint);
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(FingerprintUploadResponse, res.data, 'fingerprint happy');
}

export async function testPermissionsUpload_happyPath() {
  const payload = {
    grants: [{ origin: 'https://example.com', permission: 'notifications', setting: 1 }],
    hash: 'perms_hash',
    grantCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PermissionsUploadResponse, res.data, 'permissions happy');
}

export async function testCacheStorageUpload_happyPath() {
  const payload = {
    origins: [{ origin: 'https://example.com', caches: [{ name: 'v1', size: 100 }] }],
    hashes: { 'https://example.com': 'cs_hash' },
    originCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CacheStorageUploadResponse, res.data, 'cacheStorage happy');
}

export async function testPasswordsUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords missing fields');
}

export async function testPasswordsUpload_happyPath() {
  const payload = {
    passwords: [
      {
        origin: 'https://example.com',
        username: 'testuser',
        encryptedPassword: 'encrypted_data_here',
        dateLastUsed: Date.now(),
        dateCreated: Date.now(),
        browserSource: 'chrome',
      },
    ],
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PasswordsUploadResponse, res.data, 'passwords happy');
}

export async function testPasswordsUpload_appleSourceMarksApplePasswordsIntegration() {
  const { accessToken, userId } = await createAnonSession();
  const payload = {
    passwords: [
      {
        origin: 'https://apple-transfer.example',
        username: 'apple-user',
        encryptedPassword: 'encrypted_apple_password_here',
        dateLastUsed: Date.now(),
        dateCreated: Date.now(),
        browserSource: 'apple_passwords',
      },
    ],
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PasswordsUploadResponse, res.data, 'passwords apple source');

  const appleIntegration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'apple_passwords', accountId: '' } },
  });
  assert(appleIntegration !== null, 'Expected apple_passwords integration to be marked connected');
  assert(
    appleIntegration.status === 'CONNECTED',
    `Expected CONNECTED, got ${appleIntegration.status}`
  );
}
