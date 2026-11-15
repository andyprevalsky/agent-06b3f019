/** Shared saved credential -> semantic Apple-form binding -> private physical input. */
import { PhoneHarnessError, type PhoneHarnessClient } from '../../providers/phoneHarness';
import {
  verifyPhoneCredential,
  type CredentialVerifier,
} from '../../providers/phoneCredentialVerifier';
import * as commands from './repo.operations';
import { savedBinding, prepareSavedPassword, resumeSavedPrivacy } from './repo.savedCredential';
import { billSetup } from './repo.setupFinish';
import type { CommandClaim } from './types.operations';
import { ensurePhoneSession } from './service.session';
import { createLogger } from '../../providers/logger';

const log = createLogger('IPhoneSavedCredential');
export async function runSavedCredential(
  claim: CommandClaim,
  client: PhoneHarnessClient,
  verifier: CredentialVerifier = verifyPhoneCredential,
  beforeExecute?: () => Promise<void>
) {
  let started = false;
  try {
    const session = await ensurePhoneSession(claim, client);
    const binding = await savedBinding(claim, await readSavedBounds(client, session));
    const verdict = await verifySavedBinding(claim, binding, verifier);
    const { x, y } = verdict;
    const b = binding.bounds;
    if (
      !verdict.allowed ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      ![b.x, b.y, b.w, b.h].every(Number.isFinite) ||
      b.w <= 0 ||
      b.h <= 0 ||
      x < b.x ||
      y < b.y ||
      x >= b.x + b.w ||
      y >= b.y + b.h
    )
      throw new Error('phone_credential_binding_required');
    await beforeExecute?.();
    const realm =
      verdict.credentialRealm ??
      (binding.state.expectedGoogleIdentity === undefined ? 'apple' : undefined);
    if (realm === undefined || (realm !== 'apple' && realm !== 'google'))
      throw new Error('phone_credential_binding_required');
    const password = await prepareSavedPassword(claim, binding, realm);
    started = true;
    // The bound point is not secret; it is the only trace of which element the fill tapped.
    log.info('saved credential bound', {
      leaseId: claim.lease.id,
      cursor: claim.command.cursor,
      realm,
      x,
      y,
    });
    await client.perform(session, 'input.tap', { x, y });
    await client.perform(session, 'input.text', { s: password, keystrokes: false });
    const result = await commands.finishCommand(claim, 'SUCCEEDED', {
      success: true,
      private: true,
      credentialStatus: 'filled',
    });
    await resumeSavedPrivacy(claim);
    return result;
  } catch (error) {
    const unknown =
      started && (!(error instanceof PhoneHarnessError) || error.outcome === 'unknown');
    const code =
      error instanceof Error &&
      ['phone_credential_unavailable', 'phone_credential_verifier_unavailable'].includes(
        error.message
      )
        ? error.message
        : 'phone_credential_binding_required';
    return commands.finishCommand(
      claim,
      unknown ? 'UNKNOWN' : 'FAILED',
      {
        success: false,
        private: true,
        credentialStatus: unknown ? 'unknown' : 'unavailable',
        error: code,
      },
      code
    );
  }
}

async function readSavedBounds(
  client: PhoneHarnessClient,
  session: Parameters<PhoneHarnessClient['perform']>[0]
) {
  const b = (await client.perform(session, 'screen.bounds', {})) as {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  if (b === null || typeof b !== 'object' || ![b.x, b.y, b.w, b.h].every(Number.isFinite))
    throw new Error('phone_credential_binding_required');
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

async function verifySavedBinding(
  claim: CommandClaim,
  binding: Awaited<ReturnType<typeof savedBinding>>,
  verifier: CredentialVerifier
) {
  try {
    const verdict = await verifier({
      agentId: claim.lease.agentId,
      expectedAppleIdentity: binding.state.expectedAppleIdentity!,
      expectedGoogleIdentity: binding.state.expectedGoogleIdentity,
      evidence: binding.evidence,
      bounds: binding.bounds,
    });
    if (verdict.usage)
      await billSetup(claim, { usage: verdict.usage }, 'phone_saved_credential_binding');
    return verdict;
  } catch {
    throw new Error('phone_credential_verifier_unavailable');
  }
}
