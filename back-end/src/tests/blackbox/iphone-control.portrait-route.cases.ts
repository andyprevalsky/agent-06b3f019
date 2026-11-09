import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { provePortraitRoute } from '../../providers/phonePortraitRoute';
import { portraitRouteEvents, seedPortraitRoute } from './iphone-portrait-route.fixture';
import { portraitFrame, portraitOcr } from './iphone-portrait.fixture';
import { freshSetup, observe, setupPost, type SetupDto } from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const portraitRouteCases: Case[] = [];
portraitRouteCases.push([
  'portrait route rejects static Photos/web replicas and every missing or unrelated causal step',
  async () => {
    const context = {
      attemptId: 'attempt',
      revision: 1,
      firstRun: 'firstRun',
      profileRevision: 1,
      now: Date.now(),
    };
    for (const original of ['on', 'off'] as const)
      assert.equal(
        provePortraitRoute(portraitRouteEvents(original), context)?.originalAssistiveTouch,
        original
      );
    const split = structuredClone(portraitRouteEvents());
    const menu = split[split.length - 3].result as Array<{
      text: string;
      x: number;
      y: number;
      w: number;
      h: number;
      source: string;
      confidence: number;
    }>;
    menu.pop();
    menu.push(
      { text: 'Control', x: 540, y: 1054, w: 130, h: 28, source: 'pixels', confidence: 1 },
      { text: 'Center', x: 540, y: 1086, w: 100, h: 28, source: 'pixels', confidence: 1 }
    );
    split[split.length - 2].args = { x: 540, y: 1054 };
    assert.ok(provePortraitRoute(split, context));
    split[split.length - 2].args = { x: 540, y: 1086 };
    assert.ok(provePortraitRoute(split, context));
    split[split.length - 2].args = { x: 540, y: 1070 };
    assert.equal(provePortraitRoute(split, context), null, 'Unobserved invented midpoint accepted');
    const firstRoute = portraitRouteEvents();
    const restarted = [
      ...firstRoute,
      ...portraitRouteEvents().map((e) => ({ ...e, cursor: e.cursor + firstRoute.length })),
    ];
    assert.ok(
      provePortraitRoute(restarted, context),
      'Legitimate increasing-cursor Settings restart rejected'
    );
    const checks: Array<(events: ReturnType<typeof portraitRouteEvents>) => void> = [
      (e) => {
        e.splice(0, e.length - 1);
      },
      (e) => {
        e[0].args = { name: 'Photos' };
        e[0].result = 'Photos';
      },
      (e) => {
        e[0].args = { name: 'Safari' };
      },
      (e) => {
        e[0].result = true;
      },
      (e) => {
        e.splice(2, 1);
      },
      (e) => {
        e[3].args = { s: 'https://untrusted.invalid' };
      },
      (e) => {
        e[5].args = { x: 1, y: 1 };
      },
      (e) => {
        e[1].attemptId = 'foreign';
      },
      (e) => {
        e[1].revision = 9;
      },
      (e) => {
        e[2].cursor = 99;
      },
      (e) => {
        e[2].operation = 'nav.home';
      },
      (e) => {
        e[2].operation = 'input.keys';
        e[2].args = { combo: 'cmd+3' };
      },
      (e) => {
        e[e.length - 2].args = { x: 1, y: 1 };
      },
      (e) => {
        e[e.length - 1].result = [];
      },
      (e) => {
        const menu = e[e.length - 3].result as Array<Record<string, unknown>>;
        menu.push({ ...menu[menu.length - 1] });
      },
      (e) => {
        const row = e.find(
          (x) =>
            x.operation === 'screen.text' &&
            Array.isArray(x.result) &&
            (x.result as Array<{ text: string }>).some((r) => r.text === 'Off ›')
        );
        assert.ok(row);
        (row.result as Array<{ text: string }>).find((r) => r.text === 'Off ›')!.text = 'Unknown';
      },
    ];
    for (const change of checks) {
      const route = structuredClone(portraitRouteEvents());
      change(route);
      assert.equal(provePortraitRoute(route, context), null);
    }
    assert.equal(
      provePortraitRoute(
        [...portraitRouteEvents(), ...portraitRouteEvents(), ...portraitRouteEvents()],
        context
      ),
      null
    );
  },
]);
for (const app of ['Photos', 'Safari'] as const)
  portraitRouteCases.push([
    `matching ControlCenter pixels in ${app} without native route never grant portrait`,
    async (h) => {
      const f = await freshSetup(h);
      h.launchResult = app;
      h.framePng = portraitFrame();
      h.observationResult = portraitOcr();
      const launch = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'apps.launch',
          args: { name: app },
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      assert.equal(launch.data.operation?.status, 'SUCCEEDED');
      const evidence = await observe(h, f),
        before = h.calls.length;
      const result = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'portrait_lock',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: evidence.cursor,
        evidenceOperationIds: [evidence.id],
        requestKey: randomUUID(),
      });
      assert.equal(result.data.operation?.status, 'FAILED');
      assert.equal(h.calls.length, before, 'Missing native route crossed into private capture');
      const check = (
        result.data.setup as { verification: { checks: { portrait_lock: { status: string } } } }
      ).verification.checks.portrait_lock;
      assert.equal(check.status, 'unknown');
      assert.equal(
        (result.data.operation as unknown as Record<string, unknown>).portraitActionHint,
        undefined
      );
    },
  ]);
portraitRouteCases.push([
  'portrait OFF hint tap requires fresh native On proof without replaying cached On',
  async (h) => {
    const f = await freshSetup(h);
    h.framePng = portraitFrame(false);
    h.observationResult = portraitOcr();
    await seedPortraitRoute(h, f);
    const first = await observe(h, f);
    const off = await setupPost(h, f, {
      action: 'verify',
      verificationTarget: 'portrait_lock',
      attemptId: f.setup.attemptId,
      expectedRevision: f.setup.revision,
      expectedCursor: first.cursor,
      evidenceOperationIds: [first.id],
      requestKey: randomUUID(),
    });
    assert.equal(off.data.operation?.status, 'SUCCEEDED');
    f.setup = off.data.setup as SetupDto;
    const op = off.data.operation as unknown as {
      cursor: number;
      portraitActionHint: {
        operation: string;
        args: Record<string, unknown>;
        evidenceCursor: number;
      };
    };
    assert.ok(op.portraitActionHint);
    const tap = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
      method: 'POST',
      body: {
        operationId: randomUUID(),
        operation: op.portraitActionHint.operation,
        args: op.portraitActionHint.args,
        expectedCursor: op.portraitActionHint.evidenceCursor,
        setupAttemptId: f.setup.attemptId,
        setupRevision: f.setup.revision,
      },
    });
    assert.equal(tap.data.operation?.status, 'SUCCEEDED');
    h.framePng = portraitFrame();
    const latest = await observe(h, f);
    const on = await setupPost(h, f, {
      action: 'verify',
      verificationTarget: 'portrait_lock',
      attemptId: f.setup.attemptId,
      expectedRevision: f.setup.revision,
      expectedCursor: latest.cursor,
      evidenceOperationIds: [latest.id],
      requestKey: randomUUID(),
    });
    assert.equal(on.data.operation?.status, 'SUCCEEDED');
    assert.equal(
      (on.data.setup as { verification: { checks: { portrait_lock: { status: string } } } })
        .verification.checks.portrait_lock.status,
      'confirmed'
    );
    assert.equal(
      (on.data.operation as unknown as Record<string, unknown>).portraitActionHint,
      undefined
    );
  },
]);
