/** Finite causal native-UI opening witness; not cryptographic foreground-app attestation. */
import { phoneCommandHash } from './phoneHarnessCredentials';
import { portraitTextRows, portraitControlCenterAnchors } from './phonePortraitProof';
export type AssistiveOriginal = 'on' | 'off';
export interface PortraitRouteEvent {
  cursor: number;
  operation: string;
  args: Record<string, unknown>;
  result: unknown;
  attemptId: string;
  revision: number;
  proof?: {
    routeDigest: string;
    originalAssistiveTouch: AssistiveOriginal;
    status: string;
    revisionAfter: number;
    firstRun?: string;
    profileRevision: number;
    capturedAt: string;
  };
}
interface Context {
  attemptId: string;
  revision: number;
  firstRun: string;
  profileRevision: number;
  now: number;
}
type TextRow = NonNullable<ReturnType<typeof portraitTextRows>>[number];
type ObservedTarget = TextRow & { alternate?: TextRow };
const normal = (s: string) => s.replace(/\s+/g, ' ').trim();
function named(rows: TextRow[], label: string, filter: (r: TextRow) => boolean = () => true) {
  const found = rows.filter((r) => normal(r.text) === label && filter(r));
  return found.length === 1 ? found[0] : null;
}
function detail(rows: TextRow[]) {
  return (
    rows.some((r) => normal(r.text) === 'AssistiveTouch' && r.y < 130) &&
    rows.some((r) => normal(r.text) === 'Customize Top Level Menu') &&
    rows.some((r) => normal(r.text) === 'Single-Tap')
  );
}
function tap(args: Record<string, unknown>, row: ObservedTarget | null) {
  return (
    row !== null &&
    Object.keys(args).length === 2 &&
    ((args.x === row.x && args.y === row.y) ||
      (row.alternate !== undefined && args.x === row.alternate.x && args.y === row.alternate.y))
  );
}
/** Inside the observed row's own box: re-focusing the same field, not a new target. */
function withinRow(args: Record<string, unknown>, row: TextRow | null) {
  return (
    row !== null &&
    Object.keys(args).length === 2 &&
    typeof args.x === 'number' &&
    typeof args.y === 'number' &&
    Math.abs(args.x - row.x) <= row.w / 2 &&
    Math.abs(args.y - row.y) <= row.h / 2
  );
}
function regionTap(args: Record<string, unknown>, x1: number, y1: number, x2: number, y2: number) {
  return (
    Object.keys(args).length === 2 &&
    typeof args.x === 'number' &&
    typeof args.y === 'number' &&
    Number.isFinite(args.x) &&
    Number.isFinite(args.y) &&
    args.x >= x1 &&
    args.x <= x2 &&
    args.y >= y1 &&
    args.y <= y2
  );
}
function controlCenter(rows: TextRow[]) {
  const direct = rows.filter((r) => normal(r.text) === 'Control Center');
  const controls = rows.filter((r) => normal(r.text) === 'Control');
  const centers = rows.filter((r) => normal(r.text) === 'Center');
  const pairs = controls.flatMap((a) =>
    centers
      .filter((b) => Math.abs(a.x - b.x) <= 20 && b.y > a.y && b.y - a.y <= 50)
      .map((b): ObservedTarget => ({ ...a, text: 'Control Center', alternate: b }))
  );
  const found = [...direct, ...pairs];
  return found.length === 1 ? found[0] : null;
}

/** Settings, by name, warm or cold (`fresh`); the provider reports its bundle ID. The root read still follows. */
function settingsLaunch(e: PortraitRouteEvent) {
  const keys = Object.keys(e.args);
  return (
    e.args.name === 'Settings' &&
    keys.every((k) => k === 'name' || (k === 'fresh' && typeof e.args.fresh === 'boolean')) &&
    (e.result === 'Settings' || e.result === 'com.apple.Preferences')
  );
}
/** Exactly the AssistiveTouch query, with only the documented typing-pace options. */
function assistiveQuery(args: Record<string, unknown>) {
  return (
    args.s === 'AssistiveTouch' &&
    Object.entries(args).every(
      ([k, v]) =>
        k === 's' ||
        (k === 'delay' && typeof v === 'number' && Number.isFinite(v) && v >= 0) ||
        (k === 'keystrokes' && typeof v === 'boolean')
    )
  );
}
export const portraitRouteDigest = (events: PortraitRouteEvent[]) =>
  phoneCommandHash('portrait-causal-route-v1', events, 'agent');
export type PortraitRouteBreak = { stage: string; cursor: number; operation: string; next: string };
const RESTART =
  'This setup.verify failed and is now part of the journal, so the route cannot be proven again without a new Settings launch: restart from a new Settings launch at the root and redo the whole route.';
/** The next native step each stage expects; returned to the agent when a route breaks. */
const NEXT_STEP: Record<string, string> = {
  launch: 'apps.launch Settings, then screen.text of the Settings root showing Search.',
  root: 'screen.text of the Settings root showing Search, then tap that observed Search.',
  root_tap: 'tap the observed Search.',
  query: 'input.text AssistiveTouch with keystrokes true into the focused search field.',
  results:
    'screen.text showing the AssistiveTouch result with its Accessibility → Touch breadcrumb; if the query did not register, type it with keystrokes true after a new Settings launch.',
  result_tap: 'tap the observed AssistiveTouch result.',
  detail: 'screen.text of the AssistiveTouch detail page.',
  back: 'tap the top-left back control to the Touch page.',
  touch: 'screen.text of Touch showing the AssistiveTouch On/Off value.',
  touch_tap: 'tap the observed AssistiveTouch row on Touch.',
  detail_known: 'screen.text of the AssistiveTouch detail page.',
  toggle: 'tap the AssistiveTouch switch at the right end of its row (x 500-720), not the label.',
  detail_enabled: 'screen.text of the AssistiveTouch detail page.',
  back_enabled: 'tap the top-left back control to the Touch page.',
  touch_enabled: 'screen.text of Touch showing AssistiveTouch On.',
  touch_tap_enabled: 'tap the observed AssistiveTouch row on Touch.',
  detail_final: 'screen.text of the AssistiveTouch detail page.',
  float:
    'tap the floating AssistiveTouch button. screen.text does not report this textless button; it normally rests against the right edge (x 625-750, y 400-1250). Tap that band away from observed row labels, then screen.text: the AssistiveTouch menu means it opened; an unchanged AssistiveTouch detail page means it missed, so try another band point, at most three in all, then keep portrait lock unconfirmed and report that blocker.',
  menu: 'screen.text of the AssistiveTouch menu.',
  menu_tap: 'tap the observed Control Center label.',
  cc: 'screen.text of Control Center, then setup.verify.',
  cc_ready: 'setup.verify immediately after the Control Center observation.',
  lock_tap: 'tap the returned portraitActionHint at its evidenceCursor.',
};
export function portraitRouteNext(stage: string) {
  return `${RESTART} The route broke at: ${NEXT_STEP[stage] ?? NEXT_STEP.launch}`;
}
/**
 * The valid journal prefix decides first: an earlier semantic break wins over a later invalid row
 * (failed, stale, foreign or a verify gap); otherwise the invalid row is reported at the stage the
 * prefix reached.
 */
export function portraitRouteBreakAt(
  events: PortraitRouteEvent[],
  context: Context,
  invalid: { cursor: number; operation: string } | undefined
): PortraitRouteBreak {
  const prefix = portraitRouteVerdict(events, context);
  const last = events.at(-1);
  if ('break' in prefix && last !== undefined && prefix.break.cursor < last.cursor)
    return prefix.break;
  const stage = 'break' in prefix ? prefix.break.stage : 'cc_ready';
  const at = invalid ?? last;
  return {
    stage,
    cursor: at?.cursor ?? 0,
    operation: at?.operation ?? 'none',
    next: portraitRouteNext(stage),
  };
}
export function provePortraitRoute(
  events: PortraitRouteEvent[],
  context: Context
): { digest: string; originalAssistiveTouch: AssistiveOriginal } | null {
  const verdict = portraitRouteVerdict(events, context);
  return 'proof' in verdict ? verdict.proof : null;
}
/** Same proof; a rejection names the first event that broke the route and the step it expected. */
export function portraitRouteVerdict(
  events: PortraitRouteEvent[],
  context: Context
):
  | { proof: { digest: string; originalAssistiveTouch: AssistiveOriginal } }
  | { break: PortraitRouteBreak } {
  let stage = 'launch';
  const reject = (e?: PortraitRouteEvent) => ({
    break: {
      stage,
      cursor: e?.cursor ?? events.at(-1)?.cursor ?? 0,
      operation: e?.operation ?? events.at(-1)?.operation ?? 'none',
      next: portraitRouteNext(stage),
    },
  });
  if (
    events.length === 0 ||
    events.length > 64 ||
    context.firstRun.length === 0 ||
    context.attemptId.length === 0 ||
    !Number.isSafeInteger(context.revision) ||
    context.revision < 0
  )
    return reject();
  if (
    events.some(
      (e, i) =>
        !Number.isSafeInteger(e.cursor) ||
        e.cursor < 1 ||
        (i > 0 && e.cursor <= events[i - 1].cursor)
    )
  )
    return reject();
  let prefix = -1;
  for (let i = 0; i < events.length; i++) if (events[i].operation === 'apps.launch') prefix = i;
  if (prefix < 0) return reject();
  const route = events.slice(prefix);
  const first = route[0];
  if (!settingsLaunch(first) || !Number.isSafeInteger(first.revision)) return reject(first);
  let revision = first.revision;
  stage = 'root';
  let pending: ObservedTarget | null = null;
  let search: TextRow | null = null;
  let original: AssistiveOriginal | null = null;
  let body: TextRow | null = null;
  for (let i = 0; i < route.length; i++) {
    const e = route[i];
    if (
      e.attemptId !== context.attemptId ||
      e.revision !== revision ||
      (i > 0 && e.cursor !== route[i - 1].cursor + 1)
    )
      return reject(e);
    if (i === 0) continue;
    if (e.operation === 'screen.bounds') {
      const b = e.result as Record<string, unknown> | null;
      if (
        Object.keys(e.args).length !== 0 ||
        !b ||
        b.x !== 0 ||
        b.y !== 0 ||
        b.w !== 750 ||
        b.h !== 1334
      )
        return reject(e);
      continue;
    }
    if (e.operation === 'setup.verify') {
      const p = e.proof;
      if (
        stage !== 'cc_ready' ||
        !p ||
        p.status !== 'disabled' ||
        p.routeDigest !== portraitRouteDigest(route.slice(0, i)) ||
        p.originalAssistiveTouch !== original ||
        p.firstRun !== context.firstRun ||
        p.profileRevision !== context.profileRevision ||
        p.revisionAfter !== revision + 1 ||
        !Number.isFinite(Date.parse(p.capturedAt)) ||
        context.now < Date.parse(p.capturedAt) ||
        context.now - Date.parse(p.capturedAt) > 30000
      )
        return reject(e);
      revision++;
      stage = 'lock_tap';
      continue;
    }
    if (e.operation === 'input.text') {
      if (stage !== 'query' || !assistiveQuery(e.args)) return reject(e);
      stage = 'results';
      continue;
    }
    if (e.operation === 'input.tap') {
      if (stage === 'root_tap' && tap(e.args, pending)) {
        search = pending;
        stage = 'query';
      } else if (stage === 'query' && withinRow(e.args, search)) {
        // Re-focusing the same observed Search field before typing.
      } else if (stage === 'result_tap' && tap(e.args, pending)) stage = 'detail';
      else if (
        (stage === 'back' || stage === 'back_enabled') &&
        regionTap(e.args, 30, 40, 120, 130)
      )
        stage = stage === 'back' ? 'touch' : 'touch_enabled';
      else if ((stage === 'touch_tap' || stage === 'touch_tap_enabled') && tap(e.args, pending))
        stage = stage === 'touch_tap' ? 'detail_known' : 'detail_final';
      else if (stage === 'toggle' && body && regionTap(e.args, 500, body.y - 20, 720, body.y + 20))
        stage = 'detail_enabled';
      else if (stage === 'float' && regionTap(e.args, 625, 400, 750, 1250)) stage = 'menu';
      else if (stage === 'menu_tap' && tap(e.args, pending)) stage = 'cc';
      else if (
        stage === 'lock_tap' &&
        Object.keys(e.args).length === 2 &&
        e.args.x === 150 &&
        e.args.y === 529
      )
        stage = 'cc';
      else return reject(e);
      pending = null;
      continue;
    }
    if (
      e.operation !== 'screen.text' ||
      Object.keys(e.args).some((k) => k !== 'min_confidence') ||
      (e.args.min_confidence !== undefined &&
        (typeof e.args.min_confidence !== 'number' ||
          !(e.args.min_confidence >= 0 && e.args.min_confidence <= 1)))
    )
      return reject(e);
    const rows = portraitTextRows(e.result);
    if (rows === null) return reject(e);
    if (stage === 'query') continue; // Read-only look at the focused search field before typing.
    if (stage === 'root' || stage === 'root_tap') {
      if (!rows.some((r) => normal(r.text) === 'Settings' && r.y < 250)) return reject(e);
      pending = named(rows, 'Search');
      if (!pending) return reject(e);
      stage = 'root_tap';
    } else if (stage === 'results' || stage === 'result_tap') {
      if (!rows.some((r) => r.text.includes('Accessibility') && r.text.includes('Touch')))
        return reject(e);
      pending = named(rows, 'AssistiveTouch', (r) => r.y > 100 && r.y < 1100);
      if (!pending) return reject(e);
      stage = 'result_tap';
    } else if (
      [
        'detail',
        'back',
        'detail_known',
        'toggle',
        'detail_enabled',
        'back_enabled',
        'detail_final',
        'float',
      ].includes(stage)
    ) {
      if (!detail(rows)) return reject(e);
      body = named(rows, 'AssistiveTouch', (r) => r.y > 150 && r.y < 400);
      if (!body) return reject(e);
      if (stage === 'detail') stage = 'back';
      else if (stage === 'detail_known') stage = original === 'off' ? 'toggle' : 'float';
      else if (stage === 'detail_enabled') stage = 'back_enabled';
      else if (stage === 'detail_final') stage = 'float';
    } else if (['touch', 'touch_tap', 'touch_enabled', 'touch_tap_enabled'].includes(stage)) {
      if (!rows.some((r) => normal(r.text) === 'Touch' && r.y < 150)) return reject(e);
      pending = named(rows, 'AssistiveTouch', (r) => r.x < 450 && r.y > 150);
      if (!pending) return reject(e);
      const values = rows.filter(
        (r) =>
          r.x > 500 &&
          Math.abs(r.y - pending!.y) <= 20 &&
          /^(On|Off)(?:\s*[›>])?$/.test(normal(r.text))
      );
      if (values.length !== 1) return reject(e);
      const value = normal(values[0].text).startsWith('On') ? 'on' : 'off';
      if (stage === 'touch' || stage === 'touch_tap') {
        if (original !== null && original !== value) return reject(e);
        original = value;
        stage = 'touch_tap';
      } else {
        if (value !== 'on') return reject(e);
        stage = 'touch_tap_enabled';
      }
    } else if (stage === 'menu' || stage === 'menu_tap') {
      const menu =
        named(rows, 'Device') &&
        named(rows, 'Home') &&
        named(rows, 'Custom') &&
        named(rows, 'Gestures');
      if (!menu && stage === 'menu' && detail(rows)) {
        // The right-edge probe missed the textless floating button and left the detail page.
        body = named(rows, 'AssistiveTouch', (r) => r.y > 150 && r.y < 400);
        if (!body) return reject(e);
        stage = 'float';
        continue;
      }
      if (!menu) return reject(e);
      pending = controlCenter(rows);
      if (!pending) return reject(e);
      stage = 'menu_tap';
    } else if (stage === 'cc' || stage === 'cc_ready') {
      if (portraitControlCenterAnchors(e.result) === null) return reject(e);
      stage = 'cc_ready';
    } else return reject(e);
  }
  return stage === 'cc_ready' && original !== null && revision === context.revision
    ? { proof: { digest: portraitRouteDigest(route), originalAssistiveTouch: original } }
    : reject(route.at(-1));
}
