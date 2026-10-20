/**
 * LinkedIn honest phases and multi-account (plan row I4).
 *
 *   start ─► starting ─(agent)─► export_requested ─(agent)─► waiting_for_export
 *         ─(server: request bytes)─► uploading ─(server: records)─► parsing ─► synced
 *   any agent phase ─(agent: expired/failed | agent ends)─► failed + lastError
 *
 * Every phase is asserted only after the event that produces it, and never
 * before: the agent cannot report a server phase, cannot skip ahead, and an
 * upload that never happened leaves no uploading/parsing entry. Two LinkedIn
 * accounts keep separate rows, progress and messages; deleting one removes
 * exactly its imported messages and keeps the other's.
 */
import { randomUUID } from 'node:crypto';
import {
  prisma,
  createAnonSession,
  request,
  authHeaders,
  assertStatus,
  assert,
  BASE_URL,
} from './integrations.context';
import {
  PHASE_URL,
  type Account,
  account,
  archive,
  cleanup,
  createAgent,
  eventually,
  hexOf,
  linkedinMessageIds,
  listed,
  owner,
  people,
  phasesOf,
  reportPhase,
  row,
  startSync,
  uploadArchive,
} from './integrations.linkedin-sync.support';

// ── Cases ──────────────────────────────────────────────

export async function testLinkedinPhases_inOrderOnlyAfterEachEvent() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentId = await createAgent(userId);
  const acct = 'urn:li:member:1001';
  try {
    const started = await startSync(token, agentId, acct);
    assertStatus(started.status, 200, started.data);
    let a = await account(token, acct);
    assert(
      a.state === 'syncing' && a.progress.phase === 'starting',
      `starting, got ${a.progress.phase}`
    );
    assert(a.progress.total === null && a.progress.pct === null, 'nothing to count yet');

    // The agent cannot skip ahead or claim a phase only the server witnesses.
    const early = await reportPhase(token, { agent_id: agentId, phase: 'waiting_for_export' });
    assertStatus(early.status, 409, early.data);
    assert((early.data as { error?: string }).error === 'PHASE_OUT_OF_ORDER', 'out of order');
    const forged = await reportPhase(token, { agent_id: agentId, phase: 'uploading' });
    assertStatus(forged.status, 400, forged.data);
    a = await account(token, acct);
    assert(
      a.progress.phase === 'starting',
      `rejected reports change nothing, got ${a.progress.phase}`
    );

    const requested = await reportPhase(token, {
      agent_id: agentId,
      phase: 'export_requested',
      eta_sec: 600,
    });
    assertStatus(requested.status, 200, requested.data);
    a = await account(token, acct);
    assert(a.progress.phase === 'export_requested', `export_requested, got ${a.progress.phase}`);
    assert(a.progress.total === null && a.progress.eta_sec === 600, 'stated ETA, no total');

    assertStatus(
      (await reportPhase(token, { agent_id: agentId, phase: 'waiting_for_export' })).status,
      200,
      null
    );
    a = await account(token, acct);
    assert(a.progress.phase === 'waiting_for_export' && a.state === 'syncing', 'waiting');
    assert(a.progress.total === null, 'waiting has no total');
    const eta = a.progress.eta_sec;
    assert(eta !== null && eta > 0 && eta <= 600, `ETA counts down from LinkedIn's, got ${eta}`);

    const bytes = archive(owner, people('p'), 'p');
    let sawUploading = false;
    const upload = await uploadArchive(token, bytes, {
      accountId: acct,
      pieces: 3,
      pauseMs: 1_200,
      duringPause: async (sent, total) => {
        const mid = await account(token, acct);
        assert(mid.progress.phase === 'uploading', `uploading mid-body, got ${mid.progress.phase}`);
        assert(
          mid.progress.unit === 'bytes' && mid.progress.total === total,
          'bytes of the upload'
        );
        const done = mid.progress.done ?? -1;
        assert(done >= 0 && done <= sent && done < total, `done ${done} ≤ sent ${sent} < ${total}`);
        assert(mid.progress.eta_sec === null, 'no ETA once uploading');
        sawUploading = true;
      },
    });
    assertStatus(upload.status, 200, upload.data);
    assert(sawUploading, 'uploading was observed while the body was still arriving');
    const result = upload.data as {
      account_id: string;
      counts: { files: Record<string, number>; contacts: number; messages: number };
    };
    assert(result.account_id === acct, 'upload landed on the named account');
    assert(result.counts.files['Connections.csv'] === 2, 'Connections.csv rows counted');
    assert(result.counts.files['messages.csv'] === 4, 'messages.csv rows counted');
    assert(result.counts.files['Profile.csv'] === 1, 'Profile.csv rows counted');
    assert(result.counts.contacts === 2 && result.counts.messages === 4, 'imported counts');

    a = await account(token, acct);
    assert(a.state === 'synced' && a.progress.pct === 100, `synced, got ${a.state}`);
    assert(a.progress.done === 6 && a.progress.total === 6, 'final records 6/6');
    assert(a.progress.unit === 'records', 'final unit records');
    assert(a.lastError === null && a.lastSyncAt !== null, 'clean finish');

    const r = await row(token, acct);
    const timeline = r.config?.linkedinSync?.phases ?? [];
    const order = timeline.map((p) => p.phase).join(' > ');
    assert(
      order === 'starting > export_requested > waiting_for_export > uploading > parsing > synced',
      `phase timeline in order, got ${order}`
    );
    for (let i = 1; i < timeline.length; i++) {
      assert(
        timeline[i - 1].at <= timeline[i].at,
        `phase ${timeline[i].phase} not before ${timeline[i - 1].phase}`
      );
    }
    const uploading = timeline.find((p) => p.phase === 'uploading');
    assert(uploading?.total === upload.contentLength, 'uploading total = request bytes');
    assert(uploading?.done === upload.contentLength, 'uploading ended with every byte received');
    const parsing = timeline.find((p) => p.phase === 'parsing');
    assert(parsing?.total === 6 && parsing.unit === 'records', 'parsing counted records');
    assert(r.status === 'CONNECTED', `row CONNECTED, got ${r.status}`);

    const ids = await linkedinMessageIds(userId);
    assert(ids.length === 4, `4 LinkedIn messages, got ${ids.length}`);
    assert(
      ids.every((id) => id.startsWith(`li:${hexOf(acct)}:`)),
      'messages attributed to the account'
    );
    const replay = await reportPhase(token, { agent_id: agentId, phase: 'waiting_for_export' });
    assertStatus(replay.status, 409, replay.data);
    assert((replay.data as { error?: string }).error === 'SYNC_FINISHED', 'finished run is sticky');
  } finally {
    await cleanup(userId, [agentId]);
  }
}

export async function testLinkedinPhases_expiredExportEndsFailed() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentId = await createAgent(userId);
  try {
    assertStatus((await startSync(token, agentId)).status, 200, null);
    // An agent that does not know its own id reports against the one live run.
    const requested = await reportPhase(token, { phase: 'export_requested' });
    assertStatus(requested.status, 200, requested.data);
    assert((requested.data as { run_id?: string }).run_id === `li-agent-${agentId}`, 'its run');
    const noError = await reportPhase(token, { agent_id: agentId, phase: 'failed' });
    assertStatus(noError.status, 400, noError.data);
    const reason = 'The LinkedIn archive download link expired';
    const failed = await reportPhase(token, { agent_id: agentId, phase: 'failed', error: reason });
    assertStatus(failed.status, 200, failed.data);
    const a = await account(token, 'default');
    assert(a.state === 'failed' && a.lastError === reason, `failed with lastError, got ${a.state}`);
    assert(a.progress.phase === 'export_requested', 'failed where it stopped');
    assert(a.progress.eta_sec === null, 'no ETA on failure');
    const r = await row(token, 'default');
    assert(r.status === 'SYNC_FAILED' && r.failureReason === reason, 'row failed too');
    assert(phasesOf(r).join(' > ') === 'starting > export_requested > failed', 'no phase skipped');
    const late = await reportPhase(token, { agent_id: agentId, phase: 'waiting_for_export' });
    assertStatus(late.status, 409, late.data);
  } finally {
    await cleanup(userId, [agentId]);
  }
}

export async function testLinkedinPhases_agentEndsWhileWaitingReadsFailed() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentId = await createAgent(userId);
  try {
    assertStatus((await startSync(token, agentId, 'urn:li:member:4004')).status, 200, null);
    await reportPhase(token, { agent_id: agentId, phase: 'export_requested' });
    await reportPhase(token, { agent_id: agentId, phase: 'waiting_for_export' });
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    const a = await account(token, 'urn:li:member:4004');
    assert(a.state === 'failed', `a dead export agent reads failed, got ${a.state}`);
    assert(a.lastError === 'The LinkedIn export agent ended before uploading the export', 'why');
    assert(a.progress.phase === 'waiting_for_export', 'last real phase kept');
    const delta = await request(`${BASE_URL}/api/integrations/progress`, {
      headers: authHeaders(token),
    });
    const polled = (
      delta.data as { accountsByProvider: Record<string, Account[]> }
    ).accountsByProvider.linkedin.find((x) => x.accountId === 'urn:li:member:4004');
    assert(JSON.stringify(polled) === JSON.stringify(a), 'delta poll settles the same way');
  } finally {
    await cleanup(userId, [agentId]);
  }
}

export async function testLinkedinUpload_corruptArchiveEndsFailed() {
  const { accessToken: token, userId } = await createAnonSession();
  try {
    const res = await uploadArchive(token, Buffer.from('PK\u0003\u0004 not really a zip'), {
      accountId: 'urn:li:member:5005',
    });
    assertStatus(res.status, 500, res.data);
    const a = await account(token, 'urn:li:member:5005');
    assert(a.state === 'failed' && a.lastError !== null, `corrupt archive fails, got ${a.state}`);
    const r = await row(token, 'urn:li:member:5005');
    assert(phasesOf(r).join(' > ') === 'uploading > failed', `got ${phasesOf(r).join(' > ')}`);
  } finally {
    await cleanup(userId, []);
  }
}

export async function testLinkedinUpload_withoutSyncImportsDefaultAccount() {
  const { accessToken: token, userId } = await createAnonSession();
  try {
    const res = await uploadArchive(token, archive(owner, people('d'), 'd'));
    assertStatus(res.status, 200, res.data);
    assert((res.data as { account_id?: string }).account_id === 'default', 'default account');
    const a = await account(token, 'default');
    assert(a.state === 'synced' && a.progress.done === 6, `default synced, got ${a.state}`);
    const r = await row(token, 'default');
    assert(
      phasesOf(r).join(' > ') === 'uploading > parsing > synced',
      `no agent phase without an agent, got ${phasesOf(r).join(' > ')}`
    );
    assert((r.config?.syncAgentId ?? null) === null, 'no export agent recorded');
    const ids = await linkedinMessageIds(userId);
    assert(ids.length === 4 && ids.every((id) => !id.startsWith('li:')), 'legacy ids on default');
  } finally {
    await cleanup(userId, []);
  }
}

export async function testLinkedinAccounts_reportNamesTheAccount() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentId = await createAgent(userId);
  try {
    assertStatus((await startSync(token, agentId)).status, 200, null);
    assert((await account(token, 'default')).progress.phase === 'starting', 'unnamed start');
    const named = await reportPhase(token, {
      agent_id: agentId,
      phase: 'export_requested',
      account_id: 'https://www.linkedin.com/in/Ada-Owner-3003/',
    });
    assertStatus(named.status, 200, named.data);
    assert((named.data as { account_id?: string }).account_id === 'ada-owner-3003', 'normalized');
    const { accounts, rows } = await listed(token);
    assert(accounts.length === 1, `one LinkedIn account, got ${accounts.map((x) => x.accountId)}`);
    assert(accounts[0].accountId === 'ada-owner-3003', 'the run moved to the named account');
    assert(
      accounts[0].label === 'linkedin.com/in/ada-owner-3003',
      `server label for a profile id, got ${accounts[0].label}`
    );
    assert(accounts[0].progress.phase === 'export_requested', 'with its current phase');
    assert(rows.length === 1 && rows[0].config?.syncAgentId === agentId, 'one row, same agent');
    assert(phasesOf(rows[0]).join(' > ') === 'starting > export_requested', 'history moved too');

    // A retried start for the same agent replays its moved run, never a second one.
    const retried = await startSync(token, agentId);
    assertStatus(retried.status, 200, retried.data);
    assert((retried.data as { account_id?: string }).account_id === 'ada-owner-3003', 'replay');
    const after = await listed(token);
    assert(after.accounts.length === 1, 'still one account after a retried start');
    assert(after.accounts[0].progress.phase === 'export_requested', 'phase not rewound');
  } finally {
    await cleanup(userId, [agentId]);
  }
}

export async function testLinkedinAccounts_twoAccountsSyncIndependentlyAndDeleteOne() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentA = await createAgent(userId);
  const agentB = await createAgent(userId);
  const a = 'urn:li:member:2001';
  const b = 'jane-doe-2002';
  try {
    assertStatus((await startSync(token, agentA, a)).status, 200, null);
    const second = await startSync(token, agentB, 'https://www.linkedin.com/in/Jane-Doe-2002');
    assertStatus(second.status, 200, second.data);
    const ambiguous = await reportPhase(token, { phase: 'export_requested' });
    assertStatus(ambiguous.status, 400, ambiguous.data);
    const runs = ambiguous.data as { error?: string; accounts?: string[] };
    assert(runs.error === 'RUN_REQUIRED', `two live runs need a key, got ${runs.error}`);
    assert(runs.accounts?.sort().join() === [a, b].sort().join(), 'both runs named');
    const byAccount = await reportPhase(token, { phase: 'export_requested', account_id: a });
    assertStatus(byAccount.status, 200, byAccount.data);
    let accounts = (await listed(token)).accounts;
    assert(accounts.length === 2, `two accounts listed, got ${accounts.length}`);
    const phaseOf = (id: string) => accounts.find((x) => x.accountId === id)?.progress.phase;
    assert(phaseOf(a) === 'export_requested' && phaseOf(b) === 'starting', 'independent phases');

    // Same correspondents in both archives: each account keeps its own copy.
    const shared = people('s');
    assertStatus(
      (await uploadArchive(token, archive(owner, shared, 's'), { accountId: a })).status,
      200,
      null
    );
    accounts = (await listed(token)).accounts;
    assert(phaseOf(b) === 'starting', "A's upload does not move B");
    assert(accounts.find((x) => x.accountId === a)?.state === 'synced', 'A synced');
    assertStatus(
      (await uploadArchive(token, archive(owner, shared, 's'), { accountId: b })).status,
      200,
      null
    );
    const ids = await linkedinMessageIds(userId);
    const ofA = ids.filter((id) => id.startsWith(`li:${hexOf(a)}:`)).length;
    const ofB = ids.filter((id) => id.startsWith(`li:${hexOf(b)}:`)).length;
    assert(ofA === 4 && ofB === 4, `4 messages per account, got A=${ofA} B=${ofB}`);
    const peopleBefore = await prisma.person.count({ where: { userId } });

    const del = await request(
      `${BASE_URL}/api/integrations/linkedin/accounts/${encodeURIComponent(a)}`,
      { method: 'DELETE', headers: authHeaders(token) }
    );
    assertStatus(del.status, 200, del.data);
    const after = await linkedinMessageIds(userId);
    assert(!after.some((id) => id.startsWith(`li:${hexOf(a)}:`)), "A's messages are gone");
    assert(after.filter((id) => id.startsWith(`li:${hexOf(b)}:`)).length === 4, "B's are kept");
    const left = await listed(token);
    assert(left.accounts.map((x) => x.accountId).join() === b, 'only B is listed');
    assert(left.accounts[0].state === 'synced', 'B still synced');
    assert(left.rows.length === 1 && left.rows[0].accountId === b, "A's row is gone");
    const progressA = await prisma.integrationSyncProgress.count({
      where: { userId, provider: 'linkedin', accountId: a },
    });
    assert(progressA === 0, "A's progress row is gone");
    assert(
      (await prisma.person.count({ where: { userId } })) === peopleBefore,
      'shared contact records are kept'
    );
    const again = await request(
      `${BASE_URL}/api/integrations/linkedin/accounts/${encodeURIComponent(a)}`,
      { method: 'DELETE', headers: authHeaders(token) }
    );
    assertStatus(again.status, 404, again.data);
  } finally {
    await cleanup(userId, [agentA, agentB]);
  }
}

export async function testLinkedinPhase_unknownAgentAndOtherUser() {
  const owner1 = await createAnonSession();
  const other = await createAnonSession();
  const agentId = await createAgent(owner1.userId);
  try {
    assertStatus((await startSync(owner1.accessToken, agentId)).status, 200, null);
    const stranger = await reportPhase(other.accessToken, {
      agent_id: agentId,
      phase: 'export_requested',
    });
    assertStatus(stranger.status, 404, stranger.data);
    const unknown = await reportPhase(owner1.accessToken, {
      agent_id: randomUUID(),
      phase: 'export_requested',
    });
    assertStatus(unknown.status, 404, unknown.data);
    const noAuth = await request(PHASE_URL, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, phase: 'export_requested' }),
    });
    assertStatus(noAuth.status, 401, noAuth.data);
    assert(
      (await account(owner1.accessToken, 'default')).progress.phase === 'starting',
      'nothing moved'
    );
  } finally {
    await cleanup(owner1.userId, [agentId]);
  }
}

export async function testLinkedinAccounts_namingAnAccountHandsBackTheImportedDefault() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentId = await createAgent(userId);
  try {
    assertStatus((await uploadArchive(token, archive(owner, people('h'), 'h'))).status, 200, null);
    const legacyIds = await linkedinMessageIds(userId);
    assertStatus((await startSync(token, agentId)).status, 200, null);
    assert((await row(token, 'default')).status === 'SYNCING', 'the default account resyncs');
    const named = await reportPhase(token, {
      agent_id: agentId,
      phase: 'export_requested',
      account_id: 'urn:li:member:6006',
    });
    assertStatus(named.status, 200, named.data);
    const { accounts } = await listed(token);
    const ids = accounts.map((a) => a.accountId).sort();
    assert(ids.join() === 'default,urn:li:member:6006', `two accounts, got ${ids.join()}`);
    const moved = accounts.find((a) => a.accountId === 'urn:li:member:6006');
    assert(moved?.progress.phase === 'export_requested', 'the run continues on the named account');
    const back = await row(token, 'default');
    assert(back.status === 'CONNECTED', `the imported default is handed back, got ${back.status}`);
    assert((back.config?.syncAgentId ?? null) === null, 'without the moved run');
    assert(back.config?.linkedinSync === undefined, 'no sync state left on the default');
    assert(
      accounts.find((a) => a.accountId === 'default')?.state === 'synced',
      'default reads its import again'
    );
    const after = await linkedinMessageIds(userId);
    assert(after.sort().join() === legacyIds.sort().join(), 'the default import is untouched');
  } finally {
    await cleanup(userId, [agentId]);
  }
}

export async function testLinkedinUpload_twoWaitingSyncsNeedAccountId() {
  const { accessToken: token, userId } = await createAnonSession();
  const agentA = await createAgent(userId);
  const agentB = await createAgent(userId);
  try {
    assertStatus((await startSync(token, agentA, 'urn:li:member:7001')).status, 200, null);
    assertStatus((await startSync(token, agentB, 'urn:li:member:7002')).status, 200, null);
    const res = await uploadArchive(token, archive(owner, people('w'), 'w'));
    assertStatus(res.status, 400, res.data);
    const body = res.data as { error?: string; accounts?: string[] };
    assert(body.error === 'ACCOUNT_REQUIRED', `ambiguous upload refused, got ${body.error}`);
    assert(body.accounts?.sort().join() === 'urn:li:member:7001,urn:li:member:7002', 'names both');
    const { accounts } = await listed(token);
    assert(
      accounts.every((a) => a.progress.phase === 'starting'),
      'neither account was marked uploading'
    );
    assert((await linkedinMessageIds(userId)).length === 0, 'nothing imported');
  } finally {
    await cleanup(userId, [agentA, agentB]);
  }
}

export async function testLinkedinUpload_cutOffBodyEndsFailed() {
  const { accessToken: token, userId } = await createAnonSession();
  const acct = 'urn:li:member:8008';
  try {
    await uploadArchive(token, archive(owner, people('c'), 'c'), {
      accountId: acct,
      pieces: 3,
      pauseMs: 400,
      abortAfterPieces: 1,
    });
    const a = await eventually(
      () => account(token, acct),
      (x) => x.state !== 'syncing'
    );
    assert(a.state === 'failed' && a.lastError !== null, `a cut-off upload fails, got ${a.state}`);
    assert(a.progress.phase === 'uploading', 'it failed while uploading');
    const r = await row(token, acct);
    assert(phasesOf(r).join(' > ') === 'uploading > failed', `got ${phasesOf(r).join(' > ')}`);
    assert(r.status === 'SYNC_FAILED', 'row failed');
    assert((await linkedinMessageIds(userId)).length === 0, 'nothing imported');
  } finally {
    await cleanup(userId, []);
  }
}
