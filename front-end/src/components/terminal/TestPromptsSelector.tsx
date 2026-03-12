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
    title: 'Test Wait For',
    description: 'Tests wait_for with price trigger and phone call action',
    prompt: 'Once bitcoin reaches 72K, call my phone number and tell me.',
  },
  {
    title: 'Test Explore Agent',
    description: 'Tests explore agent with network search, sorting, and external research',
    prompt: 'Get me all VCs I know, sort them by most recently contacted, then find a piece of information about them that you didnt get from my messages. Use Explore Agent',
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
    prompt: `Run a world class fundraising process to close my round by March
- Assume we are starting from 0
- Aman has already done intros, I'm handling those manually
- Pitch deck DocSend link: https://docsend.com/view/kdimuw6dfjf6k3si
- I've attached a list of angels & vcs to contact, it is not comprehensive so please make sure the process is exhaustive
- dont apply to spc or osv grant, that's already done
- I've attached my pitch deck & a list of investors to get started`,
    attachmentUrls: [
      '/test-assets/vcs-and-angels.csv',
      '/test-assets/pitch-deck/rose-labs-pitch-deck.pdf',
    ],
  },
  {
    title: 'Family Office & Angel Outreach',
    description: 'Personalized outreach to 700 angels for ML research feedback calls',
    prompt: `I've attached a CSV of ~700 angels. Get me on a call to chat with as many of the people on this list as possible.

Each message should be personalized, sent from andy@roselabs.ai and be centered around getting feedback about ML research I'm doing in mass agent networks. Here is the blog post I wrote: https://www.roselabs.ai/research/task-decomposer

We need to make sure we run this process with world class persistence, etiquette, and attention to detail. I want to have one sub agent manage each individual relationship, and be responsible for follow-ups, responses, getting them on a call via generating a calendly link on a browser agent etc.

Since you are limited on the sub-agents you can create, you may need to split the file up into chunks which are handed off to each agent which recursively reduce the list down to one agent per person. Chunk it as you see fit.`,
    attachmentUrls: ['/test-assets/vcs-and-angels.csv'],
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
        // Fetch files from the app's public folder.
        // NOTE: test-assets must exist in EACH app's public/ dir.
        // The mac-app symlinks to front-end/public/test-assets.
        // In Electron prod mode (file:// protocol), absolute paths like /test-assets/...
        // resolve to file:///test-assets/... which doesn't exist. Strip leading slash
        // so the path resolves relative to the HTML document (works with base: './').
        const isFileProtocol = window.location.protocol === 'file:';
        files = (await Promise.all(
          testPrompt.attachmentUrls.map(async (assetPath) => {
            const url = isFileProtocol ? assetPath.replace(/^\//, '') : assetPath;
            const response = await fetch(url);
            // Detect Vite SPA fallback (returns index.html for missing files)
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
              console.error(`Test asset ${url} returned HTML — file missing from public/ folder`);
              return null;
            }
            const blob = await response.blob();
            const filename = url.split('/').pop() || 'attachment';
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeByExt: Record<string, string> = {
              jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain',
            };
            const mimeType = (ext && mimeByExt[ext]) || blob.type;
            return new File([blob], filename, { type: mimeType });
          })
        )).filter((f): f is File => f !== null);
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
