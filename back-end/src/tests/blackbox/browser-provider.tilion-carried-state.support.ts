/** rotate-proxy / resume carry no request state; a live uncarried Tilion swap is a typed 409. */
import nodeAssert from 'node:assert/strict';
import type { Response } from 'express';
import { TilionUncarriedStateError } from '../../providers/browser/tilion';
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

/**
 * rotate-proxy and resume take no request-level browser state (the worker
 * rotates via /recover-challenge, and resume runs before it attaches); a live
 * Tilion swap without state fails closed as a typed 409, never a 500.
 */
export async function assertTilionCarriedStateReachesReplacementsAndNever500s(): Promise<void> {
  const taskId = '00000000-0000-4000-8000-000000000001';
  const storage_state = { cookies: [], origins: [] };
  const rotate = rotateProxySchema.parse({ task_id: taskId, storage_state });
  const resume = resumeSessionSchema.parse({ task_id: taskId, storage_state });
  nodeAssert.equal('storage_state' in rotate, false, 'rotate-proxy must not accept storage_state');
  nodeAssert.equal('storage_state' in resume, false, 'resume must not accept storage_state');

  const { res, sent } = fakeResponse();
  nodeAssert.equal(
    respondIfCarriedStateRequired(new TilionUncarriedStateError(taskId, 'sess_live'), res),
    true
  );
  nodeAssert.equal(sent.status, 409);
  nodeAssert.equal((sent.body as { error?: string }).error, 'carried_state_required');
  nodeAssert.equal(respondIfCarriedStateRequired(new Error('other'), fakeResponse().res), false);
}
