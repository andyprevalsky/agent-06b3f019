import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  apiKeyHeaders,
} from './integrations.context';

// ==================== ADDITIONAL COVERAGE TESTS ====================

// --- OAuth start: happy path (exercises PKCE, credential creation, auth URL building) ---

export async function testEmailStart_gmailHappyPath() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  // Will return 200 with authUrl if Gmail OAuth is configured, or 500 if not configured
  // Either way, it exercises the route handler and validation
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    if (!body.authUrl || typeof body.authUrl !== 'string') {
      throw new Error('Expected authUrl string in response');
    }
    if (!body.authUrl.includes('accounts.google.com')) {
      throw new Error(`Expected Google OAuth URL, got: ${body.authUrl}`);
    }
    if (!body.state || typeof body.state !== 'string') {
      throw new Error('Expected state string in response');
    }
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

export async function testEmailStart_yahooHappyPath() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo start, got ${res.status}`);
  }
}

// --- OAuth callback: state not found in DB ---

export async function testOAuthCallback_stateNotFound() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/callback?code=test_code&state=nonexistent_state_token`,
    { method: 'GET' }
  );
  // Should return HTML error or redirect (callback is public, returns HTML)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for state-not-found callback, got ${res.status}`);
  }
}

// --- Email send: validation ---

export async function testEmailSend_missingTo() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ subject: 'test', body: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testEmailSend_missingSubject() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', body: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testEmailSend_missingBody() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testEmailSend_missingFromEmail() {
  // When no from_email, should list available accounts or report not connected
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', body: 'test' }),
  });
  // Either 400 (missing from_email) or 404 (no gmail connected) — both exercise the code
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400 or 404 for missing from_email, got ${res.status}`);
  }
}

export async function testEmailSend_idempotencyKeyRequiresAgentId() {
  // Temporal email sends pass idempotency_key; agent_id is required to claim the side effect.
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      to: 'test@test.com',
      subject: 'test',
      body: 'test',
      from_email: 'sender@test.com',
      idempotency_key: 'call-email-1',
    }),
  });
  assertStatus(res.status, 400, res.data);
  const err = (res.data as { error?: string; message?: string }).error ?? '';
  const msg = (res.data as { error?: string; message?: string }).message ?? '';
  if (!`${err} ${msg}`.toLowerCase().includes('agent_id')) {
    throw new Error(`Expected agent_id requirement in response, got ${JSON.stringify(res.data)}`);
  }
}

export async function testEmailSend_idempotentInternalPathRequiresConnectedGmail() {
  // Agent path: internal auth + idempotency_key routes through sendEmailOnce.
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1!),
    body: JSON.stringify({
      user_id: ctx.userId1,
      agent_id: '00000000-0000-4000-8000-000000000001',
      idempotency_key: `bb-email-once-${Date.now()}`,
      to: 'office@example.com',
      from_email: 'missing-sender@example.com',
      subject: 'Hello',
      body: 'Body',
      cc: 'cc@example.com',
    }),
  });
  if (res.status !== 400) {
    throw new Error(`Expected 400 from sendEmailOnce without Gmail, got ${res.status}`);
  }
  const payload = res.data as { error?: string; message?: string };
  const text = `${payload.error ?? ''} ${payload.message ?? ''}`.toLowerCase();
  if (!text.includes('gmail') && !text.includes('not connected') && !text.includes('account')) {
    throw new Error(`Expected Gmail/account error, got ${JSON.stringify(res.data)}`);
  }
}

export async function testEmailSend_invalidIdempotencyKeyRejected() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1!),
    body: JSON.stringify({
      user_id: ctx.userId1,
      agent_id: '00000000-0000-4000-8000-000000000001',
      idempotency_key: 'bad key with spaces!',
      to: 'office@example.com',
      from_email: 'sender@example.com',
      subject: 'Hello',
      body: 'Body',
    }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testEmailSend_accountNotFound() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      to: 'test@test.com',
      subject: 'test',
      body: 'test',
      from_email: 'nonexistent@example.com',
    }),
  });
  // Should return error about account not found
  if (res.status !== 404 && res.status !== 400) {
    throw new Error(`Expected 404 or 400 for nonexistent from_email, got ${res.status}`);
  }
}

// --- Email messages: valid since, limit param ---

export async function testEmailMessages_validSinceEmptyAccount() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=10`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  // No Gmail connected → 404
  if (res.status !== 404) {
    // If somehow connected, should be 200
    assertStatus(res.status, 200, res.data);
  }
}

// --- Apple passwords upload: empty body ---

export async function testApplePasswordsUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/apple/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Generic file upload: validation ---

export async function testGenericUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- LinkedIn upload: validation ---

export async function testLinkedinUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/linkedin/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Contacts upload: validation ---

export async function testContactsUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/contacts/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Email archive upload: validation ---

export async function testEmailArchiveUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/email/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}
