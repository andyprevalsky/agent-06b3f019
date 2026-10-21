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
 * - trigger is icon-only; text remains in title/aria-label for accessibility
 * - variant 'pinned' (Rose Desktop: pinned top-left inside the query box) =
 *   the same chip with the light border fixed to rgb(222,222,227), so it
 *   looks identical in light and dark mode (no dark: variants, no theme vars)
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TOOL_ICONS } from '@/lib/toolIcons';
import { Wrench } from 'lucide-react';
import { useState } from 'react';
import ClaudeIcon from '@/assets/claude-color.svg';
import CodexIcon from '@/assets/codex-color.svg';

interface RoseTool {
  name: string;
  displayName: string;
  description: string;
  desktopOnly?: boolean;
}

const ROSE_SYSTEM_TOOLS: RoseTool[] = [
  {
    name: 'spawn_agent',
    displayName: 'Spawn Cloud Agent',
    description:
      'Spawn autonomous agents into their own persistent, fault-tolerant cloud environment. Each agent can live for years at a time and wields the full tool suite to solve problems of unbounded complexity.',
  },
  {
    name: 'claude_code',
    displayName: 'Coding Agent',
    description:
      'Write, edit, and run code in a secure, isolated E2B cloud container with a Claude or Codex agent, with full file-system access for building, debugging, and automating real engineering work.',
  },
  {
    name: 'browser_agent',
    displayName: 'Stealth Browser Agent',
    description:
      'Complete complex, multi-step web tasks autonomously with a fully humanized, undetectable browser. Mimics real human behavior to evade bot detection and solve CAPTCHAs.',
  },
  {
    name: 'make_payment',
    displayName: 'Payment Enabled',
    description:
      'Pay any online service or merchant on your behalf. Each agent is issued an ephemeral, single-use virtual card per payment, so your real card details are never exposed and every transaction is capped and isolated.',
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
    name: 'search_user_network_for_people',
    displayName: 'People Search',
    description: 'Find any person for any criteria.',
  },
  {
    name: 'web_search',
    displayName: 'Web Search',
    description: 'Search the web for real-time information and answers.',
  },
  {
    name: 'wait_for',
    displayName: 'Wait For',
    description:
      'Pause until a timestamp or repeatedly check a natural-language condition with explore agents.',
  },
];

function ToolIcon({ name }: { name: string }) {
  if (name === 'claude_code') {
    // Coding Agent: Claude logo stacked above a Codex logo, in their normal colors.
    return (
      <span className="inline-flex flex-col gap-1" aria-label="Claude or Codex">
        <img src={ClaudeIcon} alt="Claude" className="h-4 w-4" />
        <img src={CodexIcon} alt="Codex" className="h-4 w-4" />
      </span>
    );
  }
  const Icon = TOOL_ICONS[name] || TOOL_ICONS.default;
  return <Icon className="h-4 w-4 text-muted-foreground" />;
}

function ToolRow({ tool }: { tool: RoseTool }) {
  return (
    <div className="flex gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors">
      <div className="flex-shrink-0 mt-0.5">
        <ToolIcon name={tool.name} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-medium text-sm text-foreground">{tool.displayName}</span>
          {tool.desktopOnly && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/5 text-primary font-medium">
              Desktop Version Only
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground leading-snug mt-0.5">{tool.description}</div>
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
      </div>
    </div>
  );
}

const CHIP_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-[#fff6fc] bg-gradient-to-br from-[#FE7503]/5 via-[#E062CC]/5 to-[#7A6BEC]/5 text-[#E062CC] hover:from-[#FE7503]/10 hover:via-[#E062CC]/10 hover:to-[#7A6BEC]/10 transition-colors';

/** Same chip with the light `--border` (hsl(240 8% 88%)) fixed, so dark mode cannot restyle it. */
const PINNED_CHIP_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(222,222,227)] bg-[#fff6fc] bg-gradient-to-br from-[#FE7503]/5 via-[#E062CC]/5 to-[#7A6BEC]/5 text-[#E062CC] hover:from-[#FE7503]/10 hover:via-[#E062CC]/10 hover:to-[#7A6BEC]/10 transition-colors';

export default function RoseToolSetChip({ variant = 'chip' }: { variant?: 'chip' | 'pinned' }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={variant === 'pinned' ? PINNED_CHIP_CLASS : CHIP_CLASS}
          data-testid={variant === 'pinned' ? 'pinned-toolset-chip' : undefined}
          title="View Rose system tools"
          aria-label="View Rose system tools"
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
        >
          <Wrench className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(400px,calc(100vw-32px))] max-h-[500px] overflow-y-auto p-4 z-50"
        align="start"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Built-in tools available to all Rose agents
          </p>
          <div className="space-y-2">
            {ROSE_SYSTEM_TOOLS.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
