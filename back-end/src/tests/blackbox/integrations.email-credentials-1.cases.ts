import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  buildCredentialPayload,
  crypto,
  encryptPayload,
  createAnonSession,
  withComputePoolLock,
  authHeadersWithoutExistingClaudePools,
  prisma,
  assert,
} from './integrations.context';
import { ErrorResponse, ClaudeCodeUploadResponse } from './integrations.schemas';

// ==================== CLAUDE CODE CREDENTIALS ====================

export async function testClaudeCodeUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code missing fields');
}

export async function testClaudeCodeUpload_happyPath() {
  // A real envelope that round-trips with the server key — the upload path now
  // rejects anything it cannot decrypt (see testClaudeCodeUpload_rejectsUndecryptable).
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-happy-${crypto.randomBytes(8).toString('hex')}`
  );
  const encrypted = encryptPayload({ encryptedCredentials });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ClaudeCodeUploadResponse, res.data, 'claude-code happy');
}

// Regression (RCA 2026-07-17): the upload path stored client ciphertext WITHOUT
// verifying it decrypts, so a mismatched-keypair client silently inserted garbage
// that later flooded oaep/parse errors and degraded chat to the paid waterfall.
// An undecryptable envelope must be rejected at the write boundary (400), never stored.
export async function testClaudeCodeUpload_rejectsUndecryptable() {
  const { accessToken } = await createAnonSession();
  const encrypted = encryptPayload({ encryptedCredentials: 'not-a-valid-envelope-' + Date.now() });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code rejects undecryptable envelope');
}

export async function testClaudeCodeToken_notFound() {
  const { accessToken } = await createAnonSession();
  const res = await withComputePoolLock(async () => {
    return request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: await authHeadersWithoutExistingClaudePools(accessToken),
    });
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token not found');
}

export async function testClaudeCodeRateLimited_forbidden() {
  // Non-internal JWT auth → 403
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ source: 'pool', poolTokenId: 'test' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'rate-limited forbidden');
}

export async function testClaudeCodePoolRateLimited_forbidden() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ poolTokenId: 'test' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'pool-rate-limited forbidden');
}

// ==================== EMAIL ENDPOINTS ====================

export async function testEmailStart_invalidProvider() {
  const res = await request(`${BASE_URL}/api/integrations/email/invalid_provider/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email start invalid provider');
}

export async function testEmailMessages_missingSince() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages missing since');
}

export async function testEmailMessages_invalidSince() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages?since=not-a-date`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages invalid since');
}

export async function testEmailMessages_gmailNotConnected() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}`,
    { headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages not connected');
}

/**
 * Regression (prod, 2026-08-18): starting an OAuth flow replaced `config`
 * wholesale, so merely opening the consent screen destroyed `connectedEmails`.
 * A user who abandoned the flow never reached the callback that rewrites them,
 * and a still-connected account silently lost its UI account chips.
 */
export async function testEmailOAuthStart_preservesConnectedEmailsOnAbandonedFlow() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: {
        provider: 'gmail',
        contacts: 229,
        connectedEmail: 'primary@gmail.com',
        connectedEmails: ['primary@gmail.com', 'secondary@gmail.com'],
      },
    },
  });

  // Start a flow and then abandon it -- never hit the callback.
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assert(res.status === 200 || res.status === 400, `oauth start responded ${res.status}`);

  const after = await prisma.integration.findUnique({ where: { id: integration.id } });
  const config = after?.config as {
    connectedEmails?: unknown;
    connectedEmail?: unknown;
    contacts?: unknown;
    startedAt?: unknown;
  };
  assert(
    Array.isArray(config.connectedEmails) && config.connectedEmails.length === 2,
    `abandoned OAuth start must preserve connectedEmails, got ${JSON.stringify(config.connectedEmails)}`
  );
  assert(
    config.connectedEmail === 'primary@gmail.com',
    `abandoned OAuth start must preserve connectedEmail, got ${String(config.connectedEmail)}`
  );
  assert(config.contacts === 229, 'unrelated config keys must survive an OAuth start');
  assert(config.startedAt !== undefined, 'OAuth start must still record its flow marker');
  assert(
    after?.status === 'CONNECTED',
    `a healthy integration must not be downgraded by starting a flow, got ${String(after?.status)}`
  );
}

/**
 * Even if some other writer already stripped the denormalized copy, the list
 * response must still show the accounts: credentials are the source of truth.
 */
export async function testGetIntegrations_derivesConnectedEmailsFromCredentials() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      // Exactly the damaged prod shape: no connectedEmails, failed sync.
      status: 'SYNC_FAILED',
      isActive: true,
      config: { provider: 'gmail', contacts: 229, messages: 533 },
    },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'live@roselabs.ai',
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
      },
      // An abandoned flow leaves a null-email, tokenless row; it must not appear.
      { userId, integrationId: integration.id, provider: 'GMAIL', email: null },
    ],
  });

  const res = await request(`${BASE_URL}/api/integrations`, { headers: authHeaders(accessToken) });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { integrations?: Array<{ name: string; config?: unknown }> };
  const gmail = body.integrations?.find((i) => i.name === 'gmail');
  const config = gmail?.config as { connectedEmails?: unknown; connectedEmail?: unknown };
  assert(
    Array.isArray(config.connectedEmails) &&
      config.connectedEmails.length === 1 &&
      config.connectedEmails[0] === 'live@roselabs.ai',
    `stripped config must self-heal from credentials, got ${JSON.stringify(config.connectedEmails)}`
  );
  assert(
    config.connectedEmail === 'live@roselabs.ai',
    `connectedEmail must derive too, got ${String(config.connectedEmail)}`
  );
}

/**
 * The merge must happen in the database, not as a read-modify-write: two
 * concurrent OAuth starts would otherwise both read the pre-write config and
 * the loser's write would erase whatever the winner just persisted (and could
 * collide on `@@unique([userId, name])`, failing one request outright).
 */
export async function testEmailOAuthStart_concurrentStartsPreserveConfig() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: {
        provider: 'gmail',
        connectedEmail: 'primary@gmail.com',
        connectedEmails: ['primary@gmail.com'],
      },
    },
  });

  // Interleave a start with a callback-style write. A read-modify-write reads
  // config BEFORE the callback lands, then writes its stale copy back over it,
  // erasing the account the callback just recorded. A DB-level merge cannot.
  const started = request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        provider: 'gmail',
        connectedEmail: 'primary@gmail.com',
        connectedEmails: ['primary@gmail.com', 'callback-added@gmail.com'],
      },
    },
  });
  const res = await started;
  assert(res.status !== 500, `OAuth start must not 500, got ${res.status}`);

  const after = await prisma.integration.findUnique({ where: { id: integration.id } });
  const config = after?.config as { connectedEmails?: unknown; startedAt?: unknown };
  assert(
    Array.isArray(config.connectedEmails) && config.connectedEmails.length === 2,
    `a start must not erase an interleaved callback's accounts, got ${JSON.stringify(config.connectedEmails)}`
  );

  // Concurrent starts must also not collide on @@unique([userId, name]).
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(`${BASE_URL}/api/integrations/email/gmail/start`, {
        method: 'POST',
        headers: authHeaders(accessToken),
      })
    )
  );
  for (const parallelRes of parallel) {
    assert(parallelRes.status !== 500, `concurrent start must not 500, got ${parallelRes.status}`);
  }
  const rowCount = await prisma.integration.count({ where: { userId, name: 'gmail' } });
  assert(rowCount === 1, `expected exactly one gmail integration row, got ${rowCount}`);
}

/** The displayed primary must not flicker between a user's accounts. */
export async function testGetIntegrations_primaryConnectedEmailIsStable() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      // Records a primary that is NOT the oldest credential.
      config: { provider: 'gmail', connectedEmail: 'second@gmail.com' },
    },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'first@gmail.com',
        accessToken: 'a1',
        refreshToken: 'r1',
      },
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'second@gmail.com',
        accessToken: 'a2',
        refreshToken: 'r2',
      },
    ],
  });

  const seen = new Set<string>();
  for (let i = 0; i < 4; i += 1) {
    const res = await request(`${BASE_URL}/api/integrations`, {
      headers: authHeaders(accessToken),
    });
    assertStatus(res.status, 200, res.data);
    const body = res.data as { integrations?: Array<{ name: string; config?: unknown }> };
    const gmail = body.integrations?.find((i) => i.name === 'gmail');
    const config = gmail?.config as { connectedEmail?: unknown };
    seen.add(String(config.connectedEmail));
  }
  assert(seen.size === 1, `primary must be stable across requests, saw ${[...seen].join(', ')}`);
  assert(
    seen.has('second@gmail.com'),
    `a still-connected configured primary must be retained, got ${[...seen][0]}`
  );
}
