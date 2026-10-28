import {
  encryptNonArray,
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  assert,
  encryptPayload,
  crypto,
  prisma,
} from './integrations.context';
import {
  ErrorResponse,
  CookiesUploadResponse,
  LocalStorageUploadResponse,
} from './integrations.schemas';

// ---------- /cookies/upload ----------

/** Cookies decoded payload is not an array → 400 (route line 81-82). */
export async function testCookiesUpload_decodedNotArray() {
  const encrypted = encryptNonArray();
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'cookies non-array');
  assert(
    body.error.toLowerCase().includes('expected array'),
    `Expected "expected array" error, got: ${body.error}`
  );
}

/**
 * Cookies happy path with > 100 cookies (forces multi-batch path at
 * uploadService.browser.ts:208) AND in-batch duplicates (exercises dedupeBatch
 * lines 89-95 — both newExpiry > existingExpiry and newExpiry <= existingExpiry
 * branches plus the dupCount > 0 logging branch at 212-219). Also intentionally
 * omits timestamp fields on alternating cookies to hit the "undefined" branches
 * (lines 117-119, 123-125, 127-129, 136-138) in buildCookieParams.
 */
export async function testCookiesUpload_largeBatchWithDuplicates() {
  const cookies: Record<string, unknown>[] = [];
  // 110 unique cookies → ensures a 2nd batch (BATCH_SIZE=100)
  for (let i = 0; i < 110; i++) {
    cookies.push({
      host_key: `.example${i}.com`,
      name: `cookie_${i}`,
      value: `value_${i}`,
      path: '/',
      // Alternate: even indices omit timestamps (hits undefined branches);
      // odd indices include them (hits the BigInt-conversion branches).
      ...(i % 2 === 0
        ? {}
        : {
            expires_utc: '13300000000000000',
            creation_utc: '13290000000000000',
            last_access_utc: '13290000000000001',
            last_update_utc: '13290000000000001',
          }),
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    });
  }
  // Add intra-batch duplicates IN THE FIRST BATCH (cookie_5 at idx 5).
  // Insert two duplicates ALSO within first 100 indices so they share a batch.
  // Duplicate of cookie_5 with LATER expiry → triggers "newExpiry > existingExpiry" (line 93-95).
  cookies.splice(50, 0, {
    host_key: '.example5.com',
    name: 'cookie_5',
    value: 'newer_5',
    path: '/',
    expires_utc: '13400000000000000',
    is_secure: true,
    is_httponly: false,
    top_frame_site_key: '',
  });
  // Duplicate of cookie_7 (which has expires_utc) with EARLIER expiry → keeps existing.
  cookies.splice(60, 0, {
    host_key: '.example7.com',
    name: 'cookie_7',
    value: 'older_7',
    path: '/',
    expires_utc: '10000000000000000',
    is_secure: true,
    is_httponly: false,
    top_frame_site_key: '',
  });
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CookiesUploadResponse, res.data, 'cookies large batch');
  // cookieCount is sanitized (post-filter) input length, NOT post-dedupe.
  // We sent 112 valid cookies (110 + 2 duplicates), all pass filter → 112.
  assert(body.cookieCount === 112, `Expected cookieCount=112, got ${body.cookieCount}`);
}

/** Cookies with empty name/value get filtered out (line 171 filter branch). */
export async function testCookiesUpload_emptyNameValueFiltered() {
  const cookies = [
    { host_key: '.example.com', name: '', value: 'v', path: '/' }, // dropped
    { host_key: '.example.com', name: 'n', value: '', path: '/' }, // dropped
    {
      host_key: '.example.com',
      name: 'real',
      value: 'real_value',
      path: '/',
      top_frame_site_key: '',
    }, // kept
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { cookieCount: number };
  assert(body.cookieCount === 1, `Expected cookieCount=1 after filter, got ${body.cookieCount}`);
}

/** Cookies happy path on an alternate browser type — exercises non-default branch. */
export async function testCookiesUpload_alternateBrowser() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'edge_cookie',
      value: 'edge_val',
      path: '/',
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'edge' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CookiesUploadResponse, res.data, 'cookies edge');
}

/** Safari cookies are a first-class browser credential source. */
export async function testCookiesUpload_safariBrowser() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'safari_cookie',
      value: 'safari_val',
      path: '/',
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'safari' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CookiesUploadResponse, res.data, 'cookies safari');
  assert(
    body.integration.name === 'safari',
    `Expected safari integration, got ${body.integration.name}`
  );
}

// ---------- /localStorage/upload ----------

/** localStorage decryption failure → 400 (route line 124-128). */
export async function testLocalStorageUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'localStorage bad encryption');
  assert(
    body.error.toLowerCase().includes('decrypt') ||
      body.error.toLowerCase().includes('localstorage'),
    `Expected decrypt error, got: ${body.error}`
  );
}

/** localStorage decoded byOrigin missing → 400 (route line 135-138). */
export async function testLocalStorageUpload_missingByOrigin() {
  const encrypted = encryptPayload({
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
    // No byOrigin
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'localStorage missing byOrigin');
  assert(
    body.error.toLowerCase().includes('byorigin'),
    `Expected byOrigin error, got: ${body.error}`
  );
}

/** localStorage byOrigin is null → 400 (covers null branch at routes.browser.ts:132). */
export async function testLocalStorageUpload_nullByOrigin() {
  const encrypted = encryptPayload({
    byOrigin: null,
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** localStorage byOrigin not an object → 400 (line 133 branch). */
export async function testLocalStorageUpload_notObjectByOrigin() {
  const encrypted = encryptPayload({
    byOrigin: 'not-an-object',
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/**
 * localStorage with orphan UTF-16 surrogates → exercises sanitizeStringFull
 * surrogate-handling branches (uploadService.browser.ts lines 35-41).
 */
export async function testLocalStorageUpload_orphanSurrogates() {
  // Build a string with: high surrogate followed by another high surrogate (orphan high),
  // a lone low surrogate (no preceding high), and a valid surrogate pair.
  const orphanHigh = '\uD800\uD800X'; // first high without low → drop first
  const orphanLow = '\uDC00Y'; // low without preceding high → drop low
  const validPair = '😀'; // 😀 — valid surrogate pair, kept as 2 chars
  const messyValue = `${orphanHigh}${orphanLow}${validPair}`;
  const payload = {
    byOrigin: {
      'https://surrogate.example': [{ key: 'surrogate_key', value: messyValue }],
    },
    hashes: { 'https://surrogate.example': 'h' },
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
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage surrogates');
}

/** localStorage compressed=true happy path — exercises gzip decompress branch in service. */
export async function testLocalStorageUpload_compressedTrue() {
  const zlib = await import('zlib');
  const { promisify } = await import('util');
  const gzip = promisify(zlib.gzip);
  const payload = {
    byOrigin: {
      'https://compressed.example': [{ key: 'k', value: 'v' }],
    },
    hashes: { 'https://compressed.example': 'h2' },
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 1,
    originCount: 1,
  };
  const compressed = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const encryptedBuf = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: encryptedBuf.toString('hex'),
      iv: iv.toString('hex'),
      key: aesKey.toString('hex'),
      compressed: 'true',
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage compressed');
}

// ---------- /indexedDB/upload ----------

/** indexedDB missing fields → 400 (route line 154-156). */
export async function testIndexedDBUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'indexedDB missing fields');
}

/** indexedDB decryption failure → 400 (route line 167-171). */
export async function testIndexedDBUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'indexedDB bad encryption');
}

/** indexedDB origins missing → 400 (route line 178-181). */
export async function testIndexedDBUpload_missingOrigins() {
  const encrypted = encryptPayload({
    batchIndex: 0,
    totalBatches: 1,
    hashes: {},
    // No origins
  });
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** indexedDB origins not array → 400. */
export async function testIndexedDBUpload_originsNotArray() {
  const encrypted = encryptPayload({
    origins: 'not-array',
    batchIndex: 0,
    totalBatches: 1,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** indexedDB with errored origins (filtered out by service.processIndexedDBUpload). */
export async function testIndexedDBUpload_erroredOriginsFiltered() {
  const payload = {
    origins: [
      { origin: 'https://errored.example', error: 'failed-to-read', databases: [] },
      { origin: 'https://ok.example', databases: [{ name: 'db', objectStores: [] }] },
    ],
    hashes: { 'https://ok.example': 'h' },
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
  const body = res.data as { originCount: number };
  // errored origin should be filtered out → only 1 remains
  assert(body.originCount === 1, `Expected originCount=1 after filter, got ${body.originCount}`);
}

/**
 * indexedDB values containing NUL must not 500 the whole batch (prod 22P05
 * "unsupported Unicode escape sequence", 2026-10-15..10-28). jsonb cannot
 * store U+0000, so it is dropped like the cookie/localStorage paths do; a
 * literal backslash-u0000 text and the client hash are preserved.
 */
export async function testIndexedDBUpload_nulCharactersStripped() {
  const origin = `https://nul-${crypto.randomBytes(4).toString('hex')}.example`;
  const value = { a: 'x\u0000y', b: 'raw\u0000nul', literal: 'keep\\u0000text' };
  const payload = {
    origins: [
      { origin, databases: [{ name: 'db', objectStores: [{ name: 's', records: [value] }] }] },
    ],
    hashes: { [origin]: 'nul-hash-1' },
    batchIndex: 0,
    totalBatches: 1,
  };
  // JSON.stringify writes the NUL char as the escape sequence \u0000; also splice a
  // raw NUL char into a string to cover both encodings.
  const json = JSON.stringify(payload).replace('raw\\u0000nul', 'raw\u0000nul');
  const upload = async (plaintext: string) => {
    // Encrypt the exact text (not a re-serialized object) so a raw NUL survives.
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken1!),
      body: JSON.stringify({ data, iv: iv.toString('hex'), key: aesKey.toString('hex') }),
    });
  };
  const res = await upload(json);
  assertStatus(res.status, 200, res.data);
  assert((res.data as { originCount: number }).originCount === 1, 'NUL origin must be ingested');

  const row = await prisma.indexedDBOrigin.findUnique({
    where: { userId_origin: { userId: ctx.userId1!, origin } },
    select: { databases: true, hash: true, updatedAt: true },
  });
  assert(row !== null, 'NUL origin row must be stored');
  const stored = JSON.stringify(row!.databases);
  assert(
    stored.includes('"xy"') && stored.includes('"rawnul"'),
    `NUL must be dropped, got ${stored}`
  );
  assert(
    stored.includes('keep\\\\u0000text'),
    `literal backslash-u0000 text must survive, got ${stored}`
  );
  assert(row!.hash === 'nul-hash-1', 'client hash must be stored unchanged');

  const again = await upload(json);
  assertStatus(again.status, 200, again.data);
  const after = await prisma.indexedDBOrigin.findUnique({
    where: { userId_origin: { userId: ctx.userId1!, origin } },
    select: { updatedAt: true },
  });
  assert(
    after!.updatedAt.getTime() === row!.updatedAt.getTime(),
    'same-hash re-upload must stay a no-op'
  );
  await prisma.indexedDBOrigin.deleteMany({ where: { userId: ctx.userId1!, origin } });
}

// ---------- /fingerprint/upload ----------

/** fingerprint decryption failure → 400 (route line 205-209). */
export async function testFingerprintUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint bad encryption');
}
