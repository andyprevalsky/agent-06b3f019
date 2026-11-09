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

export const portraitRouteDigest = (events: PortraitRouteEvent[]) =>
  phoneCommandHash('portrait-causal-route-v1', events, 'agent');
export function provePortraitRoute(
  events: PortraitRouteEvent[],
  context: Context
): { digest: string; originalAssistiveTouch: AssistiveOriginal } | null {
  if (
    events.length === 0 ||
    events.length > 64 ||
    context.firstRun.length === 0 ||
    context.attemptId.length === 0 ||
    !Number.isSafeInteger(context.revision) ||
    context.revision < 0
  )
    return null;
  if (
    events.some(
      (e, i) =>
        !Number.isSafeInteger(e.cursor) ||
        e.cursor < 1 ||
        (i > 0 && e.cursor <= events[i - 1].cursor)
    )
  )
    return null;
  let prefix = -1;
  for (let i = 0; i < events.length; i++) if (events[i].operation === 'apps.launch') prefix = i;
  if (prefix < 0) return null;
  const route = events.slice(prefix);
  const first = route[0];
  if (
    Object.keys(first.args).length !== 1 ||
    first.args.name !== 'Settings' ||
    first.result !== 'Settings' ||
    !Number.isSafeInteger(first.revision)
  )
    return null;
  let revision = first.revision;
  let stage = 'root';
  let pending: ObservedTarget | null = null;
  let original: AssistiveOriginal | null = null;
  let body: TextRow | null = null;
  for (let i = 0; i < route.length; i++) {
    const e = route[i];
    if (
      e.attemptId !== context.attemptId ||
      e.revision !== revision ||
      (i > 0 && e.cursor !== route[i - 1].cursor + 1)
    )
      return null;
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
        return null;
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
        return null;
      revision++;
      stage = 'lock_tap';
      continue;
    }
    if (e.operation === 'input.text') {
      if (stage !== 'query' || Object.keys(e.args).length !== 1 || e.args.s !== 'AssistiveTouch')
        return null;
      stage = 'results';
      continue;
    }
    if (e.operation === 'input.tap') {
      if (stage === 'root_tap' && tap(e.args, pending)) stage = 'query';
      else if (stage === 'result_tap' && tap(e.args, pending)) stage = 'detail';
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
      else return null;
      pending = null;
      continue;
    }
    if (
      e.operation !== 'screen.text' ||
      Object.keys(e.args).some((k) => k !== 'min_confidence') ||
      (e.args.min_confidence !== undefined && e.args.min_confidence !== 0.3)
    )
      return null;
    const rows = portraitTextRows(e.result);
    if (rows === null) return null;
    if (stage === 'root' || stage === 'root_tap') {
      if (!rows.some((r) => normal(r.text) === 'Settings' && r.y < 250)) return null;
      pending = named(rows, 'Search');
      if (!pending) return null;
      stage = 'root_tap';
    } else if (stage === 'results' || stage === 'result_tap') {
      if (!rows.some((r) => r.text.includes('Accessibility') && r.text.includes('Touch')))
        return null;
      pending = named(rows, 'AssistiveTouch', (r) => r.y > 100 && r.y < 1100);
      if (!pending) return null;
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
      if (!detail(rows)) return null;
      body = named(rows, 'AssistiveTouch', (r) => r.y > 150 && r.y < 400);
      if (!body) return null;
      if (stage === 'detail') stage = 'back';
      else if (stage === 'detail_known') stage = original === 'off' ? 'toggle' : 'float';
      else if (stage === 'detail_enabled') stage = 'back_enabled';
      else if (stage === 'detail_final') stage = 'float';
    } else if (['touch', 'touch_tap', 'touch_enabled', 'touch_tap_enabled'].includes(stage)) {
      if (!rows.some((r) => normal(r.text) === 'Touch' && r.y < 150)) return null;
      pending = named(rows, 'AssistiveTouch', (r) => r.x < 450 && r.y > 150);
      if (!pending) return null;
      const values = rows.filter(
        (r) =>
          r.x > 500 &&
          Math.abs(r.y - pending!.y) <= 20 &&
          /^(On|Off)(?:\s*›)?$/.test(normal(r.text))
      );
      if (values.length !== 1) return null;
      const value = normal(values[0].text).startsWith('On') ? 'on' : 'off';
      if (stage === 'touch' || stage === 'touch_tap') {
        if (original !== null && original !== value) return null;
        original = value;
        stage = 'touch_tap';
      } else {
        if (value !== 'on') return null;
        stage = 'touch_tap_enabled';
      }
    } else if (stage === 'menu' || stage === 'menu_tap') {
      if (
        !named(rows, 'Device') ||
        !named(rows, 'Home') ||
        !named(rows, 'Custom') ||
        !named(rows, 'Gestures')
      )
        return null;
      pending = controlCenter(rows);
      if (!pending) return null;
      stage = 'menu_tap';
    } else if (stage === 'cc' || stage === 'cc_ready') {
      if (portraitControlCenterAnchors(e.result) === null) return null;
      stage = 'cc_ready';
    } else return null;
  }
  return stage === 'cc_ready' && original !== null && revision === context.revision
    ? { digest: portraitRouteDigest(route), originalAssistiveTouch: original }
    : null;
}
