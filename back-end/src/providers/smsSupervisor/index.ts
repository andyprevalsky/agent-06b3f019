/**
 * SMS Supervisor Module
 *
 * Provides the LLM-powered SMS interface for managing agents via text message.
 */

export {
  handleSmsSupervisorMessage,
  setSupervisorFixtureOverride,
  clearSupervisorFixtureOverride,
  BYPASS_FIXTURE_REAL_LLM,
} from './supervisorHandler';
export type { SmsSupervisorResult } from './supervisorHandler';
export { buildSmsContext } from './contextBuilder';
export { TOOL_SCHEMAS, dispatchToolCall, commitPendingWrites } from './supervisorTools';
export type { ToolCall, ToolResult, PendingOp } from './supervisorTools';
export {
  PROACTIVE_SMS_CRON_EXPRESSION,
  PROACTIVE_SMS_JOB_LEASE_KEY,
  PROACTIVE_SMS_OUTREACH_PROMPT,
  PROACTIVE_SMS_TIME_ZONE,
  runProactiveSmsOutreachJob,
  runProactiveSmsOutreachJobWithLease,
} from './proactiveOutreach';
export type {
  ProactiveSmsJobOptions,
  ProactiveSmsJobSummary,
  ProactiveSmsLeasedJobResult,
} from './proactiveOutreach';
