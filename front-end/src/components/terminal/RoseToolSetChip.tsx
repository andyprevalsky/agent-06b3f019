/**
 * STATE MACHINE: RoseToolSetChip
 *
 * [CLOSED] <-- isOpen: false
 *     |
 *     | (click chip)
 *     v
 * [OPEN] <-- isOpen: true (shows tool list popover)
 *     |
 *     | (click outside or select)
 *     v
 * [CLOSED]
 *
 * State:
 * - isOpen: boolean (popover open state)
 */

import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TOOL_ICONS, isX402Tool, x402IconSrc } from '@/lib/toolIcons';
import { useState } from 'react';
import ClaudeIcon from '@/assets/claude-color.svg';

// Define Rose system tools with descriptions
interface RoseTool {
  name: string;
  displayName: string;
  description: string;
  desktopOnly?: boolean;
  link?: string;
}

const ROSE_SYSTEM_TOOLS: RoseTool[] = [
  {
    name: 'spawn_agent',
    displayName: 'Spawn Agent',
    description: 'Spawn autonomous agents: explore (research), browser (web tasks), code (coding), or sub-agent (complex delegation). Unified tool for all agent types.',
  },
  {
    name: 'x402',
    displayName: 'x402',
    description: 'Rose agents can search for and use any service in the x402 Bazaar to execute a myriad of complex tasks.',
    link: 'https://www.x402.org/ecosystem?category=services-endpoints',
  },
  {
    name: 'claude_code',
    displayName: 'Claude Code',
    description: 'Run Claude CLI on your local machine to write, edit, and analyze code with direct access to your file system.',
    desktopOnly: true,
  },
  {
    name: 'find_all',
    displayName: 'Find All',
    description: 'Discover entities matching criteria using natural language queries.',
  },
  {
    name: 'browser_agent',
    displayName: 'Browser Agent',
    description: 'Complete complex, multi-step web tasks autonomously using AI to navigate and interact.',
  },
  {
    name: 'send_email',
    displayName: 'Email',
    description: 'Send email messages to any email address.',
  },
  {
    name: 'send_sms',
    displayName: 'SMS',
    description: 'Send SMS messages to any phone number.',
  },
  {
    name: 'call_phone_number',
    displayName: 'Call Phone Number',
    description: 'Make phone calls and conduct voice conversations.',
  },
  {
    name: 'enrich',
    displayName: 'Enrich',
    description: 'Enrich entities with structured data using web research.',
  },
  {
    name: 'search_user_network_for_people',
    displayName: 'Personal Network Search',
    description: 'Search your network for people matching specific criteria.',
    desktopOnly: true,
  },
  {
    name: 'web_search',
    displayName: 'Web Search',
    description: 'Search the web for real-time information and answers.',
  },
  {
    name: 'deep_research',
    displayName: 'Deep Research',
    description: 'Comprehensive multi-step research analyzing hundreds of sources.',
  },
  {
    name: 'monitor',
    displayName: 'Monitor',
    description: 'Track the web for material changes relevant to a query on schedule.',
  },
  {
    name: 'send_message_to_user',
    displayName: 'Message User (PLAN)',
    description: 'Share the plan or request clarifications directly from the user.',
  },
  {
    name: 'wait_seconds',
    displayName: 'Wait',
    description: 'Pause execution for a specified number of seconds.',
  },
  {
    name: 'send_sms_as_user',
    displayName: 'Send SMS As User',
    description: 'Send SMS messages through your Mac\'s iMessage account.',
    desktopOnly: true,
  },
];

export default function RoseToolSetChip() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 px-2 py-1 rounded-md border border-border bg-gradient-to-br from-[#FE7503]/5 via-[#E062CC]/5 to-[#7A6BEC]/5 text-muted-foreground text-xs hover:from-[#FE7503]/10 hover:via-[#E062CC]/10 hover:to-[#7A6BEC]/10 transition-colors"
          title="View Rose system tools"
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
        >
          <span className="font-semibold bg-gradient-to-br from-[#FE7503] via-[#E062CC] to-[#7A6BEC] bg-clip-text text-transparent">
            Rose-ToolSet
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[400px] max-h-[500px] overflow-y-auto p-4 z-50" 
        align="start"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Built-in tools available to all Rose agents
          </p>
          <div className="space-y-2">
            {ROSE_SYSTEM_TOOLS.map((tool) => {
            const Icon = TOOL_ICONS[tool.name] || TOOL_ICONS.default;
            return (
              <div
                key={tool.name}
                className="flex gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors"
              >
                <div className="flex-shrink-0 mt-0.5">
                  {isX402Tool(tool.name) ? (
                    <img src={x402IconSrc} alt="x402" className="h-4 w-4 opacity-50 dark:invert dark:opacity-60" />
                  ) : tool.name === 'claude_code' ? (
                    <img src={ClaudeIcon} alt="Claude" className="h-4 w-4" />
                  ) : (
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm text-foreground">
                      {tool.displayName}
                    </span>
                    {tool.desktopOnly && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/5 text-primary font-medium">
                        Desktop Version Only
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground leading-snug mt-0.5">
                    {tool.description}
                  </div>
                  {tool.desktopOnly && (
                    <a
                      href="/download"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2 text-[10px] px-2 py-1 rounded bg-primary/10 hover:bg-primary/20 text-primary font-medium transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Download for Mac
                    </a>
                  )}
                  {tool.link && (
                    <a
                      href={tool.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2 text-[10px] px-2 py-1 rounded bg-gradient-to-r from-[#FE7503]/10 via-[#E062CC]/10 to-[#7A6BEC]/10 hover:from-[#FE7503]/20 hover:via-[#E062CC]/20 hover:to-[#7A6BEC]/20 text-foreground font-medium transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View x402 Ecosystem →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

