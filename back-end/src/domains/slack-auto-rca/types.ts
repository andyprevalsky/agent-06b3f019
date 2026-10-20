export interface SlackAutoRcaFeedback {
  channel: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  eventId: string;
  text: string;
}

/** A top-level alert card our own Slack app posted to the error channel. */
export interface SlackAutoRcaErrorAlert {
  channel: string;
  messageTs: string;
  botId: string;
  eventId: string;
  /** Slack's plain-text fallback (stable signature input). */
  text: string;
  /** Flattened card body (header, sections, fields, context) for the RCA goal. */
  report: string;
}

export type ParsedSlackAutoRcaEvent =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'error_alert'; alert: SlackAutoRcaErrorAlert }
  | { kind: 'feedback'; feedback: SlackAutoRcaFeedback }
  | { kind: 'ignored' };

export type SlackAutoRcaEventKind = 'error' | 'occurrence' | 'feedback';

export interface SlackAutoRcaIncidentRow {
  id: string;
  signature: string;
  windowStart: Date;
  agentId: string;
  ownerUserId: string;
  slackChannel: string;
  slackThreadTs: string;
  occurrenceCount: number;
  appendedCount: number;
  startNotifiedAt: Date | null;
}

export type SlackAutoRcaOutcome =
  | { action: 'created'; agentId: string; incidentId: string }
  | { action: 'appended'; agentId: string; incidentId: string }
  | { action: 'counted'; agentId: string; incidentId: string }
  | { action: 'duplicate'; agentId: string; incidentId: string }
  | { action: 'feedback'; agentId: string; incidentId: string }
  | { action: 'ignored'; reason: string };
