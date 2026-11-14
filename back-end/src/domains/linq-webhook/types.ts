import type { SurgeAttachment } from '../../providers/smsSupervisor/inboundMedia';

/** Structurally compatible with the shared SMS supervisor's inbound message. */
export interface ParsedLinqMessage {
  messageId: string;
  fromPhone: string;
  messageBody: string;
  attachments: SurgeAttachment[];
  chatId: string;
  service: 'iMessage' | 'SMS' | 'RCS';
}

/** Wired by server.ts so Linq reuses SMS orchestration without cross-domain imports. */
export interface LinqSupervisorHandlers {
  routeToSupervisor(
    userId: string,
    message: ParsedLinqMessage,
    requestStart: number
  ): Promise<void>;
  handleClearCommand(userId: string, fromPhone: string): Promise<void>;
}

export interface LinqSignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}
