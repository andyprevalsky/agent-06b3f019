import { HelpCircle } from 'lucide-react';
import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * "$199 + service fee" trigger that opens a popover on hover explaining
 * the AI-provider fee model. One instance per variant card (keeps its
 * own open state so the two cards are independent).
 */
export default function ServiceFeePopover() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="text-sm text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          service fee
          <HelpCircle size={12} />
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="max-w-xs bg-background border shadow-md"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="text-sm">
          <p className="font-medium mb-2">AI Provider Services</p>
          <p className="mb-2">
            All Navi devices require AI provider services. You have two options:
          </p>
          <div className="space-y-2">
            <div>
              <p className="font-medium">Provide Your Own API Keys</p>
              <p className="text-xs opacity-80">
                Use your existing OpenAI, Anthropic, or other provider accounts
              </p>
            </div>
            <div>
              <p className="font-medium">Pay-as-You-Go Service</p>
              <p className="text-xs opacity-80">We handle everything at cost with no markup</p>
            </div>
          </div>
          <p className="text-xs opacity-60 mt-2">
            Service charges cover AI provider costs only. We don't profit from this component.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
