import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ReasoningEffort } from './types';

const EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'] as const;

interface ReasoningEffortSelectProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

export function ReasoningEffortSelect({ value, onChange }: ReasoningEffortSelectProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="reasoning-effort">Reasoning Effort</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="w-full justify-between bg-background dark:bg-navi-light-black border-border"
          >
            <span className="capitalize">{value}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 bg-card dark:bg-navi-black border-border"
          align="start"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <Command className="bg-transparent">
            <CommandList>
              <CommandGroup>
                {EFFORTS.map((effort) => (
                  <CommandItem
                    key={effort}
                    value={effort}
                    onSelect={() => onChange(effort)}
                    className="cursor-pointer"
                  >
                    <Check
                      className={cn('mr-2 h-4 w-4', value === effort ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className="capitalize">{effort}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
