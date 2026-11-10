export { MessageChannel } from '@prisma/client';
import type { MessageChannel } from '@prisma/client';

/**
 * One recent inbound message returned to the browser agent's OTP relay.
 */
export interface RecentInboundMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  channel: MessageChannel;
  date: Date;
  personId: string;
}
export type { ImessageQueue } from '@prisma/client';

/** Known ownership/lifecycle conflicts; infrastructure failures keep their original error. */
export class CloudMessageBindingConflictError extends Error {}

/** Expected cloud account/device eligibility failure, never database infrastructure. */
export class CloudMessageEligibilityError extends Error {}
