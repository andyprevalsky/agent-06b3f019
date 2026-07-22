export interface SlackAutoRcaFeedback {
  channel: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  eventId: string;
  text: string;
}

export type ParsedSlackAutoRcaEvent =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'feedback'; feedback: SlackAutoRcaFeedback }
  | { kind: 'ignored' };
