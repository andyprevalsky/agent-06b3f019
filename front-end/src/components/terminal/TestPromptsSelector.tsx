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
    title: 'Test Website Mapping',
    description: 'Tests Claude Code agents rebuilding a website with sub-agents',
    prompt: `recreate https://dallasmmaboxing.com w a modern stack using claude code agents and sub agents
- first understand the content there comprehensively
- secondly, add a additional link to signup for memberships that is hidden at /memberships
- make sure u test your changes as needed`,
  },
  {
    title: 'Raise My Round',
    description: 'Fundraising outreach with VC/angel CSV and application references',
    prompt: `Reach out to every fund / angel / vc on my behalf.
I've also attached a list of angels & vcs to contact, it is not comprehensive though so please make sure the process is exhaustive.

Raising 500k -> 3M
Angels / Family Offices > Tier 1 VCs > Accelerators > Tier 2 VCs, but we should apply to all
Starting from pretty much a cold start, although Aman & Aadi have mentioned they have warm intros to some people who are potentially interested
Trying to close by end of feb

=== REFERENCE MATERIALS ===
https://roselabs.ai/research

=== REFERENCE: SPC APPLICATION ===

What is your financing history to date?
Haven't raised yet

About the Founders
Share the most impressive personal or professional accomplishment for each founder.
Andy: Built out Hotplate.com (YC S20, backed by Michael Seibel and a16z GP Connie Chan), found PMF in our niche market, led product, distribution, and strategy, company is now generating 5M ARR, highly profitable, and growing steadily and organically.
Aadi: Bootstrapped Apex Labs - ML tooling for foreign federal governments to detect corporate tax evasion; built a deep learning mini-version of Palantir. Recruited, interviewed, and managed a data science team; scaled the team from zero to eight engineers. Managed pilot program which green-lit a large pending contract with federal agencies.

What is the riskiest decision each of you have made?
Andy: Renegged my Meta AI internship to go full time on my company Hotplate (YC S20)
Aadi: Dropped out of medical school (where I was on track to be a neurosurgeon) to go 100% on my dream of building a massive startup

Who are three people you would recruit regardless of what you do? What makes them special?
Daniel Reynaud - https://www.linkedin.com/in/danielreynaud/
Built lightweight formal methods, and mid-level compiler passes on LLVM and C++. Currently a member of technical staff at OpenAI.
Henry Williams - https://www.linkedin.com/in/henwilliams/
The best executor I have met, routinely puts in 16 hour work days at top notch speeds and is extremely well connected.
Willie Abu - https://www.linkedin.com/in/willie-aboumrad/
Aadi's prior employee at Apex, focused on topological quantum computing. One of the smartest people I've ever worked with.

Ideas
List out the specific idea(s) / area(s) you are interested in. Rank them in order of interest.
1. Consumer Super-intelligence via Mass Agent Networks (MANs)
2. A geospatial foundation model (this can allow for more accurate OpenDoor, Nuclear powerplant positioning algorithms and multi-planetary inhabitation frameworks)
3. Stripe for Ai Agents, focused on real-time proprietary data exchange

Which idea from the list above would you be able to share more about?
A system that can take in long-term user goals and drive them to completion via MANs. OAI is leaving a massive gap here as they move up stream to GPU creation & Enterprise Customers, Anthropic is too focused on e2e code automation, Meta doesn't have the necessary consumer trust, Google is focused on continual learning, world models, and AGI through pre & post training. There is also a massive gap between what is technologically possible today, and what consumers are given. It is technologically feasible to have agents complete long-term, open-ended tasks autonomously, but there is no product on the market today which satisfies that. MANs are the solution because they maximally decompose user tasks, which minimizes context needed per agent and enables the effective parallelization of work. The question of how to maintain AI memory is also elegantly solved. Run-time memory is maintained via the state of the network, and because each agent is decomposed according to the same type of prompt (a goal), RAG systems are perfect to serve as the memory layer where they would otherwise perform poorly.

(Optional) If you are applying with the same ideas from a previous application, did anything change?
Andy previously applied with an application on creating artificial life. Since then, he has found a stellar cofounder, Aadi, that compliments his skillsets and he loves working with. The team has pivoted away from a physical-first approach to creating artificial life, and focused instead on creating a 10x better autonomous agent via MANs.

(Optional) If none of your current ideas or explorations work out, are there others you would consider?
Blind auction block-building for Ethereum blocks
Stripe for AI Agents, agent payment layer for the internet
AI Codecs that reduce bandwidth cost for video & audio streaming by 10x
Decentralized network of stablecoin issuance

=== REFERENCE: OSV APPLICATION ===

Name: Andy Prevalsky
Email: andy@roselabs.ai
Location: San Francisco, United States

How would you best describe yourself?
Generalist, Self-employed

Where can we find you online?
https://roselabs.ai
https://linkedin.com/in/andyprevalsky

1) List 3 of your most exceptional achievements
1. Dropped out of College to create my first business, hotplate.com, which is now generating $5M in ARR
2. 4.0 GPA on the two hardest majors in UT Austin, Electrical Engineering & Math
3. Internships at Google & Meta AI

2) What will you work on if you were accepted to the program?
Super Intelligence for everyone

Hours per week you plan to devote to the project: 80

3) Why are you the best person in the world to work on this?
I have come up with a novel architecture for creating super intelligence which comes from recursive task decomposition. Almost any problem can be decomposed into sub-problems, and I've trained a specific SOTA decomposer model that can take a problem and decompose it into 2-4 independent sub-goals. These sub-goals are context independent and parallelizable, the process is repeated recursively until a single problem is decomposed into 100-10000 sub problems that all can be executed, in parallel, by my AI system. This innovation accounts for the transition of AI systems from unicellular organisms -> massively multi-cellular organisms, a massive evolutionary leap in the field.

4) Pitch video: https://www.loom.com/share/44b80d820451453191e5c4fe07938449

5) If selected, what will success look like once the fellowship period ends?
Success would look like building an AI system that can accomplish 50% > of user requests, the gross majority of people are drowning in problems, and a system that could do this would alleviate a massive amount of pain in the world.

Beyond my wildest dreams, this would look like the birth of super intelligence, and a hard fork in the world from which humanity is no longer subject to deep, unecessary, tragedy.

6) What might failure look like? What could be some of the original mistakes of your project?
Failure would like
- hallucinations compounding
- the AI having structural limitations due to its lack of human identity, and thus can't make meaningful change in the world
- a lack of a physical body being too large of a limitation
- government shutdown

Some mistakes could include, error drift compounding as goals get decomposed, the AI accomplishing the goal in a way that is not preferable to the end user, or this AI system being too powerful and it gets shut down because of its geopolitical implications.

8) Describe something that you find beautiful in the world.
One of the things I find most beautiful in this world is the fractal nature of life itself. From the rhythms of tiniest microbial, to the ebbs and flows of the planets and stars that govern us. The structure which defines life's pushes and pulls from chaos and order are mirrored. This story is displayed in all its different angles in so many things, the climax of a symphony, the movement in a Picasso painting, the story of ones life... this complexity is utterly beautiful to me.

=== 4 MONTH ACTION PLAN ===
January -> 10K
- Complete a semi-functional version of super intelligence that can accomplish a set of low complexity, long time-horizon, high value tasks.
-- Get me refunds on all my subscriptions
-- Apply to every grant & accelerator in NA
-- Find me all the emails of customers in X demographic
- Launch the product for public use

February -> 10K
- Refine the product with 10-20 design partners to even out the rough edges of the product, get the product to the point where 10 people LOVE it, and are using it as their main AI system on a daily basis
- Get Rose Labs to be able to handle fundraising for the project (emailing, follow-ups, writing in my voice)

March -> 20K
- Hire our first engineers
- Create novel benchmarks for task decomposition
- Set up a repeatable experimentation system that makes running experiments to improve our model quick and easy, akin to how Renaissance Technologies built a system to allow quants to rapidly experiment (the key to their insane investment returns)
- Get to 100 people that love the product

April -> 30K
- At 100 people that love the product, the system starts to reach a phase transition, where the product grows exponentially and organically. Most of the work in this month will be in ensuring that the entire company can scale efficiently.
- Build out a robust system for ensuring that the super intelligence can operate safely and in alignment with user intention.`,
    attachmentUrl: '/test-assets/vcs-and-angels.csv',
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
