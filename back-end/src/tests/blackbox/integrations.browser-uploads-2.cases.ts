import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  crypto,
  encryptPayload,
  assert,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

// ---------- /permissions/upload ----------

/** permissions missing fields → 400 (route line 240-241). */
export async function testPermissionsUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'permissions missing fields');
}

/** permissions decryption failure → 400 (route line 247-251). */
export async function testPermissionsUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'permissions bad encryption');
}

/** permissions grants missing → 400 (route line 258-261). */
export async function testPermissionsUpload_missingGrants() {
  const encrypted = encryptPayload({ hash: 'x' }); // no grants
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** permissions grants not array → 400. */
export async function testPermissionsUpload_grantsNotArray() {
  const encrypted = encryptPayload({ grants: 'not-array' });
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** permissions empty grants array → 200 with grantCount=0 (skips bulk upsert). */
export async function testPermissionsUpload_emptyGrants() {
  const encrypted = encryptPayload({ grants: [], hash: 'h' });
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { grantCount: number };
  assert(body.grantCount === 0, `Expected grantCount=0, got ${body.grantCount}`);
}

// ---------- /cacheStorage/upload ----------

/** cacheStorage missing fields → 400 (route line 278-279). */
export async function testCacheStorageUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cacheStorage missing fields');
}

/** cacheStorage decryption failure → 400 (route line 290-294). */
export async function testCacheStorageUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cacheStorage bad encryption');
}

/** cacheStorage origins missing → 400 (route line 301-304). */
export async function testCacheStorageUpload_missingOrigins() {
  const encrypted = encryptPayload({ hashes: {} });
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** cacheStorage origins not array → 400. */
export async function testCacheStorageUpload_originsNotArray() {
  const encrypted = encryptPayload({ origins: { not: 'array' }, hashes: {} });
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

// ---------- /passwords/upload ----------

/** passwords decryption failure → 400 (route line 328-332). */
export async function testPasswordsUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords bad encryption');
}

/** passwords passwords missing → 400 (route line 339-342). */
export async function testPasswordsUpload_missingPasswords() {
  const encrypted = encryptPayload({}); // no passwords
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** passwords passwords not array → 400. */
export async function testPasswordsUpload_passwordsNotArray() {
  const encrypted = encryptPayload({ passwords: 'not-array' });
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** passwords empty array → 200 with "No passwords to upload" message branch. */
export async function testPasswordsUpload_emptyPasswords() {
  const encrypted = encryptPayload({ passwords: [] });
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 0, `Expected passwordCount=0, got ${body.passwordCount}`);
  assert(
    body.message.toLowerCase().includes('no passwords'),
    `Expected "no passwords" message, got: ${body.message}`
  );
}
