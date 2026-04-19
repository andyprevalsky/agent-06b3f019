import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { Model } from '../../hooks';

interface ModelSelectProps {
  models: Model[];
  selectedModel: string;
  onChange: (modelId: string) => void;
}

export function ModelSelect({ models, selectedModel, onChange }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const activeModel = models.find((m) => m.id === selectedModel);
  const triggerLabel = `${activeModel?.provider || 'Unknown'}/${activeModel?.name || 'Select model...'}`;

  const filtered = models.filter(
    (m) =>
      search === '' ||
      `${m.provider}/${m.name}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      <Label htmlFor="model">Model</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between bg-background dark:bg-navi-light-black border-border"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 bg-card dark:bg-navi-black border-border"
          align="start"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <Command className="bg-transparent">
            <CommandInput
              placeholder="Search models..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList className="max-h-64">
              <CommandEmpty>No model found.</CommandEmpty>
              <CommandGroup>
                {filtered.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    isSelected={selectedModel === model.id}
                    onSelect={() => {
                      onChange(model.id);
                      setOpen(false);
                      setSearch('');
                    }}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ModelRow({
  model,
  isSelected,
  onSelect,
}: {
  model: Model;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const priceText = formatPriceRange(model.pricing?.prompt, model.pricing?.completion);
  return (
    <CommandItem
      value={`${model.provider}/${model.name}`}
      onSelect={onSelect}
      className="cursor-pointer"
    >
      <Check className={cn('mr-2 h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <span className="truncate">
          {model.provider}/{model.name}
        </span>
        {priceText && (
          <span className="text-[10px] text-muted-foreground truncate">{priceText}</span>
        )}
      </div>
    </CommandItem>
  );
}

function formatPriceRange(prompt: string | undefined, completion: string | undefined): string {
  const input = formatPrice(prompt);
  const output = formatPrice(completion);
  return input && output ? `${input} in · ${output} out` : '';
}

function formatPrice(price?: string): string | null {
  if (!price) return null;
  const num = parseFloat(price);
  if (num === 0) return 'FREE';
  return `$${(num * 1000000).toFixed(2)}/M`;
}
