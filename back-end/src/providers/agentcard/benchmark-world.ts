/** Native isolated SANDBOX bootstrap only. Never imported by the production connect routes. */
import { createHash } from 'node:crypto';
import { agentCardV2Request, type AgentCardV2Request } from './api-v2';
import { getEphemeral, putEphemeral, withSerializedLock } from '../sharedState';
import { isProductionEnvironment } from '../productionEnvironment';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { validateV2SandboxFixtureUser } from './v2-onboarding';

const NAMESPACE = 'benchmark-agentcard-world-v2';
const RETENTION_MS = 24 * 60 * 60 * 1000;
interface Journal {
  scope: string;
  phase: 'starting' | 'started' | 'verifying' | 'verified' | 'connected';
  connectId?: string;
  expiresAt?: string;
  providerUserId?: string;
}
interface Dependencies {
  request: AgentCardV2Request;
  read: (scope: string) => Promise<Journal | undefined>;
  write: (scope: string, journal: Journal) => Promise<void>;
  lock: <T>(scope: string, fn: () => Promise<T>) => Promise<T>;
  now: () => number;
}
const defaults: Dependencies = {
  request: agentCardV2Request,
  read: (scope) => getEphemeral<Journal>(NAMESPACE, scope),
  write: (scope, journal) => putEphemeral(NAMESPACE, scope, { ...journal }, RETENTION_MS),
  lock: (scope, fn) => withSerializedLock(`${NAMESPACE}:${scope}`, fn),
  now: Date.now,
};

export interface BenchmarkWorldIdentity {
  version: 1;
  worldId: string;
  scope: string;
  providerUserId: string;
  livemode: false;
  fundsSource: 'company_flow';
}

export function benchmarkWorldContext(env: Readonly<NodeJS.ProcessEnv> = process.env): {
  worldId: string;
  scope: string;
} {
  if (
    isProductionEnvironment(env) ||
    !['true', '1'].includes(env.BENCHMARK_MODE ?? '') ||
    env.BENCHMARK_ISOLATED_RUN !== 'true' ||
    env.BENCHMARK_AGENTCARD_WORLD_IDENTITY !== 'true' ||
    env.BENCHMARK_WORLD_MODEL_MODE === 'simulate' ||
    nonLocalDatabaseReason(env.DATABASE_URL) !== null
  )
    throw new Error(
      'AgentCard world bootstrap requires an explicit isolated local sandbox benchmark'
    );
  const worldId = env.BENCHMARK_RUN_ID?.trim() ?? '';
  const clientId = env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(worldId) || !clientId)
    throw new Error('AgentCard world bootstrap requires native world and credential identities');
  const database = new URL(env.DATABASE_URL ?? '');
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        clientId,
        env.AGENTCARD_BASE_URL ?? 'https://api.agentcard.sh',
        worldId,
        database.hostname,
        database.port,
        database.pathname,
      ])
    )
    .digest('hex');
  return { worldId, scope };
}

export async function provisionBenchmarkWorldIdentity(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: Partial<Dependencies> = {}
): Promise<BenchmarkWorldIdentity> {
  const { worldId, scope } = benchmarkWorldContext(env);
  const deps = { ...defaults, ...dependencies };
  return deps.lock(scope, async () => {
    // Credential mode is authoritative. No connect mutation precedes this proof.
    const wallet = await deps.request('GET', '/api/v2/company_wallet');
    if (wallet.livemode !== false || wallet.default_funds_source !== 'company_flow')
      throw new Error('AgentCard world bootstrap refuses unknown/live mode or non-company funding');
    let journal = await deps.read(scope);
    if (journal !== undefined && journal.scope !== scope)
      throw new Error('AgentCard world bootstrap journal scope mismatch');
    if (journal?.phase === 'starting' || journal?.phase === 'verifying')
      throw new Error(
        'AgentCard world connection outcome is ambiguous; unkeyed connect must not replay'
      );
    if (journal === undefined) {
      const localDeadline = deps.now() + 10 * 60 * 1000;
      journal = { scope, phase: 'starting' };
      await deps.write(scope, journal);
      const attempt = await deps.request('POST', '/api/v2/connect/start', {
        email: `ac-world-${scope.slice(0, 40)}@agentcard-benchmark.invalid`,
        external_user_id: `benchmark-world:${scope}`,
      });
      if (typeof attempt.id !== 'string' || !attempt.id)
        throw new Error('AgentCard world connect attempt missing authoritative identity');
      let deadline = localDeadline;
      if (attempt.expires_at !== undefined) {
        if (
          typeof attempt.expires_at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
            attempt.expires_at
          ) ||
          !Number.isFinite(Date.parse(attempt.expires_at))
        )
          throw new Error('AgentCard world connect attempt expiry was invalid');
        deadline = Math.min(deadline, Date.parse(attempt.expires_at));
      }
      journal = {
        scope,
        phase: 'started',
        connectId: attempt.id,
        expiresAt: new Date(deadline).toISOString(),
      };
      await deps.write(scope, journal);
    }
    if (journal.phase === 'started') {
      if (!journal.connectId || !journal.expiresAt || Date.parse(journal.expiresAt) <= deps.now())
        throw new Error('AgentCard world connect attempt expired; no automatic resend');
      journal = { ...journal, phase: 'verifying' };
      await deps.write(scope, journal);
      const verified = await deps.request('POST', '/api/v2/connect/verify', {
        connect_id: journal.connectId,
        code: '111111',
      });
      const user = verified.user as Record<string, unknown> | undefined;
      if (typeof user?.id !== 'string' || !/^usr_[A-Za-z0-9_-]+$/.test(user.id))
        throw new Error('AgentCard world verify response missing provider user.id');
      // Discard all connection tokens. Persist identity before idempotent consent.
      journal = { ...journal, phase: 'verified', providerUserId: user.id };
      await deps.write(scope, journal);
    }
    const providerUserId = journal.providerUserId;
    if (!providerUserId)
      throw new Error('AgentCard world journal lacks verified provider identity');
    if (journal.phase === 'verified') {
      await deps.request('POST', '/api/v2/connect/consent', { user_id: providerUserId });
      journal = { ...journal, phase: 'connected' };
      await deps.write(scope, journal);
    }
    if (journal.phase !== 'connected') throw new Error('AgentCard world connection is incomplete');
    await validateV2SandboxFixtureUser(providerUserId, deps.request);
    return {
      version: 1,
      worldId,
      scope,
      providerUserId,
      livemode: false,
      fundsSource: 'company_flow',
    };
  });
}
