export type BlogCategory = 'research' | 'product' | 'company';

export interface BlogSection {
  id: string;
  title: string;
  content: string;
}

export interface BlogImage {
  src: string;
  alt: string;
  caption?: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  category: BlogCategory;
  date: string;
  author: string;
  intro: string;
  sections: BlogSection[];
  images?: BlogImage[];
}

export const blogPosts: BlogPost[] = [
  {
    slug: 'tool-orchestrator',
    title: 'Building a generalized tool orchestrator for real world, long-horizon tasks',
    description: 'How we built a flexible tool orchestration layer that enables agents to complete complex, multi-step tasks across diverse domains.',
    category: 'research',
    date: '2026-02-04',
    author: 'Andy Prevalsky',
    intro: `The birth of personal assistants that take action in the world has begun, and soon everyone will have an AI system that does the majority of intelligence related work for them. However, these agentic systems still fail to perform well on long-horizon problems in practical settings for 3 main reasons: context overflow, cost prohibition & complexity explosion. This post aims to describe our efforts in solving these 3 problems by creating a generalized tool orchestrator that recursively decomposes tasks into a set of context-independent, parallelizable, and proximate sub tasks that each fit into the current complexity requirements for modern day agentic systems.`,
    sections: [
      {
        id: 'why-tool-orchestration',
        title: 'Why Tool Orchestration is the bottleneck for general-use Super Intelligence',
        content: `Super-Intelligence, as we will know it in 10-20 years, will be a system that can achieve any goal the user asks of it, with the lowest energy cost possible, barring it doesn't violate existing structural constraints (laws of physics, geopolitical boundaries, user preferences etc). The most difficult of which are long-horizon tasks that may take weeks, months, or maybe in some cases years to resolve.

These long-horizon tasks fail to resolve with modern agentic systems because shallow agent networks quickly exhaust their context-window, fail to complete the task in a reasonable amount of time, and often cost the end user much more than it would take to complete the task themselves.

However, if we take a complex, long-horizon problem <em>P</em>, and are able to decompose it into a set of sub-problems <em>P<sub>i</sub>, …, P<sub>j</sub></em> such that

the complexity of <em>P<sub>n</sub></em> &lt; <em>P</em> and the completion of <em>P<sub>i</sub>, …, P<sub>j</sub></em>
the completion of <em>P<sub>i</sub>, …, P<sub>j</sub></em> == the completion of <em>P</em>

then in theory we could recursively reduce <em>P</em> to a set of proximate problems that are independently solvable by modern day LLMs. And in this simple formula it becomes clear that the complexity of creating Super Intelligence, a system that can solve any user problem <em>P</em>, is equal to the complexity of creating a general purpose tool orchestrator that can satisfy our lemma.

You may say, wait a minute, what if a problem <em>P</em> is NOT decomposable at all? From our experience, almost ALL problems are decomposable in some may except for fringe problems in mathematics.`
      },
      {
        id: 'landscape',
        title: 'The Landscape of Tool Orchestrators',
        content: `We see the industry is already making large efforts to tackle the challenge of solving long-horizon problems in a similar way.

<a href="https://cursor.com/blog/scaling-agents" target="_blank" rel="noopener noreferrer">Cursor | Scaling long-running autonomous coding</a>
Cursor makes the assumption that planning ahead is too rigid for large projects, or in other words, the complexity of the decomposition problem itself, is too large for modern LLMs, and thus attempts to solve long-horizon tests by approximating the correct solution over time via decentralized tool orchestration. This approach has its benefits, namely each new generation of agents can fix hallucinations of their ancestors, and the problem of compounding errors in recursive decomposition is minimized. However, it avoids the hard problem here which is that without a strong verifier, the system stabilizes to a broken version.

<a href="https://arxiv.org/pdf/2511.21689" target="_blank" rel="noopener noreferrer">Nvidia | Elevating Intelligence via Efficient Model and Tool Orchestration</a>
Here Nvidia builds a general Tool Orchestrator (8 billion parameters) that beats frontier large models on Humanities Last Exam, FRAMEs, and T² Bench with a fraction of the number of steps and at much lower costs. Notably, they mention they "envision [a] more sophisticated recursive orchestrator systems to push the upper bound of intelligence but also to further enhance efficiency in solving increasingly complex agentic tasks".

<a href="https://arxiv.org/pdf/2602.01848" target="_blank" rel="noopener noreferrer">ROMA | Recursive Open Meta-Agent Framework for Long-Horizon Multi-Agent Systems</a>
ROMA shows that recursive decomposition is SOTA across a multitude of highly complex reasoning tasks.

<a href="https://www.kimi.com/blog/kimi-k2-5.html" target="_blank" rel="noopener noreferrer">Kimi 2.5 | Swarm</a>
Kimi shows how as task complexity increases, execution time increases linear with swarms as opposed to exponentially with a single agent system.

<a href="https://ensue.dev/blog/stop-throwing-a-single-agent-at-complex-problems/" target="_blank" rel="noopener noreferrer">Ensue | Stop Throwing A Single Agent At Complex Problems</a>
Shows how recursive decomposition can extend LLM capabilities to new SOTA levels for math work.`
      },
      {
        id: 'whats-missing',
        title: "What's Missing",
        content: `The groundwork for how to create a generalized recursive tool orchestrator has been laid out, but so far, nobody has applied this orchestrator to real-world user tasks in a system that has the necessary suite of tools to take action in the real world. Additionally, the question of whether the complexity of the general purpose decomposer is within reach, has not been rigorously evaluated.

2. In practical settings, it is often best to attempt multiple approaches in parallel simply due to a lack of context available. Existing systems have no way to distinguish between AND (<em>P<sub>i</sub>, …, P<sub>j</sub></em>) vs OR(<em>P<sub>i</sub>, …, P<sub>j</sub></em>).

3. Additionally, existing verifiers for tool orchestrators focus on a narrow set of easily verifiable tasks that in general, are not representative of common user goals.`
      },
      {
        id: 'how-we-built',
        title: 'How we built a generalized Tool Orchestrator',
        content: `We started by hand-crafting our tool orchestration prompt to exhibit the properties that were necessary.

We synthesized a suite of 1000 user tasks, extrapolated from a set of 30 representative tasks that were obtained from natural user inputs across a variety of tasks that covered our full suite of our tool calls (phone, sms, browser use, claude code use, sub agent spawning, etc)

We built out an execution engine that processes the executed plan, which is available for general use on <a href="https://roselabs.ai" target="_blank" rel="noopener noreferrer">https://roselabs.ai</a>

We built an initial prototype of a world simulator used to evaluate task decomposition invariants of mutual exclusivity, collective exhaustivity, complexity bounds,

We trained to minimize cost & time & completion, w configurable lambdas for user preference via GEPA+ & Reinforcement Fine Tuning on GPT-5.2`
      },
      {
        id: 'what-weve-learned',
        title: "What we've learned",
        content: `Training a model that can decompose real-world problems is uniquely hard because of a lack of a good verifiable signal. While there is existing research that shows this direction is promising by measuring indirect signals like SWE bench scores, or Deep Research benchmarks, there is still a lack of a clear industry benchmark for determining whether task decomposition is done optimally.

Despite this, the existing model we have made seems to show that the complexity of the decomposition problem is very much within reach of the current model capabilities.`
      },
      {
        id: 'whats-next',
        title: "What's Next",
        content: `Inspired by the progress made in <a href="https://deepmind.google/discover/blog/genie-2-a-large-scale-foundation-world-model/" target="_blank" rel="noopener noreferrer">World Models | Google Genie</a>, the increasing viability of <a href="https://societies.io" target="_blank" rel="noopener noreferrer">Simulated Societies</a> and <a href="https://arxiv.org/pdf/2405.02957v1" target="_blank" rel="noopener noreferrer">simulated RL Environments</a>

Rose Labs believes it is possible to create a simulated, lazily-rendered, low-dimensionality, world for evolving a generalized tool orchestrator.

Additionally, RLHF might be a viable solution for training the orchestrator. Getting a suite of world class operators to train a reward model on what good problem decomposition looks like seems extremely promising.`
      }
    ]
  }
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return blogPosts.find(post => post.slug === slug);
}

export function getBlogPostsByCategory(category: BlogCategory | 'all'): BlogPost[] {
  if (category === 'all') return blogPosts;
  return blogPosts.filter(post => post.category === category);
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}
