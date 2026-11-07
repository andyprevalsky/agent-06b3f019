/**
 * Tool names that can reach the frontend in `metadata.toolName`.
 *
 * This index covers current emitters in `agents/` and `back-end/src/` plus
 * persisted historical tool messages that the frontend still renders. Keep it
 * append-only so old transcripts retain their purpose-built icons.
 */
export const BACKEND_EMITTED_TOOL_NAMES = [
  'add_memory',
  'agent_init',
  'agent_notification',
  'attempt_completion',
  'attempt_completion_with_result',
  'browser_agent',
  'call_phone_number',
  'check_monitor_events',
  'claude_code',
  'claude_code_started',
  'cloud_agent',
  'completion_summary',
  'context_reset',
  'credential_failure_classifier',
  'deep_research',
  'enable_write_permissions',
  'enrich',
  'find_all',
  'grep',
  'kill_agent',
  'list_agents',
  'make_payment',
  'message_person',
  'monitor',
  'pay_for_x402_bazaar_service',
  'people_search',
  'query_blueprints',
  'read_memories',
  'read_message_history_with_person',
  'report_bug',
  'request_user_approval',
  'request_user_assistance_for_authentication',
  'request_user_signup',
  'save_blueprint',
  'search_user_network_for_people',
  'search_x402_bazaar',
  'send_email',
  'send_message_to_agent',
  'send_message_to_user',
  'send_message_to_user_execute_phase',
  'send_sms',
  'send_sms_as_user',
  'set_plan',
  'spawn_agent',
  'spawn_browser_agent',
  'spawn_claude_code_agent',
  'spawn_code_agent',
  'spawn_explore_agent',
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
  'thought',
  'wait_for',
  'wait_seconds',
  'web_fetch',
  'web_search',
  'x402',
] as const;

/**
 * Browser `action_type` values that reach the frontend in
 * `metadata.actionType` from `agents/domains/spawn_browser_agent_v3/`.
 *
 * `ToolMessageIcon` prefers `actionType` over `toolName`, so any value missing
 * from `TOOL_ICONS` renders the generic Info fallback. Two sources feed this
 * list: the browser tool literals in `agents/browser_tools/schemas.py` (plus the
 * `scroll_up`/`scroll_down` split that `build_action_titles` resolves) and the
 * lifecycle `action_type="..."` literals the handler emits directly.
 * Append-only, so historical transcripts keep their icons.
 */
// Action types that announce a live browser session. Single source of truth:
// the terminal panel derivation and the browser status bar both read this, so a
// new init action type cannot be added to one consumer and missed by the other
// (useBrowserStatusBarState previously hardcoded its own list and never cleared
// isDisconnected on a resumed session_init).
export const BROWSER_INIT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'browser',
  'system',
  'session_started',
  'session_init',
]);

export const BROWSER_EMITTED_ACTION_TYPES = [
  'attempt_completion',
  'browser',
  'browser_challenge_recovery',
  'click',
  'click_coordinates',
  'close_tab',
  'credential_propagation',
  'credential_ref',
  'diagnostics',
  'done',
  'dropdown_options',
  'email_send',
  'error',
  'evaluate',
  'extract',
  'generate_write_lock_notification',
  'goto',
  'input_text',
  'navback',
  'network_recording',
  'open_new_tab',
  'payment_card_ready',
  'press_key',
  'purchase',
  'read_logs',
  'read_network_requests',
  'recording',
  'recover_from_challenge',
  'request_payment_card',
  'request_user_assistance_for_authentication',
  'screenshot',
  'scroll_down',
  'scroll_up',
  'select_dropdown',
  'send_message_to_user',
  'session_init',
  'session_paused',
  'session_starting',
  'social_post',
  'supervisor_recovery',
  'switch_tab',
  'system',
  'task_complete',
  'task_started',
  'upload_file',
  'wait',
  'write_lock_granted',
] as const;
