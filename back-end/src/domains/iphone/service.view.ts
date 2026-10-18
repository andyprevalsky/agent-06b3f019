/** First-party PNG -> durable cursor-neutral observation -> fresh private grant.
 * Claim under the device lock; provider IO outside it; retire only after RPC settles.
 * Control/release/cleanup see the same CONNECTING/RUNNING custody as commands. */
import { randomUUID } from '../../providers/crypto';
import { PhoneHarnessClient } from '../../providers/phoneHarness';
import * as commands from './repo.operations';
import { retireObservation } from './repo.view';
import { IPhoneError } from './types';
import type { PhoneClientFactory } from './types.operations';
import { cleanupPhone, ensurePhoneSession, PhoneConnectionPending } from './service.session';

export async function phoneFrame(
  userId: string,
  leaseId: string,
  clientFactory: PhoneClientFactory = () => new PhoneHarnessClient(),
  taskBound = false
) {
  const claim = await commands.claimCommand(
    userId,
    leaseId,
    {
      operationId: `frame:${randomUUID()}`,
      operation: 'screen.frame',
      args: {},
    },
    'user',
    true,
    taskBound
  );
  let retired = false;
  try {
    const client = clientFactory();
    const session = await ensurePhoneSession(claim, client);
    if (!(await commands.beginExecution(claim)))
      throw new IPhoneError(409, 'Phone interaction changed');
    const bytes = await client.frame(session);
    const valid = await retireObservation(claim);
    retired = true;
    if (!valid) throw new IPhoneError(409, 'Phone interaction changed');
    return bytes;
  } catch (error) {
    if (error instanceof IPhoneError) throw error;
    if (error instanceof PhoneConnectionPending)
      throw new IPhoneError(409, 'Phone view is being prepared');
    throw new IPhoneError(503, 'Phone view is temporarily unavailable');
  } finally {
    if (!retired) await retireObservation(claim);
    await cleanupPhone(userId, clientFactory);
  }
}
