import { verifyPhoneMessage, type MessageVerifier } from '../../providers/phoneMessageVerifier';
import { PhoneHarnessError, type PhoneHarnessClient } from '../../providers/phoneHarness';
import { messageBinding, commitMessage, markMessageUnknown } from './repo.message';
import { ensurePhoneSession } from './service.session';
import { billSetup } from './repo.setupFinish';
import { finishCommand } from './repo.operations';
import type { CommandClaim } from './types.operations';
export async function runMessage(
  claim: CommandClaim,
  queueId: string,
  client: PhoneHarnessClient,
  verifier: MessageVerifier = verifyPhoneMessage
) {
  let started = false;
  const mode = claim.command.operation === 'messages.send_approved' ? 'send' : 'verify';
  try {
    const session = mode === 'send' ? await ensurePhoneSession(claim, client) : null;
    const binding = await messageBinding(claim, queueId);
    if (
      mode === 'send' &&
      (binding.queue.dispatchedAt || binding.queue.phoneSendOperationId !== null)
    )
      throw new Error('phone_message_already_dispatched');
    const bounds =
      mode === 'send' && session
        ? ((await client.perform(session, 'screen.bounds', {})) as {
            x: number;
            y: number;
            w: number;
            h: number;
          })
        : undefined;
    const result = await verifier({
      agentId: claim.lease.agentId,
      mode,
      recipient: binding.queue.phoneNumber,
      body: binding.queue.message,
      before: binding.before,
      ...(mode === 'verify' ? { after: binding.evidence } : {}),
      ...(bounds ? { bounds } : {}),
    });
    await billSetup(claim, result, `phone_message_${mode}`);
    if (mode === 'send') {
      const { x, y } = sendPoint(result, bounds);
      await commitMessage(claim, binding, mode, 'allowed');
      started = true;
      await client.perform(session!, 'input.tap', { x, y });
    } else await commitMessage(claim, binding, mode, result.status);
    return await finishCommand(claim, 'SUCCEEDED', {
      success: true,
      queueId,
      status: mode === 'send' ? 'submitted' : result.status,
    });
  } catch (error) {
    const unknown =
      started && (!(error instanceof PhoneHarnessError) || error.outcome === 'unknown');
    if (started) await markMessageUnknown(claim, queueId);
    const code =
      error instanceof Error &&
      [
        'phone_message_already_dispatched',
        'phone_message_binding_required',
        'phone_message_observation_required',
      ].includes(error.message)
        ? error.message
        : 'phone_message_unavailable';
    return finishCommand(
      claim,
      unknown ? 'UNKNOWN' : 'FAILED',
      { success: false, queueId, status: unknown ? 'unknown' : 'failed', error: code },
      code
    );
  }
}

function sendPoint(
  result: Awaited<ReturnType<MessageVerifier>>,
  bounds: { x: number; y: number; w: number; h: number } | undefined
) {
  const { x, y } = result;
  if (
    result.status !== 'allowed' ||
    !bounds ||
    ![bounds.x, bounds.y, bounds.w, bounds.h, x, y].every(
      (v) => typeof v === 'number' && Number.isFinite(v)
    ) ||
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    x === undefined ||
    y === undefined ||
    x < bounds.x ||
    y < bounds.y ||
    x >= bounds.x + bounds.w ||
    y >= bounds.y + bounds.h
  )
    throw new Error('phone_message_binding_required');
  return { x, y };
}
