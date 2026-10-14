import {
  createAnonSession,
  setAccountPoolDefault,
  uploadClaudeCredentials,
  readCredentialRow,
  assert,
  cleanupIntegrations,
  uploadGptCredentials,
  prisma,
  seedClaudeIntegration,
} from './integrations.context';

// Account default ON -> a freshly synced Claude token is pool-eligible.
export async function testAccountPoolDefault_claudeSyncInheritsEnabled() {
  const caller = await createAnonSession();
  await setAccountPoolDefault(caller.userId, true);
  const ids: string[] = [];

  try {
    await uploadClaudeCredentials(caller.accessToken);
    const row = await readCredentialRow(caller.userId, 'claude_code');
    assert(row !== null, 'upload must create a claude_code integration');
    ids.push(row!.id);
    assert(
      row!.poolingEnabled === true,
      `synced token must inherit poolTokensByDefault=true (got ${row!.poolingEnabled})`
    );
    assert(
      row!.poolingEnabledOverride === null,
      'inheriting the account default must NOT record a per-integration override'
    );
  } finally {
    await cleanupIntegrations(ids);
  }
}

// Account default ON -> a freshly synced GPT token is pool-eligible too.
export async function testAccountPoolDefault_gptSyncInheritsEnabled() {
  const caller = await createAnonSession();
  await setAccountPoolDefault(caller.userId, true);
  const ids: string[] = [];

  try {
    await uploadGptCredentials(caller.accessToken);
    const row = await readCredentialRow(caller.userId, 'gpt_code');
    assert(row !== null, 'upload must create a gpt_code integration');
    ids.push(row!.id);
    assert(
      row!.poolingEnabled === true,
      `synced GPT token must inherit poolTokensByDefault=true (got ${row!.poolingEnabled})`
    );
  } finally {
    await cleanupIntegrations(ids);
  }
}

// Account default OFF -> unchanged behavior, token stays out of the pool.
export async function testAccountPoolDefault_syncStaysUnpooledWhenDefaultOff() {
  const caller = await createAnonSession();
  const ids: string[] = [];

  try {
    const user = await prisma.user.findUnique({ where: { userId: caller.userId } });
    assert(
      user?.poolTokensByDefault === false,
      'new accounts must default to poolTokensByDefault=false'
    );

    await uploadClaudeCredentials(caller.accessToken);
    const row = await readCredentialRow(caller.userId, 'claude_code');
    assert(row !== null, 'upload must create a claude_code integration');
    ids.push(row!.id);
    assert(
      row!.poolingEnabled === false,
      'account default OFF must keep the synced token out of the pool'
    );
  } finally {
    await cleanupIntegrations(ids);
  }
}

// Explicit per-integration override beats the account policy in BOTH directions.
export async function testAccountPoolDefault_explicitOverrideWins() {
  const optOut = await createAnonSession();
  const optIn = await createAnonSession();
  const optOutInt = await seedClaudeIntegration(optOut.userId, { poolingEnabled: true });
  const optInInt = await seedClaudeIntegration(optIn.userId, { poolingEnabled: false });

  try {
    // Account says "pool everything", operator explicitly excluded this token.
    await setAccountPoolDefault(optOut.userId, true);
    await prisma.integration.update({
      where: { id: optOutInt.id },
      data: { poolingEnabledOverride: false },
    });
    await uploadClaudeCredentials(optOut.accessToken);
    const optOutRow = await readCredentialRow(optOut.userId, 'claude_code');
    assert(
      optOutRow?.poolingEnabled === false,
      'explicit override=false must beat account default=true on re-sync'
    );

    // Account says "do not pool", operator explicitly opted this token in.
    await prisma.integration.update({
      where: { id: optInInt.id },
      data: { poolingEnabledOverride: true },
    });
    await uploadClaudeCredentials(optIn.accessToken);
    const optInRow = await readCredentialRow(optIn.userId, 'claude_code');
    assert(
      optInRow?.poolingEnabled === true,
      'explicit override=true must beat account default=false on re-sync'
    );
  } finally {
    await cleanupIntegrations([optOutInt.id, optInInt.id]);
  }
}

// Re-syncing a rotated token must never silently drain the pool.
export async function testAccountPoolDefault_resyncKeepsPooledToken() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: true });

  try {
    const before = await readCredentialRow(caller.userId, 'claude_code');
    assert(
      before?.poolingEnabled === true && before.poolingEnabledOverride === null,
      'fixture must start pooled with no explicit override'
    );

    await uploadClaudeCredentials(caller.accessToken);

    const after = await readCredentialRow(caller.userId, 'claude_code');
    assert(
      after?.poolingEnabled === true,
      're-syncing a token must not reset an already-pooled integration'
    );
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}
