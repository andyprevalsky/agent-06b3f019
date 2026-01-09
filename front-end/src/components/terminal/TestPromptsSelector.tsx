import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useState } from 'react';

interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
}

const TEST_PROMPTS: TestPrompt[] = [
  {
    title: 'Test Chat Mode',
    description: 'Tests chat mode web search flow',
    prompt: 'whats the latest news?',
  },
  {
    title: 'Test Browser Agent',
    description: 'Tests browser agent with Amazon shopping task',
    prompt: 'Get me a black beanie < 35$ and well-made',
  },
  {
    title: 'Test Spawn Sub Agents',
    description: 'Tests recursive sub-agent spawning with depth parameter',
    prompt: 'Spawn 2 sub-agents with the same goal as yourself, this is for debugging of the systems max depth parameter. Current Depth Left == 2, when spawning a sub-agent decrease this count by 1. If Depth Left == 0, then output a random integer between 0 - 10. If Depth > 0 then output the multiplication of each sub agent you spawned.',
  },
  {
    title: 'Test Web Search',
    description: 'Tests web search tool with a news query',
    prompt: 'Get me the latest news.',
  },
  {
    title: 'Test Parallel Tool Calls',
    description: 'Tests parallel execution of multiple tools in one turn',
    prompt: 'Do 10 parallel web_searches to get data for the best of each of these items\n1. tomatoe\n2. potatoe\n3. computer\n4. ram\n5. Coding agent\n6. Cities to live in in your 20s\n7. place to vacation\n8. places in austin\n9. Content creators in NYC\n10. Presidents of the world\n\nno questions ask\nstart in agent mode\nno sub agents',
  },
  {
    title: 'Test Claude Code Agent',
    description: 'Tests Claude Code agent in ephemeral E2B sandbox',
    prompt: 'Starting from 27, how many steps does it take to reach 1 in the Collatz sequence? List all the numbers. Use Claude Code and no sub agents',
  },
];

interface TestPromptsSelectorProps {
  onSelectPrompt: (prompt: string) => void;
}

export default function TestPromptsSelector({ onSelectPrompt }: TestPromptsSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleSelectPrompt = (prompt: string) => {
    onSelectPrompt(prompt);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 px-2 py-1 rounded-md border border-border bg-gradient-to-br from-[#FE7503]/5 via-[#E062CC]/5 to-[#7A6BEC]/5 text-muted-foreground text-xs hover:from-[#FE7503]/10 hover:via-[#E062CC]/10 hover:to-[#7A6BEC]/10 transition-colors"
          title="Select a test prompt"
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
        >
          <span className="font-semibold bg-gradient-to-br from-[#FE7503] via-[#E062CC] to-[#7A6BEC] bg-clip-text text-transparent">
            Test-Prompts
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] max-h-[400px] overflow-y-auto p-4 z-50"
        align="start"
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Dev test prompts for tool testing
          </p>
          <div className="space-y-2">
            {TEST_PROMPTS.map((testPrompt) => (
              <button
                key={testPrompt.title}
                className="w-full text-left flex flex-col gap-1 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer"
                onClick={() => handleSelectPrompt(testPrompt.prompt)}
              >
                <span className="font-medium text-sm text-foreground">
                  {testPrompt.title}
                </span>
                <span className="text-xs text-muted-foreground leading-snug">
                  {testPrompt.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
