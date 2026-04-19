import { DollarSign } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCentsAsDollars } from './format';

interface LimitInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  currentCostCents: number;
}

export function LimitInput({ value, onChange, disabled, currentCostCents }: LimitInputProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="new-limit">New Price Limit</Label>
      <div className="relative">
        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="new-limit"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.75"
          className="pl-8 font-mono"
          disabled={disabled}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Must be at least {formatCentsAsDollars(currentCostCents)} (current cost)
      </p>
    </div>
  );
}
