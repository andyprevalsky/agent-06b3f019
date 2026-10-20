import { PhoneHarnessError, type PhoneHarnessClient } from '../../providers/phoneHarness';
import {
  verifyPhoneCredential,
  type CredentialVerifier,
} from '../../providers/phoneCredentialVerifier';
import { savedBinding, resumeSavedPrivacy } from './repo.savedCredential';
import { prepareDevicePasscode } from './repo.passcode';
import { billSetup } from './repo.setupFinish';
import * as commands from './repo.operations';
import { ensurePhoneSession } from './service.session';
import type { CommandClaim } from './types.operations';

export async function runDevicePasscode(
  claim: CommandClaim,
  client: PhoneHarnessClient,
  verifier: CredentialVerifier = verifyPhoneCredential,
  beforeExecute?: () => Promise<void>
) {
  let started = false;
  try {
    const session = await ensurePhoneSession(claim, client);
    const bounds = await readPasscodeBounds(client, session);
    const binding = await savedBinding(claim, bounds, false);
    const verdict = await passcodeVerdict(claim, binding, verifier);
    const { x, y, passcodeStage } = verdict;
    await beforeExecute?.();
    const code = await prepareDevicePasscode(claim, binding, passcodeStage);
    started = true;
    await client.perform(session, 'input.tap', { x, y });
    if (passcodeStage !== 'acknowledge')
      await client.perform(session, 'input.text', { s: code, keystrokes: true });
    const result = await commands.finishCommand(claim, 'SUCCEEDED', {
      success: true,
      private: true,
      passcodeStatus:
        passcodeStage === 'create'
          ? 'created'
          : passcodeStage === 'acknowledge'
            ? 'acknowledged'
            : 'confirmed',
    });
    await resumeSavedPrivacy(claim);
    return result;
  } catch (error) {
    const unknown =
      started && (!(error instanceof PhoneHarnessError) || error.outcome === 'unknown');
    const code =
      error instanceof Error && error.message === 'phone_passcode_verifier_unavailable'
        ? error.message
        : 'phone_passcode_binding_required';
    return commands.finishCommand(
      claim,
      unknown ? 'UNKNOWN' : 'FAILED',
      {
        success: false,
        private: true,
        passcodeStatus: unknown ? 'unknown' : 'unavailable',
      },
      code
    );
  }
}

async function readPasscodeBounds(
  client: PhoneHarnessClient,
  session: Parameters<PhoneHarnessClient['perform']>[0]
) {
  const bounds = (await client.perform(session, 'screen.bounds', {})) as {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null;
  if (
    bounds === null ||
    typeof bounds !== 'object' ||
    ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) ||
    bounds.w <= 0 ||
    bounds.h <= 0
  )
    throw new Error('phone_passcode_binding_required');
  return bounds;
}
async function passcodeVerdict(
  claim: CommandClaim,
  binding: Awaited<ReturnType<typeof savedBinding>>,
  verifier: CredentialVerifier
) {
  const permittedPasscodeStage = binding.state.passcodeCreation
    ? binding.state.passcodeCreation.acknowledged === true
      ? 'confirm'
      : 'confirm_or_acknowledge'
    : 'create';
  let verdict;
  try {
    verdict = await verifier({
      agentId: claim.lease.agentId,
      expectedAppleIdentity: '',
      purpose: 'device_passcode',
      permittedPasscodeStage,
      evidence: binding.evidence,
      bounds: binding.bounds,
    });
    if (verdict.usage)
      await billSetup(claim, { usage: verdict.usage }, 'phone_device_passcode_binding');
  } catch {
    throw new Error('phone_passcode_verifier_unavailable');
  }
  const { x, y, passcodeStage } = verdict;
  const b = binding.bounds;
  if (
    !verdict.allowed ||
    passcodeStage === undefined ||
    (permittedPasscodeStage === 'confirm_or_acknowledge'
      ? passcodeStage !== 'confirm' && passcodeStage !== 'acknowledge'
      : passcodeStage !== permittedPasscodeStage) ||
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < b.x ||
    y < b.y ||
    x >= b.x + b.w ||
    y >= b.y + b.h
  )
    throw new Error('phone_passcode_binding_required');
  return { x, y, passcodeStage };
}
