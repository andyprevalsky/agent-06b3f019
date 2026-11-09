import { phoneFixtureNumber } from './phone-fixture-users';
import { portraitRouteCases } from './iphone-control.portrait-route.cases';
import { seedPortraitRoute } from './iphone-portrait-route.fixture';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { PNG } from 'pngjs';
import { prisma } from '../../providers/database';
import { provePortrait } from '../../providers/phonePortraitProof';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import { freshSetup, observe, setupPost, type SetupDto } from './iphone-control.setup-fixtures';
import { portraitFrame, PORTRAIT_OCR, portraitOcr } from './iphone-portrait.fixture';
import type { Case } from './iphone-control.cases';
export const portraitCases: Case[] = [
  [
    'portrait native masks classify On and Off and reject unsupported visual contexts',
    async () => {
      assert.equal(
        provePortrait(portraitFrame(), portraitOcr(), portraitOcr()).status,
        'confirmed'
      );
      assert.equal(
        provePortrait(portraitFrame(false), portraitOcr(), portraitOcr()).status,
        'disabled'
      );
      for (const [a, b] of [
        ['', ''],
        ['Not Playing', 'Not Playing'],
        [PORTRAIT_OCR, PORTRAIT_OCR + ' changed'],
      ])
        assert.equal(provePortrait(portraitFrame(), a, b).status, 'unknown');
      for (const bytes of [
        Buffer.from('bad'),
        Buffer.alloc(2097153),
        PNG.sync.write(new PNG({ width: 1334, height: 750 })),
        PNG.sync.write(new PNG({ width: 750, height: 1334 })),
      ])
        assert.equal(provePortrait(bytes, portraitOcr(), portraitOcr()).status, 'unknown');
      const broken = PNG.sync.read(portraitFrame());
      broken.data.fill(0, (350 * 750 + 140) * 4, (385 * 750 + 186) * 4);
      assert.equal(
        provePortrait(PNG.sync.write(broken), portraitOcr(), portraitOcr()).status,
        'unknown'
      );
    },
  ],
  ...([true, false] as const).map(
    (on) =>
      [
        `portrait ${on ? 'On' : 'Off'} uses fresh native slot without model billing or media disclosure`,
        async (h) => {
          const f = await freshSetup(h);
          h.framePng = portraitFrame(on);
          h.observationResult = portraitOcr();
          await seedPortraitRoute(h, f);
          const evidence = await observe(h, f);
          const before = h.calls.length;
          let models = 0;
          h.setupVerifier = async () => {
            models++;
            throw new Error('Portrait must be local');
          };
          const response = await setupPost(h, f, {
            action: 'verify',
            verificationTarget: 'portrait_lock',
            attemptId: f.setup.attemptId,
            expectedRevision: f.setup.revision,
            expectedCursor: evidence.cursor,
            evidenceOperationIds: [evidence.id],
            requestKey: randomUUID(),
          });
          assert.equal(response.status, 200);
          assert.equal(response.data.operation?.status, 'SUCCEEDED');
          assert.equal(models, 0);
          const state = response.data.setup as SetupDto & {
            verification: { checks: { portrait_lock: { status: string } } };
          };
          assert.equal(
            state.verification.checks.portrait_lock.status,
            on ? 'confirmed' : 'disabled'
          );
          const calls = h.calls.slice(before);
          assert.equal(
            calls.filter((x) => x.method === 'POST' && x.path.endsWith('/op')).length,
            2
          );
          assert.equal(
            calls.filter((x) => x.method === 'GET' && x.path.endsWith('/frame.png')).length,
            1
          );
          assert.equal(
            calls.filter((x) => !x.path.endsWith('/op') && !x.path.endsWith('/frame.png')).length,
            0,
            'Visual proof allocated/refreshed session'
          );
          const row = await prisma.iPhoneOperation.findFirstOrThrow({
            where: { leaseId: f.leaseId, operation: 'setup.verify' },
            orderBy: { cursor: 'desc' },
          });
          const journal = openPhoneValue<Record<string, unknown>>(row.requestEncrypted);
          assert.ok(journal.portraitProof);
          const encoded = JSON.stringify({ response: response.data, journal });
          for (const forbidden of ['png_b64', 'data:image', PORTRAIT_OCR, 'iVBORw0'])
            assert.ok(!encoded.includes(forbidden));
          assert.equal(
            await prisma.toolUsage.count({ where: { operationKey: `iphone-setup:${row.id}` } }),
            0
          );
        },
      ] as Case
  ),
];

for (const fence of [
  'privacy',
  'epoch',
  'profile',
  'workflow',
  'firstRun',
  'deadline',
  'attention',
  'lease',
] as const) {
  portraitCases.push([
    `portrait ${fence} change during held frame cannot commit proof`,
    async (h) => {
      const f = await freshSetup(h);
      h.framePng = portraitFrame();
      h.observationResult = portraitOcr();
      await seedPortraitRoute(h, f);
      const evidence = await observe(h, f);
      const held = h.holdFrame();
      const requestKey = randomUUID();
      const pending = setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'portrait_lock',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: evidence.cursor,
        evidenceOperationIds: [evidence.id],
        requestKey,
      });
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            held.entered,
            pending.then(() => {
              throw new Error('Portrait returned before frame');
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Portrait frame did not begin')), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        if (fence === 'privacy') {
          const { rememberPrivate } = await import('../../providers/phoneInputPrivacy');
          await prisma.iPhoneDevice.update({
            where: { id: device.id },
            data: { privateInputEncrypted: rememberPrivate(null, 'synthetic-private-code') },
          });
        } else if (fence === 'epoch')
          await prisma.iPhoneDevice.update({
            where: { id: device.id },
            data: { providerEpoch: { increment: 1 } },
          });
        else if (fence === 'profile') {
          const { setupState, sealSetup } = await import('../../providers/phoneSetupState');
          const state = setupState(device.setupEncrypted);
          state.profileRevision++;
          await prisma.iPhoneDevice.update({
            where: { id: device.id },
            data: { setupEncrypted: sealSetup(state) },
          });
        } else if (fence === 'workflow')
          await prisma.agent.update({
            where: { id: f.agentId },
            data: { temporalWorkflowId: 'changed-workflow' },
          });
        else if (fence === 'firstRun')
          await prisma.agent.update({
            where: { id: f.agentId },
            data: { temporalFirstExecutionRunId: 'changed-run' },
          });
        else if (fence === 'deadline')
          await prisma.iPhoneOperation.updateMany({
            where: { leaseId: f.leaseId, requestKey },
            data: { deadlineAt: new Date(0) },
          });
        else if (fence === 'attention')
          await prisma.iPhoneLease.update({
            where: { id: f.leaseId },
            data: { controlOwner: 'user' },
          });
        else
          await prisma.iPhoneLease.update({
            where: { id: f.leaseId },
            data: { releaseRequestedAt: new Date() },
          });
      } finally {
        held.release();
        await pending.catch(() => undefined);
      }
      const result = await pending;
      assert.ok(result.status === 409 || result.data.operation?.status === 'FAILED');
      const { setupState } = await import('../../providers/phoneSetupState');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.notEqual(
        setupState(device.setupEncrypted).verification?.checks.portrait_lock?.status,
        'confirmed'
      );
    },
  ]);
}
portraitCases.push([
  'portrait capture fails before any provider read while private input is active',
  async (h) => {
    const f = await freshSetup(h);
    h.framePng = portraitFrame();
    h.observationResult = portraitOcr();
    await seedPortraitRoute(h, f);
    const evidence = await observe(h, f);
    const { rememberPrivate } = await import('../../providers/phoneInputPrivacy');
    await prisma.iPhoneDevice.update({
      where: { id: f.deviceId },
      data: { privateInputEncrypted: rememberPrivate(null, 'private-canary') },
    });
    const before = h.calls.length;
    const result = await setupPost(h, f, {
      action: 'verify',
      verificationTarget: 'portrait_lock',
      attemptId: f.setup.attemptId,
      expectedRevision: f.setup.revision,
      expectedCursor: evidence.cursor,
      evidenceOperationIds: [evidence.id],
      requestKey: randomUUID(),
    });
    assert.equal(result.status, 409);
    assert.equal(h.calls.length, before);
  },
]);
portraitCases.push([
  'portrait public setup rejects media URLs crop and attestation fields',
  async (h) => {
    const f = await freshSetup(h);
    const before = h.calls.length;
    for (const field of ['image', 'imageUrl', 'png_b64', 'crop', 'attestation']) {
      const result = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'portrait_lock',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: 0,
        evidenceOperationIds: ['untrusted'],
        requestKey: randomUUID(),
        [field]: 'caller-supplied',
      });
      assert.equal(result.status, 400);
    }
    assert.equal(h.calls.length, before);
  },
]);

for (const fence of ['action', 'attention', 'revision', 'phone', 'workflow', 'firstRun'] as const) {
  portraitCases.push([
    `portrait OFF hint disappears after ${fence} fence changes`,
    async (h) => {
      const f = await freshSetup(h);
      h.framePng = portraitFrame(false);
      h.observationResult = portraitOcr();
      await seedPortraitRoute(h, f);
      const evidence = await observe(h, f);
      const requestKey = randomUUID();
      const response = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'portrait_lock',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: evidence.cursor,
        evidenceOperationIds: [evidence.id],
        requestKey,
      });
      const op = response.data.operation as unknown as Record<string, unknown>;
      assert.deepEqual(op.portraitActionHint, {
        operation: 'input.tap',
        args: { x: 150, y: 529 },
        evidenceCursor: op.cursor,
      });
      if (fence === 'action')
        await prisma.iPhoneLease.update({
          where: { id: f.leaseId },
          data: { actionCursor: { increment: 1 } },
        });
      else if (fence === 'attention')
        await prisma.iPhoneLease.update({
          where: { id: f.leaseId },
          data: { controlOwner: 'user' },
        });
      else if (fence === 'phone')
        await prisma.user.update({
          where: { userId: f.userId },
          data: { phone: phoneFixtureNumber() },
        });
      else if (fence === 'workflow')
        await prisma.agent.update({
          where: { id: f.agentId },
          data: { temporalWorkflowId: 'new-workflow' },
        });
      else if (fence === 'firstRun')
        await prisma.agent.update({
          where: { id: f.agentId },
          data: { temporalFirstExecutionRunId: 'new-run' },
        });
      else {
        const { setupState, sealSetup } = await import('../../providers/phoneSetupState');
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        const state = setupState(device.setupEncrypted);
        state.claimRevision++;
        await prisma.iPhoneDevice.update({
          where: { id: device.id },
          data: { setupEncrypted: sealSetup(state) },
        });
      }
      const refreshed = await h.request(f.userId, `/leases/${f.leaseId}/operations/${requestKey}`);
      assert.equal(
        (refreshed.data.operation as unknown as Record<string, unknown> | undefined)
          ?.portraitActionHint,
        undefined
      );
    },
  ]);
}

portraitCases.push([
  'internal phone observation deadlines only shorten native defaults and reject invalid bounds',
  async () => {
    const { PhoneHarnessClient } = await import('../../providers/phoneHarness');
    const session: PhoneHarnessSession = {
      id: 'synthetic',
      state: 'ready',
      platform: 'ios',
      kind: 'device',
      closeRequested: false,
      cleanupComplete: false,
      requestKey: 'synthetic',
      expiresAt: Date.now() / 1000 + 600,
      control: {
        url: 'https://api.phone-harness.com/iphone/c/synthetic',
        token: 'synthetic',
        expiresAt: Date.now() / 1000 + 600,
      },
    };
    let calls = 0;
    const client = new PhoneHarnessClient({
      apiKey: 'synthetic',
      fetchImpl: async (input) => {
        calls++;
        return String(input).endsWith('/frame.png')
          ? new Response(portraitFrame(), { headers: { 'Content-Type': 'image/png' } })
          : new Response(JSON.stringify({ result: { text: PORTRAIT_OCR } }), {
              headers: { 'Content-Type': 'application/json' },
            });
      },
    });
    const original = globalThis.setTimeout;
    const timers: number[] = [];
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      timers.push(Number(ms));
      return original(fn, ms, ...args);
    }) as typeof setTimeout;
    try {
      await client.perform(session, 'screen.text', {});
      await client.frame(session);
      await client.perform(session, 'screen.text', {}, 7);
      await client.frame(session, 9);
    } finally {
      globalThis.setTimeout = original;
    }
    assert.equal(timers[0], 60000);
    assert.equal(timers[1], 60000);
    assert.ok(timers.includes(7) && timers.includes(9));
    const before = calls;
    for (const bound of [0, -1, 1.5, NaN, Infinity, 60001, true, '5']) {
      await assert.rejects(client.perform(session, 'screen.text', {}, bound as number));
      await assert.rejects(client.frame(session, bound as number));
    }
    assert.equal(calls, before);
    let aborted = false;
    const aborting = new PhoneHarnessClient({
      apiKey: 'synthetic',
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
          );
        }),
    });
    await assert.rejects(aborting.perform(session, 'screen.text', {}, 2));
    assert.ok(aborted);
  },
]);

portraitCases.push([
  'portrait native OCR requires bounded pixel rows and positive in-region anchors',
  async () => {
    for (const mutation of [
      { source: 'tree' },
      { confidence: NaN },
      { confidence: true },
      { confidence: -0.1 },
      { confidence: 1.1 },
      { x: -1 },
      { y: -1 },
      { w: 0 },
      { h: 0 },
      { x: 749 },
      { x: Infinity },
      { text: null },
      { x: 100 },
      { text: 'x'.repeat(32768) },
    ]) {
      const rows = portraitOcr();
      Object.assign(rows[0], mutation);
      assert.equal(provePortrait(portraitFrame(), rows, rows).status, 'unknown');
    }
    const focus = portraitOcr();
    focus[1].text = 'Personalized Focus';
    assert.equal(provePortrait(portraitFrame(), focus, focus).status, 'unknown');
    const extra = { text: 'Status', source: 'pixels', confidence: 1, x: 20, y: 50, w: 10, h: 10 };
    const limit = [...portraitOcr(), ...Array.from({ length: 124 }, () => ({ ...extra }))];
    assert.equal(provePortrait(portraitFrame(), limit, limit).status, 'confirmed');
    assert.equal(
      provePortrait(portraitFrame(), [...limit, extra], [...limit, extra]).status,
      'unknown'
    );
    assert.equal(provePortrait(portraitFrame(), portraitOcr(), focus).status, 'unknown');
  },
]);

portraitCases.push(...portraitRouteCases);
