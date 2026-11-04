/** Explicit live-test disposition; never used by production readiness or custody. */
import { readFileSync } from 'node:fs';

export const STEEL_PROFILE_PERSISTENCE_OVERRIDE = 'browser-provider:steel-profile-persistence-live';

export class SteelProfilePersistenceLiveSkipped extends Error {}

/** Preserve the domain's failure count while reporting the one explicit live skip. */
export async function runSteelAwareParity(
  run: () => Promise<void>,
  live: boolean
): Promise<{ failed: number; skipped: boolean }> {
  try {
    await run();
    if (live) console.log('PASS live Kernel provider parity');
    return { failed: 0, skipped: false };
  } catch (error) {
    if (error instanceof SteelProfilePersistenceLiveSkipped) {
      console.warn(`⚠️⚠️ SKIPPED ${error.message}`);
      return { failed: 0, skipped: true };
    }
    console.error(
      `FAIL live Kernel provider parity: ${error instanceof Error ? error.message : String(error)}`
    );
    return { failed: 1, skipped: false };
  }
}

type StatusReceipt = {
  at: string;
  kind: string;
  id: string;
  transport: string;
  host: string;
  http_status: number;
  fields: {
    id?: string;
    status?: string;
    profileId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};

export interface SteelPersistenceOutageEvidence {
  failure: {
    steel_profile_id: string;
    source_steel_session_id: string;
    profile_not_ready_attempts: number;
    probe_last_timestamp: string;
  };
  native: StatusReceipt[];
}

/** Native observations must bind the exact failed profile and writer, not a generic error. */
export function validateSteelPersistenceOutage(evidence: SteelPersistenceOutageEvidence): void {
  const { failure, native } = evidence;
  const profile = native.find(
    (row) => row.kind === 'profiles' && row.id === failure.steel_profile_id
  );
  const writer = native.find(
    (row) => row.kind === 'sessions' && row.id === failure.source_steel_session_id
  );
  if (
    !profile ||
    !writer ||
    !failure.steel_profile_id ||
    !failure.source_steel_session_id ||
    !(failure.profile_not_ready_attempts > 0)
  )
    throw new Error('Missing exact Steel persistence failure binding');
  for (const row of [profile, writer]) {
    if (
      row.http_status !== 200 ||
      row.transport !== 'same-installed-node-sdk' ||
      row.host !== 'api.steel.dev' ||
      row.fields.id !== row.id ||
      !(Date.parse(row.at) > Date.parse(failure.probe_last_timestamp))
    ) {
      throw new Error(
        'Steel persistence override requires later successful native SDK observations'
      );
    }
  }
  if (
    profile.fields.status !== 'UPLOADING' ||
    writer.fields.status !== 'failed' ||
    writer.fields.profileId !== profile.id ||
    !profile.fields.createdAt ||
    profile.fields.updatedAt !== profile.fields.createdAt ||
    !(Date.parse(profile.fields.createdAt) < Date.parse(failure.probe_last_timestamp))
  ) {
    throw new Error(
      'Native evidence does not prove the exact failed writer and unchanged uploading profile'
    );
  }
}

/** Only the explicitly waived persistence leg stops; all preceding assertions still run. */
export function skipProvenSteelPersistenceOutage(
  env: NodeJS.ProcessEnv = process.env,
  load: (path: string) => string = (path) => readFileSync(path, 'utf8')
): void {
  if (
    !(env.DEPLOY_GATE_OVERRIDES ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes(STEEL_PROFILE_PERSISTENCE_OVERRIDE)
  )
    return;
  const path = env.STEEL_PROFILE_PERSISTENCE_OUTAGE_EVIDENCE;
  if (!path)
    throw new Error('Steel persistence override requires retained exact-resource evidence');
  const evidence = JSON.parse(load(path)) as SteelPersistenceOutageEvidence;
  validateSteelPersistenceOutage(evidence);
  throw new SteelProfilePersistenceLiveSkipped(
    `Steel call-4 profile-persistence rotation and dependent exhaustion assertions; parity incomplete; evidence=${path}; profile=${evidence.failure.steel_profile_id}; ` +
      `writer=${evidence.failure.source_steel_session_id}; native writer failed/profile remains UPLOADING; NOT a pass`
  );
}
