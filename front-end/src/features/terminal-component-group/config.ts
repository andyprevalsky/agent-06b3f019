/**
 * Config for the terminal-component-group domain.
 *
 * Constants, display mappings, and defaults shared across terminal UI components.
 */

/** Backend API base URL (trailing slash stripped). Read once at module load. */
export const API_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(
  /\/$/,
  '',
);

/** Backend API base URL including /api prefix. */
export const API_BASE_WITH_PATH = API_URL.endsWith('/api') ? API_URL : `${API_URL}/api`;

/** ClaudeCodeChip WebSocket retry backoff (ms between attempts). */
export const CLAUDE_CODE_WS_RETRY_DELAYS = [100, 400, 800];
export const CLAUDE_CODE_WS_MAX_RETRIES = 3;

/** Expanded sidebar width in pixels. */
export const SIDEBAR_WIDTH_EXPANDED = 256;

/** Collapsed sidebar width in pixels. */
export const SIDEBAR_WIDTH_COLLAPSED = 64;

/** Poll interval (ms) for refreshing credit usage in the sidebar. */
export const CREDITS_POLL_INTERVAL_MS = 30_000;

/** Auto-close delay (ms) for the feedback sent confirmation. */
export const FEEDBACK_SENT_AUTOCLOSE_MS = 2_000;

/** True in Vite dev mode. Centralized here so components don't read `import.meta.env` directly. */
export const IS_DEV_MODE: boolean = import.meta.env.DEV === true;

/** True when running inside Vitest (vitest sets `import.meta.env.VITEST`). */
export const IS_VITEST: boolean = Boolean(import.meta.env.VITEST);

/** Admin user ID that unlocks dev-only affordances on prod (Andy's account). */
export const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

/** Upper bound for a single attachment (20MB — canonical client-side cap). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default context-restart threshold for the context meter. */
export const DEFAULT_RESTART_THRESHOLD = 100000;

/** Default pending price limit (cents) when no agent is selected. */
export const DEFAULT_PENDING_PRICE_LIMIT_CENTS = 100;

/** Default price limit (cents) falls back to this when an agent has none set. */
export const DEFAULT_AGENT_PRICE_LIMIT_CENTS = 100;

/** Warning threshold (fraction of limit) that flips the cost chip to amber. */
export const COST_WARNING_RATIO = 0.8;

/** Model IDs for the Rose racing endpoints — used for the model-selector descriptions. */
export const ROSE_MODEL_IDS = {
  lite: 'rose-labs/rose-1-lite',
  ultra: 'rose-labs/rose-1-ultra',
} as const;

/** Static descriptions for the built-in Rose models in the model picker. */
export const ROSE_MODEL_DESCRIPTIONS: Record<string, string> = {
  [ROSE_MODEL_IDS.lite]: 'Fast and cost-effective for everyday tasks',
  [ROSE_MODEL_IDS.ultra]: 'Most capable for complex reasoning',
};

/** Tool name to human-readable label mapping (mirrors backend TOOL_DISPLAY_NAMES). */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_search: 'Web Searches',
  spawn_agent: 'Agents Spawned',
  spawn_sub_agent: 'Sub Agents Spawned',
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
};
