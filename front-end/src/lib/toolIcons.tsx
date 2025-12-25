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
  type LucideIcon
} from 'lucide-react';

// x402 brand icon for bazaar tools
import x402Icon from '@/assets/x402-brand-kit/icon/x402-icon-black.png';

// Tools that use the x402 brand icon instead of Lucide
export const X402_TOOLS = ['search_x402_bazaar', 'pay_for_x402_bazaar_service', 'x402'];
export const x402IconSrc = x402Icon;

export function isX402Tool(toolName: string): boolean {
  return X402_TOOLS.includes(toolName);
}

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
  'send_message_to_user': AlertCircle,
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
  'thought': Lightbulb,
  
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
  
  // Browser action_type mappings (from spawn_browser_agent)
  'browser': Globe,  // For browser init messages
  'system': Cog,
  'task_started': Target,
  'thinking': Lightbulb,
  'session_paused': Pause,
  'task_complete': CheckCircle,
  'observation': Eye,
  'extraction': FileText,
  'navigation': Navigation,
  'screenshot': Camera,
  'error': XCircle,
};

/**
 * Get icon for a tool by name.
 * Returns Info icon as fallback if tool not found.
 */
export function getToolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[toolName] || Info;
}




