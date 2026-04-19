import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { X } from 'lucide-react';
import type { Tool } from '../../hooks';

interface ToolPickerProps {
  tools: Tool[];
  selectedTools: string[];
  onToggle: (toolId: string) => void;
}

export function ToolPicker({ tools, selectedTools, onToggle }: ToolPickerProps) {
  return (
    <div className="space-y-2">
      <Label>Tools</Label>
      <div className="flex flex-wrap gap-2">
        {tools.map((tool) => {
          const isSelected = selectedTools.includes(tool.id);
          return (
            <Badge
              key={tool.id}
              variant={isSelected ? 'default' : 'outline'}
              className={`cursor-pointer transition-all ${
                isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'
              }`}
              onClick={() => onToggle(tool.id)}
            >
              {tool.name}
              {isSelected && <X className="h-3 w-3 ml-1" />}
            </Badge>
          );
        })}
      </div>
      {tools.length === 0 && <p className="text-sm text-muted-foreground">Loading tools...</p>}
    </div>
  );
}
