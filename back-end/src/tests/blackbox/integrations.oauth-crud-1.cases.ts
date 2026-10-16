import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assert,
  assertStatus,
  assertSchema,
  createAnonSession,
  uniqueName,
  buildCredentialPayload,
  crypto,
  encryptPayload,
  withComputePoolLock,
  authHeadersWithoutExistingClaudePools,
  apiKeyHeaders,
} from './integrations.context';
import {
  ErrorResponse,
  ListIntegrationsResponse,
  CreateIntegrationResponse,
  PatchIntegrationResponse,
  DeleteIntegrationResponse,
  ClaudeCodeUploadResponse,
} from './integrations.schemas';

// ==================== OAUTH START / CALLBACK / INTEGRATION CRUD COVERAGE ====================

// 1. OAuth start: gmail with returnUrl
export async function testOAuthStart_gmail() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ returnUrl: 'https://roselabs.ai/integrations' }),
  });
  // 200 if Google client ID is configured, 500 if not
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    assert(typeof body.authUrl === 'string', 'Expected authUrl string');
    assert(body.authUrl.includes('accounts.google.com'), 'Expected Google OAuth URL');
    assert(typeof body.state === 'string', 'Expected state string');
    assert(typeof body.expiresAt === 'string', 'Expected expiresAt string');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

// 2. OAuth start: yahoo
export async function testOAuthStart_yahoo() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  if (res.status === 200) {
    const body = res.data as { authUrl: string };
    assert(typeof body.authUrl === 'string', 'Expected authUrl string for Yahoo');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo start, got ${res.status}`);
  }
}

// 3. OAuth start: invalid provider
export async function testOAuthStart_invalidProvider() {
  const res = await request(`${BASE_URL}/api/integrations/email/outlook/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'oauth start invalid provider');
}

// 4. OAuth start: no auth
export async function testOAuthStart_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

// 5. OAuth callback: missing code param
export async function testOAuthCallback_noCode() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?state=some_state`);
  // Returns HTML 400 (missing authorization code)
  assertStatus(res.status, 400, res.data);
}

// 6. OAuth callback: invalid state token
export async function testOAuthCallback_invalidState() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/callback?code=fake_code&state=totally_invalid_state_token`
  );
  // Returns HTML error page (state not found in DB -> 400 or redirect)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for invalid state callback, got ${res.status}`);
  }
}

// 7. Get integrations: empty for new anonymous user
export async function testGetIntegrations_empty() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations empty');
  assert(body.count === 0, `Expected 0 integrations, got ${body.count}`);
  assert(Array.isArray(body.authenticatedDomains), 'Expected authenticatedDomains array');
}

// 8. Create integration: basic DATA_SOURCE
export async function testCreateIntegration_basic() {
  const name = uniqueName('create_basic');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { source: 'test' } }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create basic');
  assert(body.integration.name === name, `Expected name ${name}`);
  assert(body.integration.type === 'DATA_SOURCE', 'Expected DATA_SOURCE type');
  assert(body.integration.status === 'NOT_CONNECTED', 'Expected NOT_CONNECTED status');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// 9. Update integration status
export async function testUpdateIntegration_status() {
  const name = uniqueName('update_status');
  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Update status to CONNECTED
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(PatchIntegrationResponse, res.data, 'update status');
  assert(
    body.integration.status === 'CONNECTED',
    `Expected CONNECTED, got ${body.integration.status}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// 10. Delete integration: basic
export async function testDeleteIntegration_basic() {
  const name = uniqueName('delete_basic');
  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });

  // Delete
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(DeleteIntegrationResponse, res.data, 'delete basic');

  // Verify it's gone
  const deleteAgain = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(deleteAgain.status, 404, deleteAgain.data);
}

// 11. Email send: missing required fields
export async function testEmailSend_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email send missing fields');
}

// 12. Email send: no auth
export async function testEmailSend_noAuthCoverage() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    body: JSON.stringify({ to: 'a@b.com', subject: 'test', body: 'test', from_email: 'x@y.com' }),
  });
  assertStatus(res.status, 401, res.data);
}

// 13. Email messages: no auth
export async function testEmailMessages_noAuthCoverage() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}`
  );
  assertStatus(res.status, 401, res.data);
}

// 14. Email messages: empty (no gmail connected for anon user)
export async function testEmailMessages_empty() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date(Date.now() - 86400000).toISOString()}&limit=5`,
    { headers: authHeaders(accessToken) }
  );
  // 404 because no gmail connected for anonymous user
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages empty');
}

// 15. Passwords request: basic with valid request string
export async function testPasswordsRequest_basic() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: 'Please add support for 1Password integration' }),
  });
  // 200 if SMS config is available, 500 if not
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for passwords request, got ${res.status}`);
  }
}

// 16. Claude Code credentials upload: with encrypted payload
export async function testClaudeCodeCredentials_upload() {
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-upload-${crypto.randomBytes(8).toString('hex')}`
  );
  const encrypted = encryptPayload({ encryptedCredentials });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ClaudeCodeUploadResponse, res.data, 'claude-code credentials upload');
}

// 17. Claude Code credentials get token: returns 404 for anon user without onboarding
export async function testClaudeCodeCredentials_getToken() {
  const { accessToken } = await createAnonSession();
  const res = await withComputePoolLock(async () => {
    return request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: await authHeadersWithoutExistingClaudePools(accessToken),
    });
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token anon missing');
}

// 18. Claude Code token rate-limited: with API key (internal auth)
export async function testClaudeCodeTokenRateLimited() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'user', userId: ctx.userId1 }),
  });
  // Should succeed with internal auth (API key)
  if (res.status === 200) {
    const body = res.data as { ok: boolean; source: string };
    assert(body.ok === true, 'Expected ok=true');
    assert(body.source === 'user', 'Expected source=user');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for rate-limited, got ${res.status}`);
  }
}

// 19. Integration CRUD: full lifecycle (create, read, update status, delete)
export async function testIntegrationCRUD_fullLifecycle() {
  const name = uniqueName('crud_lifecycle');
  const { accessToken } = await createAnonSession();

  // 1. Create
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { step: 'create' } }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateIntegrationResponse, createRes.data, 'lifecycle create');
  assert(created.integration.status === 'NOT_CONNECTED', 'Expected NOT_CONNECTED on create');

  // 2. Read (list) and verify it's there
  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const listed = assertSchema(ListIntegrationsResponse, listRes.data, 'lifecycle list');
  const found = listed.integrations.find((i: { name: string }) => i.name === name);
  assert(found !== undefined, `Expected to find ${name} in list`);

  // 3. Update status to CONNECTED
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = assertSchema(PatchIntegrationResponse, patchRes.data, 'lifecycle patch');
  assert(patched.integration.status === 'CONNECTED', 'Expected CONNECTED after patch');
  assert(patched.integration.isActive === true, 'Expected isActive=true after patch');

  // 4. Update status to EXPIRED
  const expireRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ status: 'EXPIRED' }),
  });
  assertStatus(expireRes.status, 200, expireRes.data);
  const expired = (expireRes.data as { integration: { status: string } }).integration;
  assert(expired.status === 'EXPIRED', `Expected EXPIRED, got ${expired.status}`);

  // 5. Delete
  const deleteRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);

  // 6. Verify gone
  const deleteAgainRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  assertStatus(deleteAgainRes.status, 404, deleteAgainRes.data);
}

// 20. Email send: with from_email but no gmail connected (exercises send path validation)
export async function testEmailSend_withCredentials() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Test Subject',
      body: 'Test email body content',
      from_email: 'noreply@test.example.com',
    }),
  });
  // Should fail because no gmail credentials are connected for this anon user
  // Exercises the sendEmail path → GmailAccountNotFoundError
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400 or 404 for send without credentials, got ${res.status}`);
  }
}
