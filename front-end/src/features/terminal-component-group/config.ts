/**
 * Config for the terminal-component-group domain.
 *
 * Constants, display mappings, and defaults shared across terminal UI components.
 */

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
