/**
 * [QUEUE] -> [READ_ONLY] -> [USER] retain precedence over setup status.
 * [PENDING JOURNAL] -> checking/verifying; [SETUP PHASE] -> constant safe label.
 * [READY|NO SETUP] -> ordinary phone status. No identity, reason, or provider result is rendered.
 */
import type { PhoneOperation, PhoneSetupStatus } from '@/lib/api/iphone';
import type { PhoneOverlayModel } from './usePhoneOverlay';
interface PhoneHeaderStatus {
  label: string;
  active: boolean;
}
function setupLabel(setup?: PhoneSetupStatus): string | undefined {
  if (setup?.required !== true) return;
  switch (setup.state) {
    case 'not_started':
    case 'in_progress':
      return 'Setting up your phone';
    case 'awaiting_user':
      return 'Phone setup needs your help';
    case 'verifying':
      return 'Verifying phone setup';
    case 'blocked':
      return 'Phone setup blocked';
    case 'deferred':
      return 'Phone setup deferred';
    default:
      return;
  }
}
export function phoneStatus(
  phone: PhoneOverlayModel,
  readOnly: boolean,
): PhoneHeaderStatus | undefined {
  const snapshot = phone.snapshot,
    lease = snapshot?.lease;
  if (!phone.visible || !lease) return;
  if (lease.status === 'WAITING') return { label: 'Waiting for phone', active: false };
  if (readOnly) return { label: 'Read-only phone', active: false };
  if (lease.controlOwner === 'user') return { label: 'You have phone control', active: true };
  const pending = snapshot.pendingOperation;
  if (
    pending &&
    (snapshot.setup || pending.operation === 'setup.verify') &&
    !['SUCCEEDED', 'FAILED'].includes(pending.status)
  )
    return {
      label:
        pending.operation === 'setup.verify' ? 'Verifying phone setup' : 'Checking phone request',
      active: false,
    };
  const label = setupLabel(snapshot.setup);
  if (label) return { label, active: false };
  if (
    (!snapshot.setup || (snapshot.setup.required === true && snapshot.setup.state !== 'ready')) &&
    snapshot.lastOperation?.errorCode === 'phone_setup_required'
  )
    return { label: 'Setting up your phone', active: false };
  return { label: 'Phone active', active: lease.status === 'ACTIVE' };
}

export function phoneVerificationPending(operation?: PhoneOperation | null): boolean {
  return (
    operation?.operation === 'setup.verify' && !['SUCCEEDED', 'FAILED'].includes(operation.status)
  );
}
