/** Bounded last-observed configuration facts; never perpetual device attestation. */
export const SETUP_REQUIREMENTS_VERSION = 5;
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
  expectedPhone: string | null;
  runtime?: SetupRuntime;
}
export interface SetupChecks {
  requirementsVersion: number;
  checks: Partial<Record<SetupTarget, SetupProof>>;
}
export const CONFIG_TARGETS = SETUP_TARGETS.filter((target) => target !== 'runtime');
export function proofCurrent(
  proof: SetupProof | undefined,
  context: {
    attemptId?: string;
    profileRevision: number;
    workflowId?: string;
    providerEpoch: number;
    expectedPhone: string | null;
    expectedGoogleIdentity?: string;
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
    (context.floorAt === undefined || Date.parse(proof.observedAt) >= Date.parse(context.floorAt))
  );
}
export function verificationDto(
  value: SetupChecks | undefined,
  context: Parameters<typeof proofCurrent>[1]
) {
  const checks = Object.fromEntries(
    SETUP_TARGETS.map((target) => {
      const proof = value?.checks[target];
      const current =
        value?.requirementsVersion === SETUP_REQUIREMENTS_VERSION && proofCurrent(proof, context);
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
  const configurationReady =
    CONFIG_TARGETS.every(
      (target) => checks[target].current && checks[target].status === 'confirmed'
    ) &&
    context.expectedPhone !== null &&
    context.expectedGoogleIdentity !== undefined &&
    context.expectedGoogleIdentity !== '';
  const runtime =
    value?.requirementsVersion === SETUP_REQUIREMENTS_VERSION ? value.checks.runtime : undefined;
  const currentRuntime =
    proofCurrent(runtime, context) &&
    runtime !== undefined &&
    runtime.status === 'confirmed' &&
    (context.now?.getTime() ?? Date.now()) - Date.parse(runtime.observedAt) <= 120_000
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
      typeof p.evidenceDigest === 'string' &&
      (p.expectedPhone === null || typeof p.expectedPhone === 'string')
  );
}
