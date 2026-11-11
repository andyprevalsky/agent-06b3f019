import { performance } from 'node:perf_hooks';
/** One internal read-only native capture, held by the ordinary setup.verify journal. */
import type { SetupInput } from '../../providers/phoneSetupState';
import type { SetupClaim } from './repo.setupCommand';
import type { PhoneClientFactory } from './types.operations';
import { currentPortraitSession, recordPortraitProof } from './repo.setupPortrait';
import { IPhoneError } from './types';
import { provePortrait } from '../../providers/phonePortraitProof';
import type { SetupLocalPortraitResult } from '../../providers/phoneSetupVerifier';

export async function observePortrait(
  claim: SetupClaim,
  input: SetupInput,
  factory: PhoneClientFactory
): Promise<SetupLocalPortraitResult> {
  const before = await currentPortraitSession(claim, input);
  const client = factory();
  const expires = performance.now() + Math.min(30000, before.deadlineAt - before.now);
  async function budget() {
    const context = await currentPortraitSession(claim, input);
    const remaining = Math.floor(
      Math.min(expires - performance.now(), context.deadlineAt - context.now)
    );
    if (
      remaining <= 0 ||
      context.session.id !== before.session.id ||
      context.route.digest !== before.route.digest
    )
      throw new IPhoneError(
        409,
        'Phone portrait observation expired',
        'phone_portrait_observation_expired'
      );
    return remaining;
  }
  const first = await client.perform(before.session, 'screen.text', {}, await budget());
  const frame = await client.frame(before.session, await budget());
  const last = await client.perform(before.session, 'screen.text', {}, await budget());
  await budget();
  const after = await currentPortraitSession(claim, input);
  const proof = provePortrait(frame, first, last);
  const localPortrait = {
    routeDigest: after.route.digest,
    originalAssistiveTouch: after.route.originalAssistiveTouch,
    status: proof.status,
    digest: proof.digest,
    layout: proof.layout,
    capturedAt: new Date(after.now).toISOString(),
  };
  await recordPortraitProof(claim, input, localPortrait);
  return { identityConfirmed: false, status: proof.status, localPortrait };
}
