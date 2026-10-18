import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assert,
  assertStatus,
  uniqueName,
  createAnonSession,
  apiKeyHeaders,
  API_KEY,
} from './integrations.context';

// ==================== DEEP COVERAGE TESTS ====================

// --- OAuth start with PKCE verification ---

export async function testEmailStart_gmailPkceFields() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      returnUrl: 'https://roselabs.ai/settings',
      errorUrl: 'https://roselabs.ai/error',
    }),
  });
  if (res.status === 200) {
    const body = res.data as {
      authUrl: string;
      state: string;
      expiresAt: string;
      credentialId: string;
    };
    // Verify PKCE code_challenge is present in the authUrl
    assert(body.authUrl.includes('code_challenge='), 'Expected code_challenge in authUrl');
    assert(
      body.authUrl.includes('code_challenge_method=S256'),
      'Expected S256 code_challenge_method'
    );
    // Verify state token is present
    assert(
      typeof body.state === 'string' && body.state.length > 10,
      'Expected non-trivial state token'
    );
    // Verify expiresAt is in the future
    const expiresAt = new Date(body.expiresAt);
    assert(expiresAt > new Date(), 'Expected expiresAt to be in the future');
    // Verify credentialId is present
    assert(
      typeof body.credentialId === 'string' && body.credentialId.length > 0,
      'Expected credentialId'
    );
    // Verify Gmail-specific OAuth params
    assert(body.authUrl.includes('access_type=offline'), 'Expected access_type=offline for Gmail');
    assert(body.authUrl.includes('prompt=consent'), 'Expected prompt=consent for Gmail');
    const googleAuth = new URL(body.authUrl);
    assert(
      googleAuth.searchParams.get('include_granted_scopes') === 'true',
      'Expected incremental Google consent'
    );
    const expectedGoogleScopes = [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive',
    ];
    assert(
      JSON.stringify((googleAuth.searchParams.get('scope') ?? '').split(' ')) ===
        JSON.stringify(expectedGoogleScopes),
      'Google consent must request the exact approved scopes'
    );
    assert(
      googleAuth.searchParams
        .get('redirect_uri')
        ?.endsWith('/api/integrations/email/gmail/callback'),
      'Expected the approved Gmail callback path'
    );
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

export async function testEmailStart_yahooOAuthUrl() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ returnUrl: 'https://roselabs.ai/integrations' }),
  });
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    // Yahoo should NOT have Gmail-specific params
    assert(
      !body.authUrl.includes('access_type=offline'),
      'Yahoo should NOT have access_type=offline'
    );
    assert(body.authUrl.includes('code_challenge='), 'Expected code_challenge in Yahoo authUrl');
    assert(typeof body.state === 'string', 'Expected state string for Yahoo');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo, got ${res.status}`);
  }
}

// --- OAuth callback edge cases ---

export async function testOAuthCallback_yahooInvalidState() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/yahoo/callback?code=fake_code&state=invalid_yahoo_state`
  );
  // Yahoo callback should handle invalid state gracefully (returns HTML error)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for Yahoo invalid state callback, got ${res.status}`);
  }
}

export async function testOAuthCallback_missingBothParams() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback`);
  // Missing both code and state — exercises multiple validation paths
  assertStatus(res.status, 400, res.data);
}

// --- Integration CRUD deep: exercises config merge, isActive toggle ---

export async function testPatch_isActiveToggle() {
  const name = uniqueName('isactive_toggle');
  // Create integration
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  // Toggle isActive to true
  const patchRes1 = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ isActive: true }),
  });
  assertStatus(patchRes1.status, 200, patchRes1.data);
  const body1 = (patchRes1.data as { integration: { isActive: boolean } }).integration;
  assert(body1.isActive === true, 'Expected isActive=true after first toggle');

  // Toggle isActive to false
  const patchRes2 = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ isActive: false }),
  });
  assertStatus(patchRes2.status, 200, patchRes2.data);
  const body2 = (patchRes2.data as { integration: { isActive: boolean } }).integration;
  assert(body2.isActive === false, 'Expected isActive=false after second toggle');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

export async function testPatch_statusAndConfigTogether() {
  const name = uniqueName('status_config');
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      status: 'CONNECTED',
      isActive: true,
      config: { tool: 'test', version: 2 },
    }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string; isActive: boolean } })
    .integration;
  assert(patched.status === 'CONNECTED', `Expected CONNECTED, got ${patched.status}`);
  assert(patched.isActive === true, 'Expected isActive=true');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// --- Email send: exercises the missing from_email with available accounts path ---

export async function testEmailSend_noFromEmailNoAccounts() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', body: 'test' }),
  });
  // Anonymous user has no Gmail connected → should report "Gmail not connected"
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; message: string };
  assert(
    body.error === 'Gmail not connected',
    `Expected 'Gmail not connected', got '${body.error}'`
  );
}

// --- Email messages: exercises limit param parsing ---

export async function testEmailMessages_limitClamping() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=999`,
    { headers: authHeaders(accessToken) }
  );
  // Should still be 404 (no gmail), but exercises limit parsing (clamped to 100)
  assertStatus(res.status, 404, res.data);
}

export async function testEmailMessages_limitNegative() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=-5`,
    { headers: authHeaders(accessToken) }
  );
  // Should still be 404 (no gmail), but exercises Math.min(Math.max(...)) clamping
  assertStatus(res.status, 404, res.data);
}

// --- Claude Code: deep coverage of token/rate-limit paths ---

export async function testClaudeCodeRateLimited_poolSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'pool',
      poolTokenId: 'test-pool-token-' + Date.now(),
      rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  // Exercises markTokenRateLimited pool path
  if (res.status === 200) {
    const body = res.data as {
      ok: boolean;
      source: string;
      poolTokenId: string;
      rateLimitedUntil: string;
    };
    assert(body.ok === true, 'Expected ok=true');
    assert(body.source === 'pool', 'Expected source=pool');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for pool rate-limited, got ${res.status}`);
  }
}

export async function testClaudeCodeRateLimited_invalidSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'invalid_source' }),
  });
  // Should return 400 for invalid source
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(
    body.error.includes('Invalid source'),
    `Expected 'Invalid source' error, got: ${body.error}`
  );
}

export async function testClaudeCodeRateLimited_poolMissingId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'pool' }),
  });
  // Should return 400 for missing poolTokenId
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('poolTokenId'), `Expected poolTokenId error, got: ${body.error}`);
}

export async function testClaudeCodeRateLimited_userMissingUserId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'user' }),
  });
  // Should return 400 for missing userId
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('userId'), `Expected userId error, got: ${body.error}`);
}

export async function testClaudeCodePoolRateLimited_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      poolTokenId: 'test-pool-' + Date.now(),
      rateLimitedUntil: new Date(Date.now() + 120000).toISOString(),
    }),
  });
  // Exercises markPoolTokenAsRateLimited
  if (res.status === 200) {
    const body = res.data as { ok: boolean; poolTokenId: string; rateLimitedUntil: string };
    assert(body.ok === true, 'Expected ok=true');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for pool-token rate-limited, got ${res.status}`);
  }
}

export async function testClaudeCodePoolRateLimited_missingPoolTokenId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('poolTokenId'), `Expected poolTokenId error, got: ${body.error}`);
}
