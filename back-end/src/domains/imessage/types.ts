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
