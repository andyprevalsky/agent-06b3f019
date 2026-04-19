import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Sparkles } from 'lucide-react';

interface JudgePromptInputProps {
  value: string;
  onChange: (value: string) => void;
  goal: string;
  isFormatting: boolean;
  onGenerate: () => void;
}

/**
 * Textarea for the LLM-judge prompt with a "Generate from Goal" helper button.
 */
export function JudgePromptInput({
  value,
  onChange,
  goal,
  isFormatting,
  onGenerate,
}: JudgePromptInputProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="llm-prompt">LLM Judge Prompt</Label>
        <Button
          size="sm"
          variant="outline"
          onClick={onGenerate}
          disabled={isFormatting || !goal.trim()}
          className="h-7 text-xs"
        >
          {isFormatting ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3 mr-1" />
              Generate from Goal
            </>
          )}
        </Button>
      </div>
      <Textarea
        id="llm-prompt"
        placeholder="Click 'Generate from Goal' to auto-generate, or enter manually..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[120px] bg-background dark:bg-navi-light-black border-border"
      />
    </div>
  );
}
