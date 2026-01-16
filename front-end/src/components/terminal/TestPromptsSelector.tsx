/**
 * STATE MACHINE: TestPromptsSelector
 *
 * [CLOSED] <-- isOpen: false
 *     |
 *     | (click trigger)
 *     v
 * [OPEN] <-- isOpen: true (shows test prompts popover)
 *     |
 *     | (select prompt or click outside)
 *     v
 * [CLOSED]
 *
 * State:
 * - isOpen: boolean (popover open state)
 *
 * Only visible in development mode.
 */

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
  attachmentUrl?: string; // Optional URL to a file in public folder to attach
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
    title: 'Test People Search',
    description: 'Tests Exa people search tool',
    prompt: 'Use people_search to get me info about Andy Prevalsky',
  },
  {
    title: 'Test Parallel Tool Calls',
    description: 'Tests parallel execution of multiple tools in one turn',
    prompt: 'Do 3 parallel web_searches to get data for the best of each of these items\n1. Cities to live in in your 20s\n2. place to vacation\n3. cheapest cost of living in NA\n\nno questions ask\nstart in execute mode\nno sub agents',
  },
  {
    title: 'Test Claude Code Agent',
    description: 'Tests Claude Code agent in ephemeral E2B sandbox',
    prompt: 'Starting from 27, how many steps does it take to reach 1 in the Collatz sequence? List all the numbers. Use Claude Code and no sub agents',
  },
  {
    title: 'Test DAG Executor',
    description: 'Tests DAG executor with plan mode (no web searches during planning)',
    prompt: 'Do 3 parallel web_searches to get data for the best of each of these items\n1. Cities to live in in your 20s\n2. place to vacation\n3. cheapest cost of living in NA\n\nno questions ask\nstart in plan mode\ndont use any websearches in plan mode\nno sub agents',
  },
  {
    title: 'Test Image Handling',
    description: 'Tests image attachment processing with rs.jpeg',
    prompt: 'make this red',
    attachmentUrl: '/test-assets/rs.jpeg',
  },
  {
    title: 'Test Files in Sub Agents',
    description: 'Tests file_pointer output schema with sub-agents creating color variants',
    prompt: 'turn this file into 4 different color variants, yellow, red, blue, green, use a spawn_sub_agent for each one, no claude code agents in main agent, instruct each sub agent to use claude code to do the color transformation',
    attachmentUrl: '/test-assets/rs.jpeg',
  },
  {
    title: 'Test Files in Browser Agent',
    description: 'Tests browser agent file upload with TinyPNG',
    prompt: 'upload this image to tinypng.com and compress it\n\nno sub agents\nno questions asked',
    attachmentUrl: '/test-assets/rs.jpeg',
  },
];

interface TestPromptsSelectorProps {
  onSelectPrompt: (prompt: string, files?: File[]) => void;
}

export default function TestPromptsSelector({ onSelectPrompt }: TestPromptsSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSelectPrompt = async (testPrompt: TestPrompt) => {
    setIsLoading(true);
    try {
      let files: File[] | undefined;

      if (testPrompt.attachmentUrl) {
        // Fetch the file from public folder and convert to File object
        const response = await fetch(testPrompt.attachmentUrl);
        const blob = await response.blob();
        const filename = testPrompt.attachmentUrl.split('/').pop() || 'attachment';
        const file = new File([blob], filename, { type: blob.type });
        files = [file];
      }

      onSelectPrompt(testPrompt.prompt, files);
    } catch (error) {
      console.error('Failed to load test prompt attachment:', error);
      // Fall back to just the prompt without attachment
      onSelectPrompt(testPrompt.prompt);
    } finally {
      setIsLoading(false);
      setIsOpen(false);
    }
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
                className="w-full text-left flex flex-col gap-1 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer disabled:opacity-50"
                onClick={() => handleSelectPrompt(testPrompt)}
                disabled={isLoading}
              >
                <span className="font-medium text-sm text-foreground">
                  {testPrompt.title}
                  {testPrompt.attachmentUrl && (
                    <span className="ml-2 text-xs text-muted-foreground">📎</span>
                  )}
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
