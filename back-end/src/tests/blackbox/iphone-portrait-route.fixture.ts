/** Synthetic interactive native UI, driven through normal command admission in API cases. */
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import type { Harness } from './iphone-control.fixtures';
import type { SetupFixture } from './iphone-control.setup-fixtures';
import { portraitOcr } from './iphone-portrait.fixture';
import type { AssistiveOriginal, PortraitRouteEvent } from '../../providers/phonePortraitRoute';
const text = (label: string, x: number, y: number, w = 160, h = 28) => ({
  text: label,
  x,
  y,
  w,
  h,
  source: 'pixels',
  confidence: 1,
});
export const touchRows = (on = false) => [
  text('Touch', 375, 84, 98.4, 29.6),
  text('AssistiveTouch', 177, 236, 226, 28),
  text(on ? 'On ›' : 'Off ›', 645, 236, 86, 28),
];
const detailRows = () => [
  text('AssistiveTouch', 375, 84, 260),
  text('AssistiveTouch', 220, 270, 300),
  text('Customize Top Level Menu', 330, 580, 500),
  text('Single-Tap', 177, 772),
];
export function portraitRouteCommands(original: AssistiveOriginal = 'off') {
  const events: { operation: string; args: Record<string, unknown>; result: unknown }[] = [];
  const op = (operation: string, args: Record<string, unknown>, result: unknown) =>
    events.push({ operation, args, result });
  const read = (result: unknown) => op('screen.text', {}, result);
  const tap = (x: number, y: number) => op('input.tap', { x, y }, true);
  op('apps.launch', { name: 'Settings' }, 'Settings');
  read([text('Settings', 375, 84, 150), text('Search', 250, 1230, 300)]);
  tap(250, 1230);
  op('input.text', { s: 'AssistiveTouch' }, true);
  read([
    text('AssistiveTouch', 250, 160, 226),
    text('Accessibility → Touch → AssistiveTouch', 400, 207, 600),
    text('AssistiveTouch', 300, 1230, 300),
  ]);
  tap(250, 160);
  read(detailRows());
  tap(75, 84);
  read(touchRows(original === 'on'));
  tap(177, 236);
  read(detailRows());
  if (original === 'off') {
    tap(645, 270);
    read(detailRows());
    tap(75, 84);
    read(touchRows(true));
    tap(177, 236);
    read(detailRows());
  }
  tap(680, 1000);
  read([
    text('Notification Center', 375, 770, 200, 56),
    text('Custom', 210, 870),
    text('Device', 540, 870),
    text('Gestures', 210, 1055),
    text('Home', 375, 1125),
    text('Control Center', 540, 1070, 160, 56),
  ]);
  tap(540, 1070);
  read(portraitOcr());
  return events;
}
export function portraitRouteEvents(original: AssistiveOriginal = 'off'): PortraitRouteEvent[] {
  return portraitRouteCommands(original).map((e, i) => ({
    ...e,
    cursor: i + 1,
    attemptId: 'attempt',
    revision: 1,
  }));
}
export async function seedPortraitRoute(
  h: Harness,
  f: SetupFixture,
  original: AssistiveOriginal = 'off'
) {
  const oldLaunch = h.launchResult,
    oldObservation = h.observationResult;
  try {
    for (const e of portraitRouteCommands(original)) {
      if (e.operation === 'apps.launch') h.launchResult = e.result;
      if (e.operation === 'screen.text') h.observationResult = e.result;
      const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: e.operation,
          args: e.args,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      assert.equal(response.status, 200, `Native route ${e.operation} route status`);
      assert.equal(
        response.data.operation?.status,
        'SUCCEEDED',
        `Native route ${e.operation} command status`
      );
    }
  } finally {
    h.launchResult = oldLaunch;
    h.observationResult = oldObservation;
  }
}
