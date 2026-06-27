import {
  Globe,
  MessageSquare,
  AlertCircle,
  BookOpen,
  Save,
  Search,
  Clock,
  FileSearch,
  Users,
  Lightbulb,
  Navigation,
  Camera,
  MousePointer,
  Keyboard,
  ArrowDown,
  ArrowUp,
  Play,
  Settings,
  Info,
  CheckCircle,
  Target,
  MapPin,
  Compass,
  FlaskConical,
  Radio,
  ListChecks,
  Mail,
  Phone,
  Code,
  Eye,
  FileText,
  Pause,
  XCircle,
  Cog,
  Layers,
  X,
  Plus,
  Terminal,
  Brain,
  FileEdit,
  Upload,
  RefreshCw,
  Cloud,
  LifeBuoy,
  type LucideIcon,
} from 'lucide-react';

// x402 brand icon for bazaar tools
import x402Icon from '@/assets/x402-brand-kit/icon/x402-icon-black.png';

// Claude Code icon
import claudeIcon from '@/assets/claude-color.svg';

// Tools that use the x402 brand icon instead of Lucide
export const X402_TOOLS = ['search_x402_bazaar', 'pay_for_x402_bazaar_service', 'x402'];
export const x402IconSrc = x402Icon;

// Tools that use the Claude icon instead of Lucide
export const CLAUDE_CODE_TOOLS = ['spawn_claude_code_agent', 'claude_code_started'];
export const claudeCodeIconSrc = claudeIcon;

export function isX402Tool(toolName: string): boolean {
  return X402_TOOLS.includes(toolName);
}

export function isClaudeCodeTool(toolName: string): boolean {
  return CLAUDE_CODE_TOOLS.includes(toolName);
}

/**
 * Comprehensive mapping of tool names to Lucide React icons.
 * Used across the app for consistent tool visualization.
 */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  // Main agent tools
  spawn_agent: Search, // Unified agent tool (explore/browser/code/general_purpose)
  grep: FileSearch, // Local data search (message threads)
  browser_agent: Globe,
  spawn_browser_agent: Globe,
  send_sms: MessageSquare,
  send_sms_as_user: MessageSquare,
  send_email: Mail,
  call_phone_number: Phone,
  send_message_to_user: AlertCircle,
  request_user_assistance_for_authentication: LifeBuoy,
  query_blueprints: BookOpen,
  save_blueprint: Save,
  web_search: Search,
  web_fetch: Globe,
  wait_for: Clock,
  wait_seconds: Clock,
  deep_research: FileSearch,
  people_search: Users,
  spawn_general_purpose_agent: Users,
  spawn_general_purpose_agent_for_each: Users,
  spawn_sub_agent: Users,
  search_user_network_for_people: Users,
  find_all: FileSearch,
  enrich: FlaskConical,
  monitor: Radio,
  check_monitor_events: ListChecks,
  claude_code: Code,
  thought: Lightbulb,
  cloud_agent: Cloud,

  // Browser action sub-types (for spawn_browser_agent internal actions)
  'Agent Reasoning': Lightbulb,
  Navigation: Navigation,
  Screenshot: Camera,
  Click: MousePointer,
  'Visual Feedback': MousePointer,
  Type: Keyboard,
  Typing: Keyboard,
  Scroll: ArrowDown,
  'Step Progress': Play,
  'Performing Action': Settings,
  'Task Complete': CheckCircle,
  'Browser Ready': CheckCircle,
  'Agent Update': Info,

  // Action type keywords (used by frontend)
  target: Target,
  pin: MapPin,
  compass: Compass,
  mouse: MousePointer,
  keyboard: Keyboard,
  lightbulb: Lightbulb,
  camera: Camera,
  settings: Settings,
  check: CheckCircle,
  scroll: ArrowDown,
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  keypress: Keyboard,
  action: Settings,
  default: Info,

  // Browser action_type mappings (from spawn_browser_agent)
  browser: Globe, // For browser init messages
  system: Cog,
  task_started: Target,
  thinking: Lightbulb,
  session_paused: Pause,
  task_complete: CheckCircle,
  observation: Eye,
  extraction: FileText,
  navigation: Navigation,
  screenshot: Camera,
  error: XCircle,

  // Browser action names (used as action_type from spawn_browser_agent_v3)
  click: MousePointer,
  click_coordinates: MousePointer,
  input_text: Keyboard,
  type_text: Keyboard,
  press_key: Keyboard,
  scroll_up: ArrowUp,
  scroll_down: ArrowDown,
  goto: Navigation,
  navback: Navigation,
  wait: Clock,
  extract: FileText,
  evaluate: Code,
  dropdown_options: ListChecks,
  select_dropdown: ListChecks,
  done: CheckCircle,
  attempt_completion: CheckCircle,
  auth_assistance: LifeBuoy,

  // Tab management tools
  switch_tab: Layers,
  close_tab: X,
  open_new_tab: Plus,

  // File upload
  upload_file: Upload,

  // Claude Code action_type mappings (from spawn_claude_code_agent)
  spawn_claude_code_agent: Terminal,
  claude_code_started: Terminal,
  agent_observation: Eye,
  agent_decision: Brain,
  agent_intervention: Brain,
  code_read_file: FileText,
  code_write_file: FileEdit,
  code_bash: Terminal,
  code_thinking: Brain,

  // Memory tools (SuperMemory)
  add_memory: Save,
  read_memories: BookOpen,

  // Context management
  context_reset: RefreshCw,
};

/**
 * Prefix patterns for display strings -> icon mapping.
 * Used when toolsInUse contains formatted display strings like "Searching the web for..."
 */
const DISPLAY_PREFIX_ICONS: [string, LucideIcon][] = [
  ['Searching the web', Search],
  ['Fetching web content', Globe],
  ['Extracting from', Globe],
  ['Searching for people', Users],
  ['Browsing the web', Globe],
  ['Delegating', Users],
  ['Researching', FileSearch],
  ['Exploring', Search],
  ['Waiting', Clock],
  ['Messaging', MessageSquare],
  ['Sending SMS', MessageSquare],
  ['Searching contacts', Users],
  ['Finding all', FileSearch],
  ['Enriching', FlaskConical],
  ['Monitoring', Radio],
  ['Checking monitor', ListChecks],
  ['Reading messages', MessageSquare],
  ['Planning', Lightbulb],
  ['Completing', CheckCircle],
  ['Searching bazaar', Search],
  ['Paying for', CheckCircle],
  ['Requesting signup', AlertCircle],
  ['Uploading', Upload],
  ['Saving memory', Save],
  ['Reading memories', BookOpen],
];

/**
 * Get icon for a tool by name or display string.
 * Supports both raw tool names (e.g., "web_search") and formatted display strings
 * (e.g., "Searching the web for hotels").
 * Returns Info icon as fallback if not found.
 */
export function getToolIcon(toolName: string): LucideIcon {
  // First try exact match
  if (TOOL_ICONS[toolName]) {
    return TOOL_ICONS[toolName];
  }

  // Then try prefix matching for display strings
  for (const [prefix, icon] of DISPLAY_PREFIX_ICONS) {
    if (toolName.startsWith(prefix)) {
      return icon;
    }
  }

  return Info;
}
