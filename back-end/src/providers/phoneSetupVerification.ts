/** Bounded last-observed configuration facts; never perpetual device attestation. */
export const SETUP_REQUIREMENTS_VERSION = 6;
export const SETUP_TARGETS = [
  'apple_account',
  'icloud_messages',
  'icloud_keychain',
  'icloud_contacts',
  'imessage',
  'receive_address',
  'portrait_lock',
  'device_passcode',
  'gmail',
  'google_passcode_exception',
  'runtime',
] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];
export type CheckStatus = 'confirmed' | 'disabled' | 'unknown';
export interface SetupRuntime {
  sync: 'syncing' | 'paused' | 'idle' | 'unknown';
  activation: 'active' | 'pending' | 'failed' | 'unknown';
  reason: 'low_power' | 'low_battery' | 'network' | 'storage' | 'user_paused' | 'unknown';
}
export interface SetupProof {
  status: CheckStatus;
  observedAt: string;
  evidenceDigest: string;
  floorCursor?: number;
  requirementsVersion?: number;
  attemptId: string;
  profileRevision: number;
  workflowId: string;
  providerEpoch: number;
  /** Original native observation epoch when a confirmed stop carries the device settings. */
  observedProviderEpoch?: number;
  /** Attempt floor this proof was rebound to when its setup actor re-acquired the phone; a later
   * re-observation may move observedAt past it, so the floor compares the later of the two. */
  carriedAt?: string;
  expectedPhone: string | null;
  runtime?: SetupRuntime;
}
export interface SetupChecks {
  requirementsVersion: number;
  checks: Partial<Record<SetupTarget, SetupProof>>;
}
export const CONFIG_TARGETS = SETUP_TARGETS.filter(
  (target) => target !== 'runtime' && target !== 'google_passcode_exception'
);
export function requiresGoogleIdentity(target: SetupTarget | undefined) {
  return target === 'gmail' || target === 'google_passcode_exception';
}
export function proofCurrent(
  proof: SetupProof | undefined,
  context: {
    attemptId?: string;
    profileRevision: number;
    workflowId?: string;
    providerEpoch: number;
    expectedPhone: string | null;
    expectedGoogleIdentity?: string;
    allowGooglePasscodeException?: boolean;
    floorAt?: string;
    floorCursor?: number;
    now?: Date;
  }
) {
  return Boolean(
    proof &&
    proof.requirementsVersion === SETUP_REQUIREMENTS_VERSION &&
    proof.attemptId === (context.attemptId ?? '') &&
    proof.profileRevision === context.profileRevision &&
    proof.workflowId === (context.workflowId ?? '') &&
    proof.providerEpoch === context.providerEpoch &&
    proof.expectedPhone === context.expectedPhone &&
    proof.floorCursor !== undefined &&
    proof.floorCursor === (context.floorCursor ?? 0) &&
    (context.floorAt === undefined ||
      Math.max(Date.parse(proof.observedAt), Date.parse(proof.carriedAt ?? proof.observedAt)) >=
        Date.parse(context.floorAt))
  );
}
export function verificationDto(
  value: SetupChecks | undefined,
  context: Parameters<typeof proofCurrent>[1],
  runtimeObservation?: {
    value: SetupChecks | undefined;
    context: Parameters<typeof proofCurrent>[1];
  }
) {
  const checks = Object.fromEntries(
    SETUP_TARGETS.map((target) => {
      const source = target === 'runtime' && runtimeObservation ? runtimeObservation.value : value;
      const proof = source?.checks[target];
      const binding =
        target === 'runtime' && runtimeObservation ? runtimeObservation.context : context;
      const current =
        source?.requirementsVersion === SETUP_REQUIREMENTS_VERSION && proofCurrent(proof, binding);
      return [
        target,
        {
          status: current ? proof!.status : 'unknown',
          current,
          ...(proof ? { observedAt: proof.observedAt, lastKnownStatus: proof.status } : {}),
        },
      ];
    })
  );
  const confirmed = (target: SetupTarget) =>
    checks[target].current && checks[target].status === 'confirmed';
  const securityDisposition = confirmed('device_passcode')
    ? 'passcode_enabled'
    : context.allowGooglePasscodeException === true &&
        confirmed('google_passcode_exception') &&
        context.expectedGoogleIdentity !== undefined &&
        context.expectedGoogleIdentity !== ''
      ? 'authorized_google_exception'
      : 'blocked';
  const configurationReady =
    CONFIG_TARGETS.every((target) => target === 'device_passcode' || confirmed(target)) &&
    securityDisposition !== 'blocked' &&
    context.expectedPhone !== null &&
    context.expectedGoogleIdentity !== undefined &&
    context.expectedGoogleIdentity !== '';
  const runtimeValue = runtimeObservation ? runtimeObservation.value : value;
  const runtimeContext = runtimeObservation?.context ?? context;
  const runtime =
    runtimeValue?.requirementsVersion === SETUP_REQUIREMENTS_VERSION
      ? runtimeValue.checks.runtime
      : undefined;
  const currentRuntime =
    proofCurrent(runtime, runtimeContext) &&
    runtime !== undefined &&
    runtime.status === 'confirmed' &&
    (runtimeContext.now?.getTime() ?? Date.now()) - Date.parse(runtime.observedAt) <= 120_000
      ? runtime.runtime
      : undefined;
  const operationalStatus =
    !configurationReady || !currentRuntime
      ? 'unknown'
      : currentRuntime.sync === 'paused' ||
          ['pending', 'failed'].includes(currentRuntime.activation)
        ? 'degraded'
        : currentRuntime.activation === 'active' &&
            ['syncing', 'idle'].includes(currentRuntime.sync)
          ? 'operational'
          : 'unknown';
  return {
    requirementsVersion: SETUP_REQUIREMENTS_VERSION,
    checks,
    configurationReady,
    securityDisposition,
    operationalStatus,
    ...(currentRuntime ? { runtime: currentRuntime } : {}),
  };
}

export function validSetupChecks(value: unknown): value is SetupChecks {
  if (!value || typeof value !== 'object') return false;
  const v = value as SetupChecks;
  if (
    !Number.isSafeInteger(v.requirementsVersion) ||
    !v.checks ||
    typeof v.checks !== 'object' ||
    Array.isArray(v.checks)
  )
    return false;
  return Object.entries(v.checks).every(
    ([target, p]) =>
      SETUP_TARGETS.includes(target as SetupTarget) &&
      p &&
      ['confirmed', 'disabled', 'unknown'].includes(p.status) &&
      typeof p.observedAt === 'string' &&
      Number.isFinite(Date.parse(p.observedAt)) &&
      typeof p.attemptId === 'string' &&
      typeof p.workflowId === 'string' &&
      Number.isSafeInteger(p.profileRevision) &&
      Number.isSafeInteger(p.providerEpoch) &&
      (p.observedProviderEpoch === undefined ||
        (Number.isSafeInteger(p.observedProviderEpoch) &&
          p.observedProviderEpoch >= 0 &&
          p.observedProviderEpoch <= p.providerEpoch)) &&
      (p.carriedAt === undefined ||
        (typeof p.carriedAt === 'string' && Number.isFinite(Date.parse(p.carriedAt)))) &&
      typeof p.evidenceDigest === 'string' &&
      (p.expectedPhone === null || typeof p.expectedPhone === 'string')
  );
}

export type SetupStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export interface SetupProgress {
  steps: Array<{ key: string; label: string; status: SetupStepStatus }>;
}
const PROGRESS_STEPS: ReadonlyArray<{
  key: string;
  label: string;
  targets: readonly SetupTarget[];
}> = [
  { key: 'session', label: 'Phone booted', targets: [] },
  { key: 'portrait_lock', label: 'Orientation locked', targets: ['portrait_lock'] },
  { key: 'apple_account', label: 'Apple ID signed in', targets: ['apple_account'] },
  {
    key: 'icloud',
    label: 'iCloud connected',
    targets: ['icloud_messages', 'icloud_keychain', 'icloud_contacts'],
  },
  { key: 'imessage', label: 'iMessage on', targets: ['imessage', 'receive_address'] },
  { key: 'gmail', label: 'Gmail connected', targets: ['gmail'] },
  { key: 'passcode', label: 'Passcode set', targets: ['device_passcode'] },
];
/** Display projection of the stored checks for the connection screen; never a readiness grant.
 * A current 'disabled' observation fails its step; a blocked setup fails its next open step. */
export function setupProgress(
  verification: ReturnType<typeof verificationDto>,
  input: {
    status: 'not_connected' | 'setting_up' | 'ready' | 'needs_reauth';
    setupState: string;
    providerState: string;
    passcodeExceptionAllowed: boolean;
  }
): SetupProgress | null {
  if (input.status === 'not_connected') return null;
  const checks = verification.checks;
  const confirmed = (target: SetupTarget) =>
    checks[target].current && checks[target].status === 'confirmed';
  const disabled = (target: SetupTarget) =>
    checks[target].current && checks[target].status === 'disabled';
  const booted =
    input.providerState === 'READY' ||
    SETUP_TARGETS.some((target) => checks[target].observedAt !== undefined);
  const resolved = PROGRESS_STEPS.map((step): SetupStepStatus | null => {
    if (input.status === 'ready') return 'done';
    if (step.key === 'session') return booted ? 'done' : null;
    if (step.key === 'passcode') {
      if (verification.securityDisposition !== 'blocked') return 'done';
      return disabled('device_passcode') && !input.passcodeExceptionAllowed ? 'failed' : null;
    }
    if (step.targets.every(confirmed)) return 'done';
    if (
      step.targets.some(disabled) ||
      (step.key === 'apple_account' && input.status === 'needs_reauth')
    )
      return 'failed';
    return null;
  });
  const next = resolved.indexOf(null);
  return {
    steps: PROGRESS_STEPS.map((step, index) => ({
      key: step.key,
      label: step.label,
      status:
        resolved[index] ??
        (index !== next
          ? 'pending'
          : input.setupState === 'blocked'
            ? 'failed'
            : input.status === 'setting_up'
              ? 'in_progress'
              : 'pending'),
    })),
  };
}
