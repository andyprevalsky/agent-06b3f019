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
  attachmentUrls?: string[]; // Optional URLs to files in public folder to attach
}

const TEST_PROMPTS: TestPrompt[] = [
  {
    title: 'Test Automatic LinkedIn Connection',
    description: 'Tests browser agent with LinkedIn data download',
    prompt: 'go to linkedin.com and trigger a download for my data',
  },
  {
    title: 'Test Chat Mode',
    description: 'Tests chat mode web search flow',
    prompt: 'whats the latest news?',
  },
  {
    title: 'Test Browser Agent',
    description: 'Tests browser agent with Amazon shopping task',
    prompt: 'Buy me any black carhartt beanie < 35$ and well-made from amazon\nNo questions asked',
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
    attachmentUrls: ['/test-assets/rs.jpeg'],
  },
  {
    title: 'Test Files in Sub Agents',
    description: 'Tests file_pointer output schema with sub-agents creating color variants',
    prompt: 'turn this file into 4 different color variants, yellow, red, blue, green, use a spawn_sub_agent for each one, no claude code agents in main agent, instruct each sub agent to use claude code to do the color transformation',
    attachmentUrls: ['/test-assets/rs.jpeg'],
  },
  {
    title: 'Test Files in Browser Agent',
    description: 'Tests browser agent file upload with TinyPNG',
    prompt: 'upload this image to tinypng.com and compress it\n\nno sub agents\nno questions asked',
    attachmentUrls: ['/test-assets/rs.jpeg'],
  },
  {
    title: 'Test Code Gen',
    description: 'Tests Claude Code with GitHub repo cloning - Dallas MMA Boxing site rebuild',
    prompt: `Understand the entire structure of https://dallasmmaboxing.com
This is my Dad's old website.
But it needs a full revamp.

I've initialized a github repo that your claude code agents can use
https://github.com/andyprevalsky/dallasmmaboxing
-> pass this link to all claude code agents

Rebuild the site in a modern stack with
-> React
-> Vercel
-> Render for BE
-> Stripe

The site should contain the exact same content, the exact same structure, but the styling should be updated to feel refined, high-quality, modern, cohesive, responsive, and trustworthy.

We will add one additional feature which will be a checkout option
The checkout will be on a hidden url that is givin via QR Code in the gym
Clients will
1. select the classes that they want to attend
2. sign a release form
3. be directed to stripe to complete payment
4. once payment is completed we will create a new row in the database that details the clients information, a link to their signed form, we wil text 972-977-5605 and send georgeprevalsky@gmail.com (and the user email and sms) a link to a confirmation page that will contain their confirmation page + a link to their signed released form

For any services that require a API Key or Credential, mock the service for now and then return back to me a list of API keys I need to give to you in order to finish the implementation.`,
  },
  {
    title: 'Test Call Phone Number',
    description: 'Tests phone call tool with Vapi voice AI',
    prompt: 'Call Billy @ 1-972-977-7432, get his full name and the time he will be arriving for the Rose Labs Party on Sunday. This is for debugging purposes.',
  },
  {
    title: 'Test Event Planning',
    description: 'Tests coordination of event planning with budget constraints',
    prompt: 'I want to play volleyball with some friends this weekend in san francisco.\nCan you figure out who would be down and coordinate the space & procurment of equipment?\nEnsure its less then 30$ total',
  },
  {
    title: 'Test Message Person',
    description: 'Tests unified message_person tool with email and iMessage channels',
    prompt: "Send an email and a imessage to myself, 972-977-7432, for testing purposes, don't ask any questions. The message should try to get me to launch this product.",
  },
  {
    title: 'Test Website Mapping',
    description: 'Tests Claude Code agents rebuilding a website with sub-agents',
    prompt: `recreate https://dallasmmaboxing.com w a modern stack using claude code agents and sub agents
- first understand the content there comprehensively
- secondly, add a additional link to signup for memberships that is hidden at /memberships
- make sure u test your changes as needed`,
  },
  {
    title: 'Raise My Round',
    description: 'Fundraising outreach with pitch deck and VC/angel CSV',
    prompt: `Reach out to every fund / angel / vc on my behalf

Sourcing
1. I've attached a list of angels & vcs to contact, it is not comprehensive though so please make sure the process is exhaustive. Identify which angels I already have an existing relationship with & which we will reach out cold.
For cold outreach, send a linkedin message & an email to each contact you find

Raising 1.5M @ 10M post-money cap
Angels / Family Offices > Tier 1 VCs > Accelerators > Tier 2 VCs, but we should apply to all
Close by end of march

=== REFERENCE MATERIALS ===
https://www.roselabs.ai/research/task-decomposer
I've also attached our pitch deck, which you should upload for every relevant application.
Pitch deck DocSend link: https://docsend.com/view/kdimuw6dfjf6k3si

for cold outreach create a template based off this post by Race Capital

 • Clarity under compression - Explain the problem, why now, and your wedge in 2 minutes. No buzzwords.
 • Learning velocity - What did you believe 30 days ago that you've already changed your mind about?

That's how I decide whether to lead or not. If you're cold-emailing VCs, skip "would love to chat."

Send investors five bullets instead:

 • what changed in the stack
 • what became possible
 • who feels the pain first
 • what you ship in 30 days -> task completions with rapidly increasing task complexity
 • why this team wins -> Super-intelligence requires massive persistent compute to keep agent networks alive. Anthropic and OAI are already hitting compute ceilings serving their existing customer base (stateless API calls, code gen). They can't fast-follow into always-on autonomous agents because the constraint is physical (GPU supply), not technical. Brand optics also limit them — Anthropic can't be the company autonomously emailing and messaging on your behalf. Rose Labs is the credible third party built on top of existing model providers — we freely switch and specialize LLMs per task, and our entire architecture is purpose-built for long-running stateful agent compute, not stateless request-response. The race is: can we specialize super-intelligence to automate end-to-end verticals before incumbents solve their compute constraints? Because of those constraints and brand limitations, they can't eat everything — at best they build one in-house system, not a platform.

Don't reapply to SPC or OSV (already submitted), but use previous application data as reference.`,
    attachmentUrls: [
      '/test-assets/vcs-and-angels.csv',
      '/test-assets/pitch-deck/rose-labs-pitch-deck.pdf',
    ],
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

      if (testPrompt.attachmentUrls && testPrompt.attachmentUrls.length > 0) {
        // Fetch files from Vite dev server's public folder
        // Use absolute URL to port 8080 since browser may be on a different origin (e.g. Conductor proxy)
        const viteBase = 'http://localhost:8080';
        files = await Promise.all(
          testPrompt.attachmentUrls.map(async (url) => {
            const response = await fetch(`${viteBase}${url}`);
            const blob = await response.blob();
            const filename = url.split('/').pop() || 'attachment';
            // Infer mime type from extension — blob.type can be wrong if
            // Vite's SPA fallback serves index.html instead of the actual file
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeByExt: Record<string, string> = {
              jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain',
            };
            const mimeType = (ext && mimeByExt[ext]) || blob.type;
            return new File([blob], filename, { type: mimeType });
          })
        );
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
                  {testPrompt.attachmentUrls && testPrompt.attachmentUrls.length > 0 && (
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
