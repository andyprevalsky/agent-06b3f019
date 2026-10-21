/** Worker-carried Tilion state on rotate-proxy / resume (single CDP client); never a 500. */
import nodeAssert from 'node:assert/strict';
import type { Response } from 'express';
import { TilionUncarriedStateError } from '../../providers/browser/tilion';
import { carriedStateFromRequest } from '../../domains/browser-session/service.carried-state';
import { respondIfCarriedStateRequired } from '../../domains/browser-session/routes.carried-state';
import { resumeSessionSchema, rotateProxySchema } from '../../domains/browser-session/types';

function fakeResponse() {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(value: unknown) {
      sent.body = value;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

/** rotate-proxy and resume carry the worker's storage_state; an uncarried live Tilion swap is a 409. */
export async function assertTilionCarriedStateReachesReplacementsAndNever500s(): Promise<void> {
  const taskId = '00000000-0000-4000-8000-000000000001';
  const storage_state = {
    cookies: [{ name: 'sid', value: 'v', domain: '.example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };
  const rotate = rotateProxySchema.parse({ task_id: taskId, storage_state });
  const resume = resumeSessionSchema.parse({ task_id: taskId, storage_state });
  nodeAssert.deepEqual(carriedStateFromRequest(rotate.storage_state).carriedState, storage_state);
  nodeAssert.deepEqual(carriedStateFromRequest(resume.storage_state).carriedState, storage_state);
  // Old clients (no state) still parse and carry nothing.
  nodeAssert.deepEqual(
    carriedStateFromRequest(rotateProxySchema.parse({ task_id: taskId }).storage_state),
    {}
  );
  nodeAssert.throws(() =>
    rotateProxySchema.parse({ task_id: taskId, storage_state: { cookies: 'x' } })
  );

  const { res, sent } = fakeResponse();
  nodeAssert.equal(
    respondIfCarriedStateRequired(new TilionUncarriedStateError(taskId, 'sess_live'), res),
    true
  );
  nodeAssert.equal(sent.status, 409);
  nodeAssert.equal((sent.body as { error?: string }).error, 'carried_state_required');
  nodeAssert.equal(respondIfCarriedStateRequired(new Error('other'), fakeResponse().res), false);
}
