import {
  createAnonSession,
  prisma,
  request,
  BASE_URL,
  authHeaders,
  assertStatus,
  assert,
  assertSchema,
  ctx,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

/**
 * The regression this whole feature exists for.
 *
 * A user with two connected Gmail accounts, one of which has a dead refresh
 * token, previously saw a single rose "Connected" chip: the per-account fact
 * was rolled up onto the shared Integration row and never reached the client.
 * GET /api/integrations must expose per-account health so the FE can render the
 * broken one amber -- and must never leak tokens while doing it.
 */
export async function testListIntegrations_exposesPerAccountHealth() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: { provider: 'gmail', connectedEmails: ['healthy@gmail.com', 'broken@gmail.com'] },
    },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'healthy@gmail.com',
        accessToken: 'access-healthy',
        refreshToken: 'refresh-healthy',
        scopes: [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/drive',
        ],
      },
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'broken@gmail.com',
        accessToken: 'access-broken',
        refreshToken: 'refresh-broken',
        scopes: [
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
        ],
        state: 'needs_reconnect',
        lastErrorReason: 'Access was revoked or expired.',
      },
    ],
  });

  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    integrations: Array<{
      name: string;
      emailCredentials?: Array<Record<string, unknown>>;
    }>;
  };
  const gmail = body.integrations.find((i) => i.name === 'gmail');
  assert(gmail !== undefined, 'gmail integration should be listed');
  const creds = gmail!.emailCredentials ?? [];
  assert(creds.length === 2, `expected 2 credentials, got ${creds.length}`);

  const broken = creds.find((c) => c.email === 'broken@gmail.com');
  const healthy = creds.find((c) => c.email === 'healthy@gmail.com');
  assert(broken !== undefined && healthy !== undefined, 'both accounts should be present');
  assert(
    broken!.state === 'needs_reconnect',
    `broken account must report needs_reconnect, got ${String(broken!.state)}`
  );
  assert(
    healthy!.state === 'connected',
    `healthy account must stay connected, got ${String(healthy!.state)}`
  );
  assert(
    typeof broken!.lastErrorReason === 'string' && broken!.lastErrorReason !== '',
    'the broken account must carry a reason for the chip tooltip'
  );

  // Tokens must never cross the API edge.
  for (const cred of creds) {
    for (const secret of ['accessToken', 'refreshToken', 'pkceVerifier', 'stateToken']) {
      assert(
        !(secret in cred),
        `GET /api/integrations must not expose ${secret} (found on ${String(cred.email)})`
      );
    }
  }
}

export async function testEmailGmailAccountResync_notFound() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('nobody@gmail.com')}/resync`,
    { method: 'POST', headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'resync unknown account');
}

/**
 * A credential with no refresh token cannot be repaired by retrying, so resync
 * must report it as terminal rather than silently doing nothing.
 */
export async function testEmailGmailAccountResync_reportsNeedsReauth() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: { provider: 'gmail', connectedEmails: ['dead@gmail.com'] },
    },
  });
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: integration.id,
      provider: 'GMAIL',
      email: 'dead@gmail.com',
      accessToken: 'stale-access',
      // No refresh token and an already-expired access token: unrecoverable
      // without user re-consent, and reproducible with no outbound call.
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });

  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('dead@gmail.com')}/resync`,
    { method: 'POST', headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { needsReauth?: boolean; state?: string; email?: string };
  assert(body.email === 'dead@gmail.com', 'resync should echo the account');
  assert(body.needsReauth === true, 'a credential with no refresh token needs re-consent');
  assert(body.state === 'needs_reconnect', `expected needs_reconnect, got ${String(body.state)}`);

  // And the terminal state must be persisted, so the chip stays amber on reload
  // rather than reverting to "Connected" until the next cron tick.
  const stored = await prisma.emailIntegrationCredential.findFirst({
    where: { userId, email: 'dead@gmail.com' },
    select: { state: true, lastErrorReason: true },
  });
  assert(
    stored?.state === 'needs_reconnect',
    `persisted state should be needs_reconnect, got ${String(stored?.state)}`
  );
  assert(
    typeof stored?.lastErrorReason === 'string' && stored.lastErrorReason !== '',
    'a persisted failure must carry a reason'
  );
}

export async function testPasswordsRequest_missingRequest() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords request missing');
}

export async function testPasswordsRequest_emptyRequest() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords request empty');
}
