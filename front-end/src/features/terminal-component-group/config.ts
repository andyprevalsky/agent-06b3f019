/**
 * Config for the terminal-component-group domain.
 *
 * Constants, display mappings, and defaults shared across terminal UI components.
 */

import { BACKEND_BASE_URL, backendApiUrl } from '@/lib/backendUrl';
export { ADMIN_USER_IDS } from '@/lib/adminAccounts';

/** Backend API base URL (trailing slash stripped). Read once at module load. */
export const API_URL = BACKEND_BASE_URL;

/** Backend API base URL including /api prefix. */
export const API_BASE_WITH_PATH = backendApiUrl();

/** ClaudeCodeChip WebSocket retry backoff (ms between attempts). */
export const CLAUDE_CODE_WS_RETRY_DELAYS = [100, 400, 800];
export const CLAUDE_CODE_WS_MAX_RETRIES = 3;

/** Reference expanded sidebar width in pixels for saved resize preferences. */
export const SIDEBAR_WIDTH_EXPANDED = 300;

/** Collapsed sidebar width in pixels (icon rail). */
export const SIDEBAR_WIDTH_COLLAPSED = 64;

/** Narrowest the user can drag the sidebar before it stops shrinking. */
export const SIDEBAR_WIDTH_MIN = 220;

/** Widest the user can drag the sidebar. */
export const SIDEBAR_WIDTH_MAX = 480;

/**
 * Dragging narrower than this snaps to the collapsed rail. Sits below
 * SIDEBAR_WIDTH_MIN so collapsing is a deliberate drag, not an accidental nudge.
 */
export const SIDEBAR_COLLAPSE_SNAP_WIDTH = 160;

/** localStorage key holding the user's dragged sidebar width. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'rose-sidebar-width';

/** Poll interval (ms) for refreshing credit usage in the sidebar. */
export const CREDITS_POLL_INTERVAL_MS = 30_000;

/** Auto-close delay (ms) for the feedback sent confirmation. */
export const FEEDBACK_SENT_AUTOCLOSE_MS = 2_000;

/** True in Vite dev mode. Centralized here so components don't read `import.meta.env` directly. */
export const IS_DEV_MODE: boolean = import.meta.env.DEV === true;

/** True when running inside Vitest (vitest sets `import.meta.env.VITEST`). */
export const IS_VITEST: boolean = Boolean(import.meta.env.VITEST);

/** Admin phone numbers that unlock company-health dashboards in local/session state. */
export const ADMIN_PHONE_DIGITS: readonly string[] = ['19729777432', '9729777432'];

/** Upper bound for a single attachment (20MB — canonical client-side cap). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default context-restart threshold for the context meter. */
export const DEFAULT_RESTART_THRESHOLD = 100000;

/** Default pending price limit (cents) when no agent is selected ($10.00). */
export const DEFAULT_PENDING_PRICE_LIMIT_CENTS = 1000;

/** Fallback when an agent row has no stored limit ($10.00). */
export const DEFAULT_AGENT_PRICE_LIMIT_CENTS = 1000;

/** Warning threshold (fraction of limit) that flips the cost chip to amber. */
export const COST_WARNING_RATIO = 0.8;

/** Model IDs for the Rose racing endpoints — used for the model-selector descriptions. */
export const ROSE_MODEL_IDS = {
  flash: 'rose-labs/rose-1-flash',
  /** Display alias for the rose-fast speed pool (same id as `flash`). */
  fast: 'rose-labs/rose-1-flash',
  /** @deprecated Use `flash`. Kept for older imports/tests. */
  lite: 'rose-labs/rose-1-flash',
  ultra: 'rose-labs/rose-1-ultra',
  local: 'rose-labs/rose-local',
} as const;

/** Rose Desktop model selector: only the short pool name (UI ledger row 77). */
export const ROSE_MODEL_SHORT_NAMES: Record<string, string> = {
  [ROSE_MODEL_IDS.flash]: 'rose-flash',
  [ROSE_MODEL_IDS.ultra]: 'rose-ultra',
  [ROSE_MODEL_IDS.local]: 'rose-local',
};

/** Static descriptions for the built-in Rose models in the model picker. */
export const ROSE_MODEL_DESCRIPTIONS: Record<string, string> = {
  [ROSE_MODEL_IDS.flash]:
    'Super fast execution with full-strength planning. Avg tok/s: not yet measured. Intelligence vs frontier: not yet benchmarked.',
  [ROSE_MODEL_IDS.ultra]:
    'Maximum reasoning for complex, long-horizon tasks. For example: get more calls on my calendar with people who match my ideal customer profile.',
  [ROSE_MODEL_IDS.local]:
    'Local model inference on the configured Rose worker. No model API fees. Agent data still uses Rose cloud services. Avg tok/s and max throughput: unmeasured; % of Flash and Ultra: unmeasured.',
};

/** Tool name to human-readable label mapping (mirrors backend TOOL_DISPLAY_NAMES). */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_search: 'Web Searches',
  people_search: 'People Searches',
  spawn_agent: 'Agents Spawned',
  spawn_general_purpose_agent: 'General-purpose Agents Spawned',
  spawn_general_purpose_agent_for_each: 'General-purpose Agent Batches',
  spawn_sub_agent: 'General-purpose Agents Spawned',
  spawn_browser_agent: 'Browser Agents Spawned',
  spawn_claude_code_agent: 'Code Agents Spawned',
  send_sms_as_user: "SMS's Sent",
  deep_research: 'Deep Research Runs',
  find_all: 'Find All Queries',
  enrich: 'Enrichments',
  monitor: 'Monitors Created',
  check_monitor_events: 'Monitor Checks',
  message_person: 'Messages Sent',
  read_message_history_with_person: 'Message Histories Read',
  search_user_network_for_people: 'Network Searches',
  send_message_to_user: 'User Messages',
  wait_seconds: 'Wait Operations',
  set_plan: 'Plans Set',
  query_blueprints: 'Query Blueprints',
  search_x402_bazaar: 'Bazaar Searches',
  pay_for_x402_bazaar_service: 'Bazaar Payments',
  send_message_to_agent: 'Agent Messages Sent',
  list_agents: 'Agent Tree Listings',
  kill_agent: 'Agents Killed',
  report_bug: 'Bugs Reported',
};
