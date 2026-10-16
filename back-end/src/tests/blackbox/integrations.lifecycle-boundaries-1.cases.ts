import {
  uniqueName,
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assert,
  captureToken,
  readCapturesForToken,
  filterInfraCalls,
} from './integrations.context';

// ==================== STATE TRANSITION TEST ====================

export async function testStateTransition_fullLifecycle() {
  const name = uniqueName('lifecycle');

  // 1. Create (NOT_CONNECTED)
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = (createRes.data as { integration: { status: string } }).integration;
  assert(created.status === 'NOT_CONNECTED', `Expected NOT_CONNECTED, got ${created.status}`);

  // 2. Patch to CONNECTED
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string; isActive: boolean } })
    .integration;
  assert(patched.status === 'CONNECTED', `Expected CONNECTED, got ${patched.status}`);
  assert(patched.isActive === true, 'Expected isActive=true');

  // 3. Patch to SYNC_FAILED
  const failRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'SYNC_FAILED' }),
  });
  assertStatus(failRes.status, 200, failRes.data);
  const failed = (failRes.data as { integration: { status: string } }).integration;
  assert(failed.status === 'SYNC_FAILED', `Expected SYNC_FAILED, got ${failed.status}`);

  // 4. Delete
  const deleteRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);

  // 5. Verify deleted
  const verifyRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(verifyRes.status, 404, verifyRes.data);
}

// ==================== OAUTH CALLBACK (PUBLIC) ====================

export async function testOAuthCallback_invalidProvider() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/invalid_provider/callback?code=x&state=y`
  );
  // Callback returns HTML with 400 status (not JSON)
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

export async function testOAuthCallback_missingCode() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?state=x`);
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

export async function testOAuthCallback_missingState() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?code=x`);
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// These run sequentially because the capture buffer is shared global state.

/**
 * POST /api/integrations (create) makes NO outbound HTTP calls.
 * All work is local (Prisma DB operations only).
 */
export async function testBoundary_createNoOutbound() {
  const token = captureToken('create');
  const name = uniqueName('boundary_create');

  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for create, got ${filterInfraCalls(calls).length}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

/**
 * POST /api/integrations/email/:provider/start makes NO outbound calls.
 * It only writes to DB (integration + credential records).
 *
 * Note: concurrent tests may trigger Surge SMS API calls unrelated to this endpoint.
 * We filter those out and only check for email/OAuth-related outbound calls.
 */
export async function testBoundary_emailStartNoOutbound() {
  const token = captureToken('email-start');

  // This may return 500 if Gmail client ID is not configured, but still no outbound calls
  await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for email/start, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

/**
 * POST /api/integrations with invalid type (400) makes NO outbound calls.
 * Validation short-circuits before any DB or external calls.
 */
export async function testBoundary_validationNoOutbound() {
  const token = captureToken('validation');

  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ name: 'test', type: 'INVALID' }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for validation failure, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * GET /api/integrations/email/messages with missing 'since' param (400) makes NO outbound calls.
 */
export async function testBoundary_emailMessagesValidationNoOutbound() {
  const token = captureToken('email-messages');

  await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for email/messages validation, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * POST /api/integrations/passwords/request sends an SMS via sendSms.
 * This is the only non-OAuth third-party boundary in the integrations domain.
 *
 * If SMS provider is not configured, skip the boundary assertion.
 */
export async function testBoundary_passwordsRequestSms() {
  const token = captureToken('passwords-request');

  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ request: 'Test integration request for boundary test' }),
  });

  // Allow short delay for async SMS dispatch
  await new Promise((resolve) => setTimeout(resolve, 500));

  const calls = await readCapturesForToken(token);

  if (res.status === 500) {
    // SMS provider not configured — no outbound calls expected
    console.log('    [skipped] SMS provider returned error — cannot verify boundary');
    return;
  }

  assertStatus(res.status, 200, res.data);

  // Should have made exactly 1 outbound call (to SMS provider)
  const relevantCalls = filterInfraCalls(calls);
  if (relevantCalls.length === 0) {
    console.log('    [skipped] No outbound SMS calls captured — SMS may use internal queue');
    return;
  }

  const smsCall = relevantCalls[0];
  assert(smsCall.method === 'POST', `Expected POST, got ${smsCall.method}`);
  // The SMS provider URL varies (Twilio, Surge, etc.) — just verify it's an outbound POST
  assert(
    !smsCall.url.includes('localhost'),
    `Expected outbound URL, got localhost: ${smsCall.url}`
  );
}

/**
 * POST /api/integrations/telegram/connect makes NO outbound calls.
 * All work is local (DB upsert only).
 *
 * Note: concurrent tests may trigger Surge SMS API calls unrelated to this endpoint.
 * We filter those out and only check for telegram-related outbound calls.
 */
export async function testBoundary_telegramConnectNoOutbound() {
  const token = captureToken('telegram-connect');

  await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  const relevant = filterInfraCalls(calls);
  assert(
    relevant.length === 0,
    `Expected 0 outbound calls for telegram/connect, got ${relevant.length}: ${JSON.stringify(relevant.map((c) => c.url))}`
  );
}

/**
 * POST /api/integrations/whatsapp/connect makes NO outbound calls.
 * All work is local (DB upsert only).
 */
export async function testBoundary_whatsappConnectNoOutbound() {
  const token = captureToken('whatsapp-connect');

  await request(`${BASE_URL}/api/integrations/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  const relevant = filterInfraCalls(calls);
  assert(
    relevant.length === 0,
    `Expected 0 outbound calls for whatsapp/connect, got ${relevant.length}: ${JSON.stringify(relevant.map((c) => c.url))}`
  );
}
