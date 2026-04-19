import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface GoalInputProps {
  goal: string;
  onChange: (value: string) => void;
}

export function GoalInput({ goal, onChange }: GoalInputProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="goal">Goal</Label>
      <Input
        id="goal"
        placeholder="What should this agent accomplish?"
        value={goal}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background dark:bg-navi-light-black border-border"
      />
    </div>
  );
}
