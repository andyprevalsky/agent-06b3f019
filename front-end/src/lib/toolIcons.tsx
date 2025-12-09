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
  Zap,
  type LucideIcon
} from 'lucide-react';

/**
 * Comprehensive mapping of tool names to Lucide React icons.
 * Used across the app for consistent tool visualization.
 */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  // Main agent tools
  'spawn_browser_agent': Globe,
  'send_sms': MessageSquare,
  'send_sms_as_user': MessageSquare,
  'send_email': Mail,
  'call_phone_number': Phone,
  'request_user_attention': AlertCircle,
  'query_blueprints': BookOpen,
  'save_blueprint': Save,
  'web_search': Search,
  'wait_seconds': Clock,
  'deep_research': FileSearch,
  'spawn_sub_agents': Users,
  'search_user_network_for_people': Users,
  'find_all': FileSearch,
  'enrich': FlaskConical,
  'monitor': Radio,
  'check_monitor_events': ListChecks,
  'claude_code': Code,
  'x402': Zap,
  
  // Browser action sub-types (for spawn_browser_agent internal actions)
  'Agent Reasoning': Lightbulb,
  'Navigation': Navigation,
  'Screenshot': Camera,
  'Click': MousePointer,
  'Visual Feedback': MousePointer,
  'Type': Keyboard,
  'Typing': Keyboard,
  'Scroll': ArrowDown,
  'Step Progress': Play,
  'Performing Action': Settings,
  'Task Complete': CheckCircle,
  'Browser Ready': CheckCircle,
  'Agent Update': Info,
  
  // Action type keywords (used by frontend)
  'target': Target,
  'pin': MapPin,
  'compass': Compass,
  'mouse': MousePointer,
  'keyboard': Keyboard,
  'lightbulb': Lightbulb,
  'camera': Camera,
  'settings': Settings,
  'check': CheckCircle,
  'scroll': ArrowDown,
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  'keypress': Keyboard,
  'action': Settings,
  'default': Info,
};

/**
 * Get icon for a tool by name.
 * Returns Info icon as fallback if tool not found.
 */
export function getToolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[toolName] || Info;
}




