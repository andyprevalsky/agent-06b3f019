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
export {
  generateShortcode,
  createShortcode,
  lookupAndConsumeShortcode,
  cleanupExpiredShortcodes,
} from './shortcodes';
export { buildSmsContext } from './contextBuilder';
export { TOOL_SCHEMAS, dispatchToolCall, commitPendingWrites } from './supervisorTools';
export type { ToolCall, ToolResult, PendingOp } from './supervisorTools';
