import {
  createAnonSession,
  prisma,
  upsertPersonAndMessageRecords,
  assert,
  crypto,
  request,
  BASE_URL,
  authHeaders,
  assertStatus,
  processGoogleDataPurge,
  revokeQueuedGoogleGrants,
  runGoogleDataPurgeJob,
  markCredentialFailure,
  classifyEmailAuthFailure,
} from './integrations.context';

export async function testEmailGmailAccountDelete_removesOneCredential() {
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
        connectedEmails: ['primary@gmail.com', 'secondary@gmail.com'],
      },
    },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'primary@gmail.com',
        accessToken: 'access-primary',
        refreshToken: 'refresh-primary',
      },
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'secondary@gmail.com',
        accessToken: 'access-secondary',
        refreshToken: 'refresh-secondary',
      },
    ],
  });

  const disconnectedCredential = await prisma.emailIntegrationCredential.findFirstOrThrow({
    where: { userId, email: 'primary@gmail.com' },
    select: { id: true },
  });
  const gmailContact = {
    identifier: 'gmail-fence@example.com',
    identifierType: 'email' as const,
    email: 'gmail-fence@example.com',
    messages: [
      {
        channel: 'EMAIL' as const,
        from: 'gmail-fence@example.com',
        to: 'primary@gmail.com',
        timestamp: new Date(),
        message: 'Gmail write fence test body',
      },
    ],
  };
  await upsertPersonAndMessageRecords(
    userId,
    [gmailContact],
    'gmail-before-disconnect',
    'primary@gmail.com',
    disconnectedCredential.id
  );
  assert(
    (await prisma.messageRecord.count({
      where: { person: { userId }, message: 'Gmail write fence test body' },
    })) === 1,
    'an active Google credential must allow Gmail persistence'
  );

  const person = await prisma.person.create({
    data: { userId, firstName: 'Google', lastName: 'Purge' },
  });
  const purgedMessageId = crypto.randomUUID();
  const keptMessageId = crypto.randomUUID();
  const legacyCrossAccountId = crypto.randomUUID();
  await prisma.messageRecord.createMany({
    data: [
      {
        id: purgedMessageId,
        personId: person.id,
        userId: person.userId,
        channel: 'EMAIL',
        from: 'primary@gmail.com',
        to: 'secondary@gmail.com',
        timestamp: new Date(),
        message: 'from disconnected account',
        googleAccountEmail: 'primary@gmail.com',
      },
      {
        id: keptMessageId,
        personId: person.id,
        userId: person.userId,
        channel: 'EMAIL',
        from: 'primary@gmail.com',
        to: 'secondary@gmail.com',
        timestamp: new Date(),
        message: 'from connected account',
        googleAccountEmail: 'secondary@gmail.com',
      },
      {
        id: legacyCrossAccountId,
        personId: person.id,
        userId: person.userId,
        channel: 'EMAIL',
        from: 'primary@gmail.com',
        to: 'secondary@gmail.com',
        timestamp: new Date(),
        message: 'ambiguous legacy account',
      },
    ],
  });
  const snapshot = await prisma.userSnapshot.create({ data: { userId } });
  await prisma.userDataDocument.createMany({
    data: ['primary@gmail.com', 'secondary@gmail.com', null].map((email, index) => ({
      userId,
      source: 'gmail',
      externalId: `purge-${index}`,
      title: 'Gmail document',
      content: 'account data',
      contentHash: `purge-${index}`,
      googleAccountEmail: email,
    })),
  });
  await prisma.userSnapshotRevision.createMany({
    data: ['primary@gmail.com', 'secondary@gmail.com', null].map((email) => ({
      userId,
      snapshotId: snapshot.id,
      source: 'gmail',
      googleAccountEmail: email,
    })),
  });

  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('primary@gmail.com')}`,
    { method: 'DELETE', headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { disconnectedEmail?: string; connectedEmails?: string[] };
  assert(body.disconnectedEmail === 'primary@gmail.com', 'deleted email should be echoed');
  assert(
    Array.isArray(body.connectedEmails) &&
      body.connectedEmails.length === 1 &&
      body.connectedEmails[0] === 'secondary@gmail.com',
    'remaining email should be returned'
  );

  const deleted = await prisma.emailIntegrationCredential.findFirst({
    where: { userId, email: 'primary@gmail.com' },
  });
  assert(deleted === null, 'deleted Gmail credential should be removed');
  const purge = await prisma.googleDataPurge.findFirst({
    // A concurrent purge worker may finish the obligation before this read.
    where: { userId, email: 'primary@gmail.com' },
  });
  assert(purge !== null, 'disconnect should queue cached Google data for deletion');
  if (purge.processedAt === null) {
    await prisma.googleDataPurge.update({
      where: { id: purge.id },
      data: { revocationToken: null, claimedUntil: null },
    });
    await processGoogleDataPurge(purge.id);
  }
  let staleSyncRejected = false;
  try {
    await upsertPersonAndMessageRecords(
      userId,
      [gmailContact],
      'gmail-after-disconnect',
      'primary@gmail.com',
      disconnectedCredential.id
    );
  } catch {
    staleSyncRejected = true;
  }
  assert(staleSyncRejected, 'an in-flight sync must stop writing after credential deletion');
  assert(
    (await prisma.messageRecord.count({
      where: { person: { userId }, message: 'Gmail write fence test body' },
    })) === 0,
    'a stale sync must not recreate Gmail cache after the purge completes'
  );
  assert(
    (await prisma.messageRecord.findUnique({ where: { id: purgedMessageId } })) === null,
    'purge should delete records attributed to the disconnected account'
  );
  assert(
    (await prisma.messageRecord.findUnique({ where: { id: keptMessageId } })) !== null,
    'purge must preserve records attributed to the connected account'
  );
  assert(
    (await prisma.messageRecord.findUnique({ where: { id: legacyCrossAccountId } })) === null,
    'purge must remove ambiguous legacy records that could belong to the disconnected account'
  );
  const remainingDocuments = await prisma.userDataDocument.findMany({
    where: { userId, source: 'gmail' },
    select: { googleAccountEmail: true },
  });
  const remainingRevisions = await prisma.userSnapshotRevision.findMany({
    where: { userId, source: 'gmail' },
    select: { googleAccountEmail: true },
  });
  for (const remaining of [remainingDocuments, remainingRevisions]) {
    assert(
      remaining.length === 1 && remaining[0].googleAccountEmail === 'secondary@gmail.com',
      'purge must retain attributed other-account rows and remove ambiguous Gmail rows'
    );
  }

  const updated = await prisma.integration.findUnique({ where: { id: integration.id } });
  const config = updated?.config as { connectedEmail?: unknown; connectedEmails?: unknown };
  assert(updated?.status === 'CONNECTED', 'integration should stay connected');
  assert(updated?.isActive === true, 'integration should stay active');
  assert(
    config.connectedEmail === 'secondary@gmail.com',
    'primary config should move to remaining email'
  );
  assert(
    Array.isArray(config.connectedEmails) &&
      config.connectedEmails.length === 1 &&
      config.connectedEmails[0] === 'secondary@gmail.com',
    'connectedEmails config should be recomputed'
  );

  const unknownAccountJob = await prisma.googleDataPurge.create({ data: { userId } });
  await processGoogleDataPurge(unknownAccountJob.id);
  assert(
    (await prisma.messageRecord.count({ where: { person: { userId }, channel: 'EMAIL' } })) === 0 &&
      (await prisma.userDataDocument.count({ where: { userId, source: 'gmail' } })) === 0 &&
      (await prisma.userSnapshotRevision.count({ where: { userId, source: 'gmail' } })) === 0,
    'a legacy credential with no account email must purge every potentially associated Gmail cache row'
  );
}

export async function testGoogleRevocationFailure_retainsDurableRetry() {
  const job = await prisma.googleDataPurge.create({
    data: { userId: crypto.randomUUID(), email: null, revocationToken: 'pending-token' },
  });
  const unavailable = (async () => new Response('', { status: 503 })) as typeof fetch;
  await revokeQueuedGoogleGrants([{ id: job.id, token: 'pending-token' }], unavailable);
  await processGoogleDataPurge(job.id, unavailable);
  const pending = await prisma.googleDataPurge.findUniqueOrThrow({ where: { id: job.id } });
  assert(
    pending.processedAt === null &&
      pending.revocationToken === 'pending-token' &&
      pending.claimedUntil !== null &&
      pending.claimedUntil > new Date(),
    'failed revocation must retain the token and defer its next attempt'
  );

  const available = (async () => new Response('', { status: 200 })) as typeof fetch;
  await prisma.googleDataPurge.update({ where: { id: job.id }, data: { claimedUntil: null } });
  await processGoogleDataPurge(job.id, available);
  const processed = await prisma.googleDataPurge.findUniqueOrThrow({ where: { id: job.id } });
  assert(
    processed.processedAt !== null && processed.revocationToken === null,
    'successful retry must clear the token and finish the obligation'
  );
}

export async function testGoogleRevocationFailures_doNotStarveLaterPurge() {
  const blockedUserId = crypto.randomUUID();
  const readyUserId = crypto.randomUUID();
  const unavailable = (async () => new Response('', { status: 503 })) as typeof fetch;
  try {
    await prisma.googleDataPurge.createMany({
      data: Array.from({ length: 20 }, () => ({
        userId: blockedUserId,
        revocationToken: 'pending-token',
        requestedAt: new Date('2000-01-01T00:00:00Z'),
      })),
    });
    const blocked = await prisma.googleDataPurge.findMany({
      where: { userId: blockedUserId },
      select: { id: true },
    });
    for (const job of blocked) await processGoogleDataPurge(job.id, unavailable);

    const ready = await prisma.googleDataPurge.create({
      data: { userId: readyUserId, requestedAt: new Date('2000-01-02T00:00:00Z') },
    });
    await runGoogleDataPurgeJob();
    const result = await prisma.googleDataPurge.findUniqueOrThrow({ where: { id: ready.id } });
    assert(
      result.processedAt !== null,
      'twenty failed older revocations must not block a later data-purge obligation'
    );
  } finally {
    await prisma.googleDataPurge.deleteMany({
      where: { userId: { in: [blockedUserId, readyUserId] } },
    });
  }
}

export async function testGoogleExternalRevocation_queuesPurgeAndReconnect() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: { userId, name: 'gmail', type: 'DATA_SOURCE', status: 'CONNECTED', isActive: true },
  });
  const credential = await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: integration.id,
      provider: 'GMAIL',
      email: 'revoked@gmail.com',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    },
  });
  await markCredentialFailure(
    credential.id,
    classifyEmailAuthFailure({ status: 400, body: '{"error":"invalid_grant"}' })
  );
  const after = await prisma.emailIntegrationCredential.findUniqueOrThrow({
    where: { id: credential.id },
  });
  assert(
    after.state === 'needs_reconnect' && after.accessToken === null && after.refreshToken === null,
    'externally revoked account should remain visible for reconnect without stored tokens'
  );
  assert(
    (await prisma.googleDataPurge.count({ where: { userId, email: 'revoked@gmail.com' } })) === 1,
    'invalid_grant should queue data cleanup for the revoked account'
  );
  const listed = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(listed.status, 200, listed.data);
  const integrations = (listed.data as { integrations?: Array<{ emailCredentials?: unknown[] }> })
    .integrations;
  assert(
    integrations?.some((item) =>
      item.emailCredentials?.some(
        (account) =>
          typeof account === 'object' &&
          account !== null &&
          'email' in account &&
          account.email === 'revoked@gmail.com'
      )
    ),
    'revoked account must remain listed for the Reconnect Google prompt'
  );
}
