/** Independent, retry-safe root creation using the existing lifecycle and placement. */
import { createHash } from 'node:crypto';
import { requireAccountAccess } from './agentAccountService';
import { AgentGraphError, type GraphCaller } from './agentGraphService';
import { createAgent } from './agentLifecycleService';
import { resumeIndependentRootStart } from './agentDirectStartService';
import { createAgentSchema } from './types';
import * as repo from './repoAgentAccount';

export interface AccountSpawnInput {
  project: string;
  folder: string;
  title: string;
  goal: string;
  id: string;
  instruction: { path: string; sha256: string; explicitly_authorized: true };
}

function independentId(userId: string, key: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['rose-independent-spawn-v1', userId, key]))
    .digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function spawnAccountAgent(caller: GraphCaller, input: AccountSpawnInput) {
  requireAccountAccess(caller);
  // Account access and a client declaration are not spawn authorization.
  // The signed claim binds one request to an instruction checked by trusted code.
  const grant = caller.accountSpawnGrant;
  if (
    grant === undefined ||
    grant === null ||
    typeof grant.path !== 'string' ||
    !grant.path ||
    typeof grant.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(grant.sha256) ||
    grant.requestId !== input.id ||
    input.instruction?.explicitly_authorized !== true ||
    input.instruction.path !== grant.path ||
    input.instruction.sha256 !== grant.sha256
  ) {
    throw new AgentGraphError(403, 'A trusted source-bound spawn grant is required');
  }
  if ((await repo.ownedAccountPlacement(caller.userId, input.project, input.folder)) === null) {
    throw new AgentGraphError(404, 'Project/folder not found in this account');
  }
  const ownerId = caller.self.kind === 'code' ? caller.self.ownerAgentId : caller.self.id;
  const owner = await repo.ownedAccountAgent(caller.userId, ownerId);
  if (owner === null) throw new AgentGraphError(404, 'Source agent not found');
  const id = independentId(caller.userId, input.id);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ ...input, ownerId }))
    .digest('hex');
  const body = createAgentSchema.parse({
    agent_id: id,
    project_id: input.project,
    goal: input.goal,
    model: owner.model,
    reasoning_max_tokens: owner.reasoningMaxTokens,
    start_phase: 'plan',
  });
  let existing = await repo.ownedAccountAgent(caller.userId, id);
  if (existing === null) {
    try {
      await createAgent(body, caller.userId, false, null, false, {
        graphSpawn: { title: input.title, folderId: input.folder, requestHash },
      });
      return {
        agent_id: id,
        url: `https://www.roselabs.ai/?agent-id=${id}`,
        independent: true,
        duplicate: false,
      };
    } catch (err) {
      // A concurrent identical reservation or ambiguous start is reconciled below.
      existing = await repo.ownedAccountAgent(caller.userId, id);
      if (existing === null) throw err;
    }
  }
  const record = await repo.spawnRequestRecord(id);
  const hash = (record?.metadata as Record<string, unknown> | null)?.graph_spawn_hash;
  if (hash !== requestHash || existing.parentAgentId !== null) {
    throw new AgentGraphError(409, 'Idempotency key already belongs to a different spawn request');
  }
  if (existing.temporalWorkflowStartPending) {
    await resumeIndependentRootStart(
      createAgentSchema.parse({
        ...body,
        model: existing.model,
        reasoning_max_tokens: existing.reasoningMaxTokens,
        fast_mode_cache_enabled: existing.fastModeCacheEnabled,
        memory_enabled: existing.memoryEnabled,
        world_model_mode: existing.worldModelMode,
      }),
      caller.userId,
      existing.priceLimitCents
    );
  }
  return {
    agent_id: id,
    url: `https://www.roselabs.ai/?agent-id=${id}`,
    independent: true,
    duplicate: true,
  };
}
