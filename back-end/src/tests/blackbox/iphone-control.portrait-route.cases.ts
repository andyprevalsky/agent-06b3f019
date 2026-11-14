import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import {
  portraitRouteBreakAt,
  portraitRouteVerdict,
  provePortraitRoute,
} from '../../providers/phonePortraitRoute';
import {
  portraitRouteCommands,
  portraitRouteEvents,
  seedPortraitCommands,
  seedPortraitRoute,
  unchangedSearchRows,
} from './iphone-portrait-route.fixture';
import { livePortraitOcr, portraitFrame, portraitOcr } from './iphone-portrait.fixture';
import {
  PROD_20261113_FLOAT_TAP,
  PROD_20261113_LEASE1_ROUTE,
  PROD_20261113_LEASE2_ROUTE,
  PROD_20261113_MENU_ROWS,
} from './iphone-portrait-route.prod-20261113.fixture';
import { portraitControlCenterAnchors } from '../../providers/phonePortraitProof';
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
    for (const original of ['on', 'off'] as const)
      assert.equal(
        provePortraitRoute(portraitRouteEvents(original, 'production'), context)
          ?.originalAssistiveTouch,
        original,
        'Documented production launch/text shapes rejected'
      );
    for (const original of ['on', 'off'] as const)
      assert.equal(
        provePortraitRoute(portraitRouteEvents(original, 'production-cold'), context)
          ?.originalAssistiveTouch,
        original,
        'Cold Settings relaunch (fresh: true) rejected'
      );
    const production = portraitRouteEvents('off', 'production');
    for (const change of [
      (e: typeof production) => (e[0].args = { name: 'Settings', fresh: 'yes' }),
      (e: typeof production) => (e[0].args = { name: 'Settings', fresh: false, url: 'x' }),
      (e: typeof production) => (e[0].result = 'com.apple.mobileslideshow'),
      (e: typeof production) => (e[4].args = { s: 'AssistiveTouch', delay: 'x' }),
      (e: typeof production) => (e[4].args = { s: 'AssistiveTouch', submit: true }),
    ]) {
      const route = structuredClone(production);
      change(route);
      assert.equal(provePortraitRoute(route, context), null, 'Production shape accepted mutation');
    }
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
      assert.equal(
        result.data.operation?.errorCode,
        'phone_portrait_route_unproven',
        'Unproven native route was reported as a generic verifier outage'
      );
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
for (const [original, shape] of [
  ['on', 'production'],
  ['off', 'production'],
  ['off', 'production-cold'],
] as const)
  portraitRouteCases.push([
    `portrait verify proves the ${shape}-shaped native route (original ${original})`,
    async (h) => {
      const f = await freshSetup(h);
      h.framePng = portraitFrame(original === 'on');
      h.observationResult = portraitOcr();
      await seedPortraitRoute(h, f, original, shape);
      const evidence = await observe(h, f);
      const result = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'portrait_lock',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: evidence.cursor,
        evidenceOperationIds: [evidence.id],
        requestKey: randomUUID(),
      });
      assert.equal(result.data.operation?.errorCode, null);
      assert.equal(result.data.operation?.status, 'SUCCEEDED');
      assert.equal(
        (result.data.setup as { verification: { checks: { portrait_lock: { status: string } } } })
          .verification.checks.portrait_lock.status,
        original === 'on' ? 'confirmed' : 'disabled'
      );
    },
  ]);

type RouteBreak = { stage: string; cursor: number; operation: string; next: string };
const routeBreakCases: Array<
  [string, (c: ReturnType<typeof portraitRouteCommands>) => void, string, RegExp]
> = [
  [
    'a lost AssistiveTouch query (search field unchanged after typing)',
    (c) => {
      const typed = c.findIndex((e) => e.operation === 'input.text');
      c.splice(typed + 1, c.length, {
        operation: 'screen.text',
        args: { min_confidence: 0.3 },
        result: unchangedSearchRows(),
      });
    },
    'results',
    /keystrokes.*true/,
  ],
  [
    'an AssistiveTouch label tap where the switch was required',
    (c) => {
      const toggle = c.findIndex((e) => e.operation === 'input.tap' && e.args.x === 645);
      c.splice(toggle, c.length, {
        operation: 'input.tap',
        args: { x: 177, y: 271 },
        result: true,
      });
    },
    'toggle',
    /switch/,
  ],
];
for (const [label, deviate, stage, next] of routeBreakCases)
  portraitRouteCases.push([
    `portrait verify names the exact route break for ${label}`,
    async (h) => {
      const f = await freshSetup(h);
      h.framePng = portraitFrame(false);
      h.observationResult = portraitOcr();
      const commands = portraitRouteCommands('off', 'production-cold');
      deviate(commands);
      await seedPortraitCommands(h, f, commands);
      const evidence = await observe(h, f);
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
      assert.equal(result.data.operation?.status, 'FAILED');
      assert.equal(result.data.operation?.errorCode, 'phone_portrait_route_unproven');
      assert.equal(h.calls.length, before, 'Unproven route crossed into private capture');
      const routeBreak = (result.data.operation?.result as { portraitRoute?: RouteBreak } | null)
        ?.portraitRoute;
      assert.ok(routeBreak, 'Unproven route did not name where it broke');
      assert.equal(routeBreak.stage, stage);
      assert.ok(Number.isSafeInteger(routeBreak.cursor) && routeBreak.cursor > 0);
      assert.match(routeBreak.next, next);
      assert.match(routeBreak.next, /new Settings launch/);
    },
  ]);
portraitRouteCases.push([
  'portrait route break names the breaking event, keeping an earlier break over a later invalid row',
  async () => {
    const context = {
      attemptId: 'attempt',
      revision: 1,
      firstRun: 'firstRun',
      profileRevision: 1,
      now: Date.now(),
    };
    const badLaunch = structuredClone(portraitRouteEvents('off', 'production'));
    badLaunch[0].result = 'com.apple.mobileslideshow';
    const launchVerdict = portraitRouteVerdict(badLaunch, context);
    assert.ok('break' in launchVerdict);
    assert.equal(launchVerdict.break.cursor, badLaunch[0].cursor, 'Invalid launch not named');
    assert.equal(launchVerdict.break.operation, 'apps.launch');

    const lost = structuredClone(portraitRouteEvents('off', 'production'));
    const typed = lost.findIndex((e) => e.operation === 'input.text');
    lost[typed + 1].result = unchangedSearchRows();
    const prefix = lost.slice(0, typed + 4);
    const later = { cursor: prefix.at(-1)!.cursor + 1, operation: 'input.tap' };
    const kept = portraitRouteBreakAt(prefix, context, later);
    assert.equal(kept.stage, 'results', 'Later invalid row hid the earlier semantic break');
    assert.equal(kept.cursor, lost[typed + 1].cursor);

    const valid = portraitRouteEvents('off', 'production').slice(0, typed + 2);
    const reached = portraitRouteBreakAt(valid, context, later);
    assert.equal(reached.cursor, later.cursor, 'Invalid row not reported after a valid prefix');
    assert.equal(reached.stage, 'result_tap');
  },
]);
portraitRouteCases.push([
  'portrait Control Center anchors accept the live OCR hyphenation glyph and still reject other text',
  async () => {
    for (const glyph of ['-', '~'] as const)
      assert.equal(
        portraitControlCenterAnchors(livePortraitOcr(glyph)),
        'Not Playing;Reduce Interruptions',
        `Live Control Center OCR with '${glyph}' rejected`
      );
    const letter = livePortraitOcr().map((r) =>
      r.text.startsWith('Interrup') ? { ...r, text: 'Interrup- X' } : r
    );
    assert.equal(portraitControlCenterAnchors(letter), null, 'A letter was joined as hyphenation');
    const flood = livePortraitOcr().map((r) =>
      r.text.startsWith('Interrup') ? { ...r, text: 'Interrup' + '-'.repeat(30000) } : r
    );
    const started = performance.now();
    assert.equal(portraitControlCenterAnchors(flood), null);
    assert.ok(performance.now() - started < 250, 'Hyphen run cleanup is not bounded');
    assert.equal(
      portraitControlCenterAnchors(livePortraitOcr().filter((r) => r.text !== 'tions')),
      null
    );
    const context = {
      attemptId: 'attempt',
      revision: 1,
      firstRun: 'firstRun',
      profileRevision: 1,
      now: Date.now(),
    };
    const route = portraitRouteEvents('on', 'production-cold');
    route[route.length - 1].result = livePortraitOcr();
    assert.ok(provePortraitRoute(route, context), 'Live Control Center read broke the route');
  },
]);
portraitRouteCases.push([
  'portrait verify proves a route ending on the live Control Center OCR',
  async (h) => {
    const f = await freshSetup(h);
    h.framePng = portraitFrame(true);
    h.observationResult = livePortraitOcr();
    const commands = portraitRouteCommands('on', 'production-cold');
    commands[commands.length - 1].result = livePortraitOcr();
    await seedPortraitCommands(h, f, commands);
    h.observationResult = livePortraitOcr('~');
    const evidence = await observe(h, f);
    h.observationResult = livePortraitOcr();
    const result = await setupPost(h, f, {
      action: 'verify',
      verificationTarget: 'portrait_lock',
      attemptId: f.setup.attemptId,
      expectedRevision: f.setup.revision,
      expectedCursor: evidence.cursor,
      evidenceOperationIds: [evidence.id],
      requestKey: randomUUID(),
    });
    assert.equal(result.data.operation?.errorCode, null);
    assert.equal(result.data.operation?.status, 'SUCCEEDED');
    assert.equal(
      (result.data.setup as { verification: { checks: { portrait_lock: { status: string } } } })
        .verification.checks.portrait_lock.status,
      'confirmed'
    );
  },
]);
portraitRouteCases.push([
  'portrait route accepts benign refocus, reads and floating-button probes from the 2026-11-13 production journal',
  async () => {
    const context = {
      attemptId: 'attempt',
      revision: 1,
      firstRun: 'firstRun',
      profileRevision: 1,
      now: Date.now(),
    };
    const stamp = (raw: typeof PROD_20261113_LEASE1_ROUTE) =>
      raw.map((e, i) => ({
        ...structuredClone(e),
        cursor: i + 1,
        attemptId: 'attempt',
        revision: 1,
      }));
    const stage = (events: ReturnType<typeof stamp>) => {
      const verdict = portraitRouteVerdict(events, context);
      return 'break' in verdict ? `${verdict.break.stage}@${verdict.break.cursor}` : 'proof';
    };
    // Lease 2 (cursors 19-31): the first read after tapping Search showed the field still
    // unfocused (no keyboard), so the agent re-tapped that observed field before typing.
    const lease2 = stamp(PROD_20261113_LEASE2_ROUTE);
    assert.equal(stage(lease2), `float@${lease2.length}`, 'Refocusing the observed Search broke');
    // A tap outside the observed Search field is still a deviation.
    const outside = structuredClone(lease2);
    outside[4].args = { x: 320, y: 1230 };
    assert.equal(stage(outside), 'query@5', 'A tap outside the observed Search was accepted');
    // Lease 1 (cursors 5-16) reached the detail page with AssistiveTouch already On. The
    // floating button is textless, so screen.text never reports it: a right-edge probe that
    // leaves the detail page unchanged is benign; the real tap at (686, 746) then opens the menu.
    const detailRead = PROD_20261113_LEASE1_ROUTE.at(-1)!;
    const tap = (x: number, y: number) => ({
      cursor: 0,
      operation: 'input.tap',
      args: { x, y },
      result: true,
    });
    const read = (result: unknown) => ({
      cursor: 0,
      operation: 'screen.text',
      args: { min_confidence: 0.3 },
      result,
    });
    const lockOn = stamp([
      ...PROD_20261113_LEASE1_ROUTE,
      tap(686, 450),
      read(detailRead.result),
      tap(PROD_20261113_FLOAT_TAP.x, PROD_20261113_FLOAT_TAP.y),
      read(PROD_20261113_MENU_ROWS),
      tap(542, 891),
      read(livePortraitOcr()),
    ]);
    assert.equal(stage(lockOn), 'proof', 'A benign floating-button probe broke the route');
    assert.equal(provePortraitRoute(lockOn, context)?.originalAssistiveTouch, 'on');
    // Any in-range confidence read is read-only (the agent's real 0.1 re-read); malformed is not.
    const n = PROD_20261113_LEASE1_ROUTE.length;
    const lowRead = (min_confidence: unknown) =>
      stamp([
        ...PROD_20261113_LEASE1_ROUTE,
        { ...detailRead, args: { min_confidence } },
        ...lockOn.slice(n).map(({ operation, args, result }) => ({
          cursor: 0,
          operation,
          args,
          result,
        })),
      ]);
    assert.equal(stage(lowRead(0.1)), 'proof', 'A min_confidence 0.1 read broke the route');
    assert.equal(stage(lowRead(0)), 'proof', 'A min_confidence 0 read broke the route');
    assert.equal(stage(lowRead('x')), `float@${n + 1}`, 'A malformed min_confidence was accepted');
    assert.equal(
      stage(lowRead(2)),
      `float@${n + 1}`,
      'An out-of-range min_confidence was accepted'
    );
    // A probe that navigated away from the detail page is still a route break.
    const navigated = structuredClone(lockOn);
    navigated[n + 1].result = PROD_20261113_LEASE2_ROUTE[2].result;
    assert.equal(stage(navigated), `menu@${n + 2}`);
    // A float-stage tap outside the right-edge band is still rejected.
    const band = structuredClone(lockOn);
    band[n].args = { x: 400, y: 450 };
    assert.equal(stage(band), `float@${n + 1}`);
    // The returned float step names the probe rule instead of an unobservable target.
    const floatBreak = portraitRouteVerdict(stamp(PROD_20261113_LEASE1_ROUTE), context);
    assert.ok('break' in floatBreak);
    assert.match(floatBreak.break.next, /screen\.text does not report/);
  },
]);
