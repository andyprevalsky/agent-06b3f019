/** Only this trusted backend caller reserves phone boot authority; request bodies cannot. */
import * as repo from './repoPhoneConnection';
import { createAgent } from './agentLifecycleService';
import { resumeIndependentRootStart } from './agentDirectStartService';
import { createAgentSchema } from './types';
import {
  connectionAgentHash,
  type PhoneConnectionReservation,
} from '../../providers/phoneConnectionState';
import { PhoneInteractionError as IPhoneError } from '../../providers/phoneInteractionError';

export const PHONE_CONNECTION_GOAL =
  'Connect my existing account iPhone using the standard iPhone setup and verification flow through the normal phone harness, including portrait orientation lock. Complete supported native Apple and Google sign-in with user authentication assistance when required. Do not reset the phone, allocate another device, send messages, switch unrelated accounts, or change Freedom.';
export async function launchSetupAgent(
  userId: string,
  deviceId: string,
  reservation: PhoneConnectionReservation
) {
  const hash = connectionAgentHash(userId, deviceId, reservation);
  const body = createAgentSchema.parse({
    agent_id: reservation.agentId,
    goal: PHONE_CONNECTION_GOAL,
    start_phase: 'execute',
  });
  let agent = await repo.ownedSetupAgent(reservation.agentId, userId);
  if (agent === null) {
    try {
      await createAgent(body, userId, false, null, false, {
        phoneSetupHash: hash,
      });
      return;
    } catch (error) {
      // Recover only the same owned durable root after a concurrent/ambiguous launch.
      agent = await repo.ownedSetupAgent(reservation.agentId, userId);
      if (agent === null) throw error;
    }
  }
  const first = await repo.firstSetupGoal(agent.id);
  if (
    agent.parentAgentId !== null ||
    agent.goal !== PHONE_CONNECTION_GOAL ||
    (first?.metadata as Record<string, unknown> | null)?.iphone_setup_hash !== hash
  )
    throw new IPhoneError(409, 'iPhone setup reservation does not match the normal agent');
  if (agent.temporalWorkflowStartPending)
    await resumeIndependentRootStart(
      createAgentSchema.parse({
        ...body,
        model: agent.model,
        reasoning_max_tokens: agent.reasoningMaxTokens,
        fast_mode_cache_enabled: agent.fastModeCacheEnabled,
        memory_enabled: agent.memoryEnabled,
        world_model_mode: agent.worldModelMode,
      }),
      userId,
      agent.priceLimitCents
    );
}
