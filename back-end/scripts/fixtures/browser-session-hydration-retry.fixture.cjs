/** Registered local hydration-retry regression. Production resume, checkpoint and Prisma;
 * only provider allocation, provider inspection and CDP transport are controlled.
 * No provider/model/card calls. Every row is UUID-owned and removed in finally.
 */
const assert = require('node:assert/strict'),
  Module = require('node:module'),
  fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const dbURL = new URL(process.env.DATABASE_URL);
assert(['localhost', '127.0.0.1'].includes(dbURL.hostname));
assert.match(dbURL.pathname, /^\/victoria_[\w-]+$/);
process.env.CONDUCTOR_WORKSPACE_NAME = 'hydration-controlled-' + process.pid;
process.env.BENCHMARK_ISOLATED_RUN = 'false';
process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = 'false';
require(require.resolve('tsx/cjs'));
const src = root + '/back-end/src/providers',
  candidate = src;
const load = Module._load;
let failClose = false,
  failConnect = false,
  onConnect,
  failGotoBeforeCommit = false;
const artifacts = new Map();
let prisma,
  lifecycle,
  creates = 0,
  gotocalls = 0,
  connectionCloses = 0,
  pageCreates = 0,
  pageCloses = 0,
  storageWrites = 0,
  inspectMode = 'exact',
  failGoto = true,
  pendingGoto,
  onGotoBlocked;
const nativeIds = new Set(),
  receipts = [],
  releases = [];
const contexts = new Map();
const browser = (id) => {
  let context = contexts.get(id);
  if (!context) {
    const pages = [];
    context = {
      setStorageState: async () => {
        storageWrites++;
      },
      pages: () => pages,
      newPage: async () => makePage(),
      newCDPSession: async (page) => ({
        send: async (method) => {
          if (method === 'Target.getTargetInfo') {
            assert.equal(method, 'Target.getTargetInfo');
            return { targetInfo: { targetId: page.targetId } };
          }
          assert(
            ['Page.enable', 'Network.enable', 'Network.setBypassServiceWorker'].includes(method)
          );
          return {};
        },
        detach: async () => {},
      }),
    };
    const makePage = () => {
      pageCreates++;
      let url = 'about:blank';
      const page = {
        targetId: randomUUID(),
        context: () => context,
        route: async () => {},
        unroute: async () => {},
        evaluate: async () => {},
        url: () => url,
        setURL: (value) => (url = value),
        close: async () => {
          pageCloses++;
          pages.splice(pages.indexOf(page), 1);
        },
        goto: async (next, opts) => {
          if (new URL(next).pathname.startsWith('/.rose-session-restore-')) {
            assert.equal(new URL(next).origin, 'http://127.0.0.1:22441');
            url = next;
            return;
          }
          assert.equal(
            next,
            'http://127.0.0.1:22441/test_payment?token=synthetic-redaction-check#fixture'
          );
          assert.deepEqual(opts, { waitUntil: 'domcontentloaded', timeout: 30000 });
          gotocalls++;
          if (!failGoto || !failGotoBeforeCommit) url = next;
          if (pendingGoto) {
            onGotoBlocked?.();
            await pendingGoto;
          }
          if (failGoto) {
            failGoto = false;
            throw Object.assign(new Error('page.goto: Timeout 30000ms exceeded'), {
              name: 'TimeoutError',
            });
          }
        },
      };
      pages.push(page);
      return page;
    };
    makePage();
    contexts.set(id, context);
  }
  return {
    contexts: () => [context],
    close: async () => {
      connectionCloses++;
      if (failClose) throw Error('fixture transport close failed');
    },
  };
};
const health = async (id) => ({
  provider: 'kernel',
  sessionId: id,
  status: nativeIds.has(id) ? 'active' : 'stopped',
  ttlMs: 1800000,
});
const nativeResume = async (taskId) => {
  const scope = lifecycle.browserResumeScope();
  assert(scope);
  const intent = await scope.beforeCreate('kernel');
  assert.equal(intent.recoveredId, undefined);
  const id = await lifecycle.resumeNativeCreate(async () => {
    creates++;
    const id = randomUUID();
    nativeIds.add(id);
    return id;
  });
  await prisma.browserSession.update({
    where: { id: taskId },
    data: { sessionId: id, wsUrl: id, debugUrl: 'https://fixture.invalid', status: 'PAUSED' },
  });
  return {
    provider: 'kernel',
    sessionId: id,
    wsUrl: id,
    debugUrl: 'https://fixture.invalid',
    savedUrl: 'http://127.0.0.1:22441/test_payment?token=synthetic-redaction-check#fixture',
    proxySource: 'fixture',
    proxyLocation: { country: 'US' },
    profileId: null,
    profileSource: 'logical_checkpoint',
    validationBrowser: browser(id),
    previousSessionId: null,
    previousProvider: 'kernel',
    previousSessionReleased: true,
  };
};
Module._load = function (id, parent, isMain) {
  const owner = parent?.filename ?? '';
  if (owner === candidate + '/browser/resumeHydrationCleanup.ts' && id === './sessionCleanup')
    return {
      releaseSupersededBrowser: async (release) => {
        assert.equal(release.previousProvider, 'kernel');
        assert.equal(release.operation, 'resume');
        assert(nativeIds.has(release.previousSessionId));
        releases.push({ ...release });
        // Preserve unconfirmed native custody while observing the attempted release.
        return false;
      },
    };
  if (owner === candidate + '/browser/checkpoint.ts' && id === '../projects/secrets')
    return { encryptProjectSecret: (value) => value, decryptProjectSecret: (value) => value };
  if (owner === candidate + '/browser/checkpoint.ts' && id === '../codeSessions/artifactStore')
    return {
      putCheckpointObject: async (key, value) => artifacts.set(key, value),
      getCheckpointObject: async (key) => artifacts.get(key) ?? null,
    };
  if (id.endsWith('/browser/resumeLifecycle') || id.endsWith('/browser/resumeLifecycle.ts'))
    return load.call(this, candidate + '/browser/resumeLifecycle.ts', parent, isMain);
  if (owner === candidate + '/browserSessionResume.ts' && id === './browser/checkpoint')
    return load.call(this, candidate + '/browser/checkpoint.ts', parent, isMain);
  if (owner === candidate + '/browserSessionResume.ts' && id === './browser')
    return {
      resumeSession: nativeResume,
      getBrowserSessionHealth: health,
      getFingerprintInjectionData: async () => null,
      injectUserData: async () => {
        throw Error('unexpected inject');
      },
      closeSession: async () => {
        throw Error('unexpected release');
      },
    };
  if (owner === candidate + '/browserSessionResume.ts' && id === './browser/resumeRecovery')
    return {
      inspectResumeCandidate: async (provider, marker, identity) => {
        assert.equal(provider, 'kernel');
        const row = await prisma.toolSideEffect.findFirstOrThrow({
          where: { request: { path: ['requestId'], equals: marker } },
        });
        assert.equal(row.request.ownershipIdentity, identity);
        const id = row.request.nativeId;
        if (inspectMode === 'null') return null;
        if (inspectMode === 'multiple')
          throw Error('Browser resume locator matched multiple native sessions');
        return {
          id: inspectMode === 'wrong' ? randomUUID() : id,
          status: inspectMode === 'stopped' ? 'stopped' : 'active',
        };
      },
    };
  if (owner === candidate + '/browserSessionResume.ts' && id === './steel/sessionConnection')
    return {
      connectValidatedBrowser: async (id) => {
        assert(nativeIds.has(id));
        if (onConnect) await onConnect();
        if (failConnect) return null;
        return browser(id);
      },
    };
  return load.call(this, id, parent, isMain);
};
globalThis.fetch = async () => {
  throw Error('external network forbidden');
};
prisma = require(src + '/database.ts').prisma;
lifecycle = require(candidate + '/browser/resumeLifecycle.ts');
const { resumeBrowserSession } = require(candidate + '/browserSessionResume.ts');
const userIds = [],
  rowIds = [];
const key = (id) => 'steel-browser-task-lifecycle:' + id;
async function fixture(withStorage = false) {
  const userId = 'hydrate-' + randomUUID();
  userIds.push(userId);
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const context = await prisma.browserContext.create({ data: { userId } });
  const row = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      provider: 'kernel',
      sessionId: randomUUID(),
      checkpointRef: 'browser-checkpoint:empty:v1',
      status: 'PAUSED',
      logicalOwnerKey: 'agent:' + randomUUID(),
      baselineCheckpointRef: 'browser-checkpoint:empty:v1',
      startUrl: 'http://127.0.0.1:22441/test_payment?token=synthetic-redaction-check#fixture',
      currentUrl: 'http://127.0.0.1:22441/test_payment?token=synthetic-redaction-check#fixture',
    },
  });
  rowIds.push(row.id);
  if (withStorage) {
    const { writeBrowserCheckpoint } = require(candidate + '/browser/checkpoint.ts');
    const ref = await writeBrowserCheckpoint({
      version: 1,
      userId,
      sourceLogicalId: row.id,
      sourceRevision: 0,
      storage: { cookies: [], origins: [] },
      tabs: [1, 2].map((index) => ({
        url: row.currentUrl,
        sessionStorage: [{ name: 'fixture-session-' + index, value: 'private-fixture' }],
      })),
      limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'],
    });
    await prisma.browserSession.update({ where: { id: row.id }, data: { checkpointRef: ref } });
  }
  return row;
}
async function failed(row) {
  failGoto = true;
  await assert.rejects(resumeBrowserSession(row.id), /page.goto: Timeout 30000ms exceeded/);
  const held = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(row.id) },
  });
  assert.equal(held.status, 'STARTED');
  assert.equal(held.request.phase, 'hydrating');
  assert.equal(held.request.nativeOutstanding, true);
  assert.equal(
    JSON.stringify({ request: held.request, response: held.response }).includes(
      'synthetic-redaction-check'
    ),
    false,
    'custody ledger must not persist URL credentials'
  );
  const binding = await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(held.request.nativeId, binding.sessionId);
  receipts.push({
    kind: 'failed',
    row: row.id,
    native: binding.sessionId,
    response: held.response,
  });
  return { held, binding };
}
async function run() {
  const row = await fixture(),
    first = await failed(row);
  const count = creates,
    start = Date.now(),
    firstPages = contexts
      .get(first.binding.sessionId)
      .pages()
      .map((p) => ({ targetId: p.targetId, url: p.url() })),
    pagesBefore = pageCreates,
    closesBefore = pageCloses;
  const controlRepo = require(root + '/back-end/src/domains/browser-session/repo.ts');
  assert.equal(
    await controlRepo.transitionBrowserControlState(
      row.id,
      ['AGENT'],
      'USER',
      new Date(Date.now() + 60000)
    ),
    false
  );
  assert.equal(
    (await prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } })).controlState,
    'AGENT'
  );
  receipts.push({ kind: 'canonical-user-grant-rejected-while-paused', passed: true });
  const result = await resumeBrowserSession(row.id);
  assert.equal(result.session_id, first.binding.sessionId);
  assert.equal(result.status, 'ACTIVE');
  assert.equal(creates, count);
  assert.equal(gotocalls, 2);
  assert.equal(connectionCloses, 2);
  assert.equal(
    contexts.get(result.session_id).pages().length,
    1,
    'partial failed navigation must not duplicate checkpoint tabs'
  );
  assert.equal(pageCreates, pagesBefore);
  assert.equal(pageCloses, closesBefore);
  assert.deepEqual(
    contexts
      .get(result.session_id)
      .pages()
      .map((p) => ({ targetId: p.targetId, url: p.url() })),
    firstPages
  );
  const ready = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(row.id) },
  });
  assert.equal(ready.status, 'RELEASED');
  assert.equal(ready.response.phase, 'ready');
  assert.equal(ready.externalId === first.held.externalId, false);
  receipts.push({
    kind: 'same-native-recovered',
    elapsedMs: Date.now() - start,
    native: result.session_id,
    creates,
    gotos: gotocalls,
    pages: firstPages,
    newPages: pageCreates - pagesBefore,
    closedPages: pageCloses - closesBefore,
  });
  for (const control of [
    'foreign-owner',
    'checkpoint',
    'source',
    'context',
    'logical-owner',
    'provider',
    'user-control',
    'wrong-native',
    'null-native',
    'stopped-native',
    'multiple-native',
    'incompatible',
    'baseline',
    'url',
    'transport',
    'expired',
    'unknown-page',
    'missing-page',
    'changed-page',
    'navigated-page',
    'missing-control',
    'missing-checkpoint-revision',
  ]) {
    const row = await fixture(),
      { held, binding } = await failed(row);
    const before = creates,
      storageBefore = storageWrites;
    let expected = /Acknowledged browser hydration/;
    if (control === 'foreign-owner') {
      await prisma.toolSideEffect.update({
        where: { id: held.id },
        data: { request: { ...held.request, ownershipIdentity: 'foreign' } },
      });
    }
    if (control === 'missing-control' || control === 'missing-checkpoint-revision') {
      const response = { ...held.response, binding: { ...held.response.binding } };
      delete response.binding[
        control === 'missing-control' ? 'controlState' : 'checkpointRevision'
      ];
      await prisma.toolSideEffect.update({ where: { id: held.id }, data: { response } });
    }
    if (control === 'navigated-page')
      contexts.get(binding.sessionId).pages()[0].setURL('https://user-page.invalid');
    if (control === 'unknown-page') await contexts.get(binding.sessionId).newPage();
    if (control === 'missing-page') await contexts.get(binding.sessionId).pages()[0].close();
    if (control === 'changed-page')
      contexts.get(binding.sessionId).pages()[0].targetId = randomUUID();
    if (control === 'baseline')
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { baselineCheckpointRef: 'changed' },
      });
    if (control === 'url')
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { currentUrl: 'https://changed.invalid' },
      });
    if (control === 'transport')
      await prisma.browserSession.update({ where: { id: row.id }, data: { wsUrl: 'changed' } });
    if (control === 'expired')
      await prisma.toolSideEffect.update({
        where: { id: held.id },
        data: { request: { ...held.request, expiresAt: new Date(0).toISOString() } },
      });
    if (control === 'checkpoint')
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { checkpointRevision: 1 },
      });
    if (control === 'source')
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { sessionId: randomUUID() },
      });
    if (control === 'context') {
      const other = 'hydrate-other-' + randomUUID();
      userIds.push(other);
      await prisma.user.create({ data: { userId: other, isAnonymous: true } });
      const context = await prisma.browserContext.create({ data: { userId: other } });
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { contextId: context.id },
      });
    }
    if (control === 'logical-owner')
      await prisma.browserSession.update({
        where: { id: row.id },
        data: { logicalOwnerKey: 'changed' },
      });
    if (control === 'provider')
      await prisma.browserSession.update({ where: { id: row.id }, data: { provider: 'steel' } });
    if (control === 'user-control') {
      await prisma.browserSession.update({ where: { id: row.id }, data: { controlState: 'USER' } });
      expected = /under user control/;
    }
    inspectMode =
      {
        'wrong-native': 'wrong',
        'null-native': 'null',
        'stopped-native': 'stopped',
        'multiple-native': 'multiple',
      }[control] ?? 'exact';
    if (control === 'multiple-native') expected = /multiple native sessions/;
    if (control === 'incompatible') expected = /incompatible/;
    await assert.rejects(
      resumeBrowserSession(row.id, control === 'incompatible' ? { forceFreshProfile: true } : {}),
      expected
    );
    assert.equal(creates, before);
    assert.equal(storageWrites, storageBefore, 'rejected recovery must not mutate storage');
    inspectMode = 'exact';
    receipts.push({ kind: 'negative', control, passed: true });
  }
  for (const control of ['ack-write-failure', 'owner-lost', 'transport-close-failed']) {
    const row = await fixture();
    const before = creates;
    failClose = control === 'transport-close-failed';
    const update = prisma.toolSideEffect.updateMany.bind(prisma.toolSideEffect);
    prisma.toolSideEffect.updateMany = async (args) => {
      if (args.data.response?.phase === 'hydration_failed') {
        if (control === 'ack-write-failure') throw Error('fixture acknowledgement write failed');
        await prisma.toolSideEffect.update({
          where: { operationKey: key(row.id) },
          data: { externalId: 'foreign-owner' },
        });
      }
      return update(args);
    };
    await failed(row);
    failClose = false;
    prisma.toolSideEffect.updateMany = update;
    const held = await prisma.toolSideEffect.findUniqueOrThrow({
      where: { operationKey: key(row.id) },
    });
    assert.equal(held.response, null);
    assert.equal(held.status, 'STARTED');
    assert.equal(creates, before + 1);
    receipts.push({ kind: 'negative', control, passed: true });
  }
  const concurrent = await fixture();
  const prior = await failed(concurrent);
  const beforeConcurrent = creates,
    gotoBefore = gotocalls;
  let releaseConcurrent, enteredConcurrent;
  pendingGoto = new Promise((r) => (releaseConcurrent = r));
  const enteredPromiseConcurrent = new Promise((r) => (enteredConcurrent = r));
  const updateConcurrent = prisma.toolSideEffect.updateMany.bind(prisma.toolSideEffect);
  prisma.toolSideEffect.updateMany = async (args) => {
    const result = await updateConcurrent(args);
    if (args.data.request?.phase === 'hydrating') enteredConcurrent();
    return result;
  };
  const leader = resumeBrowserSession(concurrent.id);
  await enteredPromiseConcurrent;
  const inProgress = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(concurrent.id) },
  });
  assert.equal(inProgress.response, null);
  assert.notEqual(inProgress.externalId, prior.held.externalId);
  let followerSettled = false;
  const follower = resumeBrowserSession(concurrent.id).finally(() => (followerSettled = true));
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(followerSettled, false);
  assert.equal(creates, beforeConcurrent);
  releaseConcurrent();
  pendingGoto = undefined;
  const [a, b] = await Promise.all([leader, follower]);
  prisma.toolSideEffect.updateMany = updateConcurrent;
  assert.equal(a.session_id, prior.binding.sessionId);
  assert.equal(b.session_id, prior.binding.sessionId);
  assert.equal(creates, beforeConcurrent);
  assert.equal(gotocalls, gotoBefore + 1);
  receipts.push({ kind: 'concurrent-same-native', passed: true });
  // Live hydration has no completion acknowledgement; a second caller must not adopt.
  const active = await fixture();
  failGoto = false;
  let release;
  pendingGoto = new Promise((r) => (release = r));
  const enteredPromise = new Promise((r) => (entered = r));
  onGotoBlocked = entered;
  const gotoBeforeActive = gotocalls;
  const work = resumeBrowserSession(active.id);
  try {
    // Navigation is suspended only after hydration target provenance commits.
    // Expiring the earlier phase write races that later provenance write.
    await enteredPromise;
    assert.equal(
      gotocalls,
      gotoBeforeActive + 1,
      'fixture must hold actual navigation before expiring custody'
    );
    const held = await prisma.toolSideEffect.findUniqueOrThrow({
      where: { operationKey: key(active.id) },
    });
    assert.equal(held.response, null);
    assert.equal(held.request.phase, 'hydrating');
    assert(held.request.hydrationTargets?.length > 0, 'Held goto must have durable provenance');
    const before = creates; // The active owner retains its original immutable request.
    await prisma.toolSideEffect.update({
      where: { id: held.id },
      data: { request: { ...held.request, expiresAt: new Date(0).toISOString() } },
    });
    await assert.rejects(resumeBrowserSession(active.id), /hydration outcome remains unknown/);
    assert.equal(creates, before);
  } finally {
    release();
    pendingGoto = undefined;
    onGotoBlocked = undefined;
    await work;
  }
  receipts.push({ kind: 'no-ack-inflight', passed: true }); // Carried state is outside the encrypted checkpoint receipt: do not acknowledge it.
  const carried = { cookies: [], origins: [{ origin: 'https://carry.invalid', localStorage: [] }] };
  const carryPending = await fixture();
  failGoto = true;
  const pendingCreates = creates;
  await prisma.browserSession.update({
    where: { id: carryPending.id },
    data: { provider: 'tilion', pausedBrowserState: carried },
  });
  const tilionEnabledBefore = process.env.BROWSER_AGENT_TILION_ENABLED;
  process.env.BROWSER_AGENT_TILION_ENABLED = 'false';
  try {
    // The caller supplied no carry: main loads it from the paused Tilion row.
    await assert.rejects(
      resumeBrowserSession(carryPending.id),
      /page.goto: Timeout 30000ms exceeded/
    );
  } finally {
    if (tilionEnabledBefore === undefined) delete process.env.BROWSER_AGENT_TILION_ENABLED;
    else process.env.BROWSER_AGENT_TILION_ENABLED = tilionEnabledBefore;
  }
  const pendingHeld = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(carryPending.id) },
  });
  assert.equal(pendingHeld.status, 'STARTED');
  assert.equal(pendingHeld.request.phase, 'hydrating');
  assert.equal(
    pendingHeld.response,
    null,
    'pending carry cannot become a checkpoint-only retry receipt'
  );
  assert.equal(creates, pendingCreates + 1);
  receipts.push({ kind: 'carry-pending-suppresses-ack', passed: true });

  // A new carry must not consume a prior checkpoint-only failure acknowledgement.
  const newCarry = await fixture();
  const priorCarryAck = await failed(newCarry);
  assert.equal(priorCarryAck.held.response.phase, 'hydration_failed');
  const beforeCarry = { creates, gotocalls, storageWrites, connectionCloses };
  await assert.rejects(
    resumeBrowserSession(newCarry.id, { carriedState: carried }),
    /Acknowledged browser hydration binding changed/
  );
  assert.deepEqual({ creates, gotocalls, storageWrites, connectionCloses }, beforeCarry);
  const afterCarryAck = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(newCarry.id) },
  });
  assert.equal(afterCarryAck.status, 'STARTED');
  assert.equal(afterCarryAck.externalId, priorCarryAck.held.externalId);
  assert.deepEqual(afterCarryAck.response, priorCarryAck.held.response);
  receipts.push({ kind: 'new-carry-cannot-adopt-old-ack', passed: true });
}
async function seededRetry() {
  failGotoBeforeCommit = true;
  const row = await fixture(true),
    first = await failed(row);
  const pages = contexts.get(first.binding.sessionId).pages();
  const targetIds = pages.map((p) => p.targetId),
    before = creates;
  assert.equal(pages.length, 2);
  assert(pages.every((p) => new URL(p.url()).pathname.startsWith('/.rose-session-restore-')));
  const result = await resumeBrowserSession(row.id);
  assert.equal(result.session_id, first.binding.sessionId);
  assert.equal(creates, before);
  assert.deepEqual(
    pages.map((p) => p.targetId),
    targetIds
  );
  assert(pages.every((p) => p.url() === row.currentUrl));
  assert(first.held.request.hydrationTargets.every((t) => /^[a-f0-9]{64}$/.test(t.seedUrlHash)));
  receipts.push({ kind: 'seed-url-before-commit-recovery', passed: true });
  for (const control of ['same-origin-fake-seed', 'foreign-origin-exact-seed-hash']) {
    const other = await fixture(true),
      prior = await failed(other);
    const page = contexts.get(prior.binding.sessionId).pages()[0];
    const url =
      control === 'same-origin-fake-seed'
        ? 'http://127.0.0.1:22441/.rose-session-restore-unrecorded'
        : 'https://foreign.invalid/.rose-session-restore-exact';
    page.setURL(url);
    if (control === 'foreign-origin-exact-seed-hash') {
      const hash = require('node:crypto').createHash('sha256').update(url).digest('hex');
      const targets = prior.held.request.hydrationTargets.map((t, i) =>
        i ? t : { ...t, seedUrlHash: hash }
      );
      await prisma.toolSideEffect.update({
        where: { id: prior.held.id },
        data: {
          request: { ...prior.held.request, hydrationTargets: targets },
          response: { ...prior.held.response, targets },
        },
      });
    }
    const writes = storageWrites,
      count = creates;
    await assert.rejects(resumeBrowserSession(other.id), /page navigation changed/);
    assert.equal(storageWrites, writes);
    assert.equal(creates, count);
    receipts.push({ kind: control, passed: true });
  }
  failGotoBeforeCommit = false;
}
async function preHydrationRetry() {
  failGotoBeforeCommit = false;
  const row = await fixture(),
    prior = await failed(row);
  const count = creates,
    writes = storageWrites;
  failConnect = true;
  await assert.rejects(resumeBrowserSession(row.id), /hydration connection failed/);
  failConnect = false;
  const retained = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: key(row.id) },
  });
  assert.deepEqual(
    retained.response,
    prior.held.response,
    'pre-hydration connection failure must retain the settled receipt'
  );
  assert.notEqual(retained.externalId, prior.held.externalId);
  assert.deepEqual(retained.request, prior.held.request);
  assert.equal(storageWrites, writes);
  assert.equal(creates, count);
  assert.equal((await resumeBrowserSession(row.id)).session_id, prior.binding.sessionId);
  receipts.push({ kind: 'pre-hydration-receipt-restored', passed: true });
  for (const control of [
    'foreign-owner',
    'released-status',
    'changed-request',
    'close-unknown',
    'hydration-started',
  ]) {
    const other = await fixture(),
      first = await failed(other);
    const before = creates;
    const releasesBefore = releases.length;
    if (control === 'hydration-started') {
      failGoto = true;
      failClose = true;
    } else if (control === 'close-unknown') {
      failClose = true;
      onConnect = () =>
        prisma.browserSession.update({ where: { id: other.id }, data: { controlState: 'USER' } });
    } else {
      failConnect = true;
      onConnect = async () => {
        const held = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: key(other.id) },
        });
        await prisma.toolSideEffect.update({
          where: { id: held.id },
          data:
            control === 'foreign-owner'
              ? { externalId: 'fixture-foreign-owner' }
              : control === 'released-status'
                ? { status: 'RELEASED' }
                : { request: { ...held.request, requestId: 'fixture-changed-request' } },
        });
      };
    }
    await assert.rejects(
      resumeBrowserSession(other.id),
      /connection failed|user control|Timeout 30000ms/
    );
    failConnect = false;
    failClose = false;
    onConnect = undefined;
    const held = await prisma.toolSideEffect.findUniqueOrThrow({
      where: { operationKey: key(other.id) },
    });
    assert.equal(held.response, null, control + ' must not restore the predecessor receipt');
    assert.equal(creates, before);
    assert.deepEqual(
      releases.slice(releasesBefore),
      control === 'changed-request'
        ? [
            {
              taskId: other.id,
              previousProvider: 'kernel',
              previousSessionId: first.binding.sessionId,
              operation: 'resume',
            },
          ]
        : [],
      control + ' must release only its exact owned failed candidate'
    );
    receipts.push({ kind: 'pre-hydration-negative-' + control, passed: true });
  }
}
(async () => {
  let error;
  try {
    await run();
    const failures = [];
    for (const check of [seededRetry, preHydrationRetry]) {
      try {
        await check();
      } catch (error) {
        receipts.push({ kind: 'regression-failure', check: check.name, message: error.message });
        failures.push(error);
      } finally {
        failConnect = false;
        failClose = false;
        onConnect = undefined;
        failGotoBeforeCommit = false;
      }
    }
    if (failures.length) throw new AggregateError(failures, 'hydration regression controls failed');
    console.log(JSON.stringify({ status: 'PASS', creates, gotos: gotocalls, receipts }, null, 2));
  } catch (e) {
    error = e;
    console.error(
      JSON.stringify(
        {
          status: 'FAIL',
          error: { name: e.name, message: e.message, stack: e.stack },
          creates,
          gotos: gotocalls,
          receipts,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.toolSideEffect.deleteMany({ where: { operationKey: { in: rowIds.map(key) } } });
    await prisma.browserSession.deleteMany({ where: { id: { in: rowIds } } });
    await prisma.browserContext.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.$disconnect();
    Module._load = load;
  }
  process.exitCode = error ? 1 : 0;
})();
