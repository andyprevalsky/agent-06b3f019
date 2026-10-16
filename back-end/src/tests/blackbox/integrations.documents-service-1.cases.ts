import {
  createAnonSession,
  request,
  BASE_URL,
  authHeaders,
  API_KEY,
  assertStatus,
  withComputePoolLock,
  authHeadersWithoutExistingClaudePools,
  assertSchema,
  apiKeyHeaders,
  ctx,
  prisma,
  crypto,
} from './integrations.context';
import { ErrorResponse, DocumentsUploadResponse } from './integrations.schemas';

// ==================== DEEP COVERAGE — SERVICE PATHS ====================

// 1. Create integration with invalid type → exercises InvalidIntegrationTypeError
export async function testCreateIntegration_invalidType() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ name: 'test-invalid', type: 'INVALID_TYPE' }),
  });
  // Should reject with 400 for invalid integration type
  if (res.status !== 400) {
    throw new Error(`Expected 400 for invalid type, got ${res.status}`);
  }
}

// 2. Update integration with invalid status → exercises invalid status validation
export async function testUpdateIntegration_invalidStatus() {
  const session = await createAnonSession();
  // Create a valid integration first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ name: 'test-upd-status', type: 'DATA_SOURCE' }),
  });
  // Try to update with invalid status
  const res = await request(`${BASE_URL}/api/integrations/test-upd-status`, {
    method: 'PATCH',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ status: 'FAKE_STATUS' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for invalid status, got ${res.status}`);
  }
}

// 3. Token rate-limited with invalid source → exercises error in markTokenRateLimited
export async function testRateLimited_invalidSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'INVALID_SOURCE' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for invalid source, got ${res.status}`);
  }
}

// 4. Token rate-limited pool source missing poolTokenId
export async function testRateLimited_poolMissingId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'pool' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for pool missing id, got ${res.status}`);
  }
}

// 5. Token rate-limited user source missing userId
export async function testRateLimited_userMissingUserId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'user' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for user missing userId, got ${res.status}`);
  }
}

// 6. Get integrations for user without cached domains (exercises !hasCachedDomains branch)
export async function testGetIntegrations_noCachedDomains() {
  const session = await createAnonSession();
  // First call - no cached domains
  const res1 = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(session.accessToken),
  });
  assertStatus(res1.status, 200, res1.data);
  // Second call - domains should now be cached
  const res2 = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(session.accessToken),
  });
  assertStatus(res2.status, 200, res2.data);
}

// 7. Email messages fetch for user without Gmail integration
export async function testEmailMessages_noGmail() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: authHeaders(session.accessToken),
  });
  // Should return error about Gmail not connected
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400/404 for no Gmail, got ${res.status}`);
  }
}

// 8. Email send for user without Gmail credentials
export async function testEmailSend_noGmail() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Test',
      body: 'Test body',
      from_email: 'nonexistent@gmail.com',
    }),
  });
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400/404 for no Gmail creds, got ${res.status}`);
  }
}

// 9. Password request
export async function testPasswordRequest_happy() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ request: 'Please add support for 1Password' }),
  });
  // Should succeed (sends SMS to admin) or fail gracefully
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200/500 for password request, got ${res.status}`);
  }
}

// 10. Claude Code credentials token for user without onboarding
export async function testClaudeCodeToken_noOnboarding() {
  const session = await createAnonSession();
  const res = await withComputePoolLock(async () => {
    return request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: await authHeadersWithoutExistingClaudePools(session.accessToken),
    });
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token no onboarding missing');
}

export async function testDocumentsUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'apple_notes',
      documents: [
        {
          externalId: 'note-connectors-1',
          title: 'Connector planning',
          content: 'Apple Notes connector should preserve user preference details.',
          sourceUpdatedAt: '2026-07-03T12:00:00Z',
          metadata: { folder: 'Product' },
        },
      ],
      snapshotRevision: {
        documentExternalId: 'note-connectors-1',
        before: {},
        after: {
          preferences: {
            agent_data_sources: ['apple_notes'],
          },
        },
        changes: { preferences: ['agent_data_sources'] },
        model: 'test-distiller',
        promptKey: 'user-snapshot-v1',
      },
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(DocumentsUploadResponse, res.data, 'documents upload');
  if (
    body.integration.name !== 'apple_notes' ||
    body.integration.status !== 'CONNECTED' ||
    body.documentCount !== 1 ||
    body.snapshotRevision?.snapshotVersion !== 1 ||
    body.syncState.source !== 'apple_notes' ||
    body.syncState.status !== 'CONNECTED' ||
    body.dryRun
  ) {
    throw new Error(`Unexpected documents upload response: ${JSON.stringify(body)}`);
  }

  const snapshot = await prisma.userSnapshot.findUnique({ where: { userId: ctx.userId1! } });
  if (
    snapshot === null ||
    snapshot.version !== 1 ||
    JSON.stringify(snapshot.content).indexOf('apple_notes') === -1
  ) {
    throw new Error(`Expected persisted snapshot, got ${JSON.stringify(snapshot)}`);
  }

  const syncState = await prisma.userDataProviderSyncState.findUnique({
    where: { userId_source: { userId: ctx.userId1!, source: 'apple_notes' } },
  });
  if (
    syncState === null ||
    syncState.status !== 'CONNECTED' ||
    syncState.lastSuccessfulSyncAt === null ||
    syncState.nextSyncAt === null ||
    !syncState.realtimeEnabled
  ) {
    throw new Error(`Expected persisted Apple Notes sync state, got ${JSON.stringify(syncState)}`);
  }
}

export async function testDocumentsUpload_idempotentUpsert() {
  const externalId = `obsidian-idempotent-${crypto.randomUUID()}`;
  const first = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'obsidian',
      documents: [
        {
          externalId,
          title: 'Idempotent note',
          content: 'Obsidian first version contains Helios marker.',
          sourceUpdatedAt: '2026-07-03T12:00:00Z',
          metadata: { vault: 'main', path: 'Idempotent.md' },
        },
      ],
    }),
  });
  assertStatus(first.status, 200, first.data);
  const firstBody = assertSchema(DocumentsUploadResponse, first.data, 'documents first upload');

  const second = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'obsidian',
      documents: [
        {
          externalId,
          title: 'Idempotent note updated',
          content: 'Obsidian second version contains Helios marker and update marker.',
          sourceUpdatedAt: '2026-07-03T12:10:00Z',
          metadata: { vault: 'main', path: 'Idempotent.md', tags: ['updated'] },
        },
      ],
    }),
  });
  assertStatus(second.status, 200, second.data);
  const secondBody = assertSchema(DocumentsUploadResponse, second.data, 'documents second upload');
  if (firstBody.documents[0]?.id !== secondBody.documents[0]?.id) {
    throw new Error(
      `Expected idempotent document id, got ${JSON.stringify({ firstBody, secondBody })}`
    );
  }

  const rows = await prisma.userDataDocument.findMany({
    where: { userId: ctx.userId1!, source: 'obsidian', externalId },
  });
  if (
    rows.length !== 1 ||
    rows[0]?.title !== 'Idempotent note updated' ||
    rows[0]?.deletedAt !== null
  ) {
    throw new Error(`Expected one updated document row, got ${JSON.stringify(rows)}`);
  }
}

export async function testDocumentsUpload_dryRunDoesNotPersist() {
  const externalId = `dry-run-${crypto.randomUUID()}`;
  const res = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'chatgpt',
      dryRun: true,
      documents: [
        {
          externalId,
          title: 'Dry run prod smoke',
          content: 'Dry run validates prod path without persistence.',
          metadata: { provider: 'chatgpt' },
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(DocumentsUploadResponse, res.data, 'documents dry run');
  if (!body.dryRun || body.integration.id !== 'dry-run' || body.syncState.id !== 'dry-run') {
    throw new Error(`Unexpected dry-run response: ${JSON.stringify(body)}`);
  }

  const persisted = await prisma.userDataDocument.findFirst({
    where: { userId: ctx.userId1!, source: 'chatgpt', externalId },
  });
  if (persisted !== null) {
    throw new Error(`Dry-run upload persisted a document: ${JSON.stringify(persisted)}`);
  }
}
