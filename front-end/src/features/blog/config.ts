// IMPORTANT: When adding a new blog post, also add its metadata to
// front-end/api/og/_blogMeta.ts for OG social card generation.

import { type BlogPost } from './types';

export const blogPosts: BlogPost[] = [
  {
    slug: 'task-decomposer',
    title:
      'Why task decomposition is the bottleneck to superintelligence & how we built a SOTA generalizable task decomposer',
    description:
      'How we built a flexible task decomposition layer that enables agents to complete complex, multi-step tasks across diverse domains.',
    category: 'research',
    date: '2026-03-22',
    author: 'Andy Prevalsky',
    intro: `The birth of personal assistants that take action in the world has begun, and soon everyone will have an AI system that does the majority of intelligence related work for them. However, these agentic systems still fail to perform well on long-horizon problems in practical settings for 3 main reasons: context overflow, cost prohibition & complexity explosion. This post aims to describe our efforts in solving these 3 problems by creating a generalized task decomposer that recursively decomposes tasks into a set of context-independent, parallelizable, and proximate sub tasks that each fit into the current complexity requirements for modern day agentic systems.`,
    sections: [
      {
        id: 'why-task-decomposition',
        title: 'Why Task Decomposition is the bottleneck for general-use Super Intelligence',
        content: `Superintelligence, as we will know it in 10-20 years, will be a system that can achieve any goal the user asks of it, with the lowest energy cost possible, barring that it violates existing structural constraints (laws of physics, geopolitical boundaries, user preferences, etc.). The most difficult of which are long-horizon tasks that may take weeks, months, or maybe in some cases years to resolve.

These long-horizon tasks fail to resolve with modern agentic systems because shallow agent networks quickly exhaust their context-window, fail to complete the task in a reasonable amount of time, and often cost the end user much more than it would take to complete the task themselves.

However, if we take a complex, long-horizon problem <em>P</em>, and are able to decompose it into a set of sub-problems <em>P<sub>i</sub></em> through <em>P<sub>j</sub></em> such that

the complexity of <em>P<sub>n</sub></em> &lt; <em>P</em> and
the completion of <em>P<sub>i</sub></em> through <em>P<sub>j</sub></em> == the completion of <em>P</em>

then, in theory, we could recursively reduce <em>P</em> to a set of proximate problems that are independently solvable by modern-day LLMs. And in this simple formula it becomes clear that the complexity of creating Superintelligence, a system that can solve any user problem <em>P</em>, is equal to the complexity of creating a general-purpose task decomposer that can satisfy our lemma.

<span style="font-size: 0.85em; font-style: italic;">You may say, wait a minute, what if a problem <em>P</em> is NOT decomposable at all? From our experience, almost ALL problems are decomposable in some way except for fringe problems in mathematics.</span>`,
      },
      {
        id: 'landscape',
        title: 'The Landscape of Task Decomposers',
        content: `We see the industry is already making large efforts to tackle the challenge of solving long-horizon problems in a similar way.

<strong>Jan 14, 2026</strong> <a href="https://cursor.com/blog/scaling-agents" target="_blank" rel="noopener noreferrer">Cursor | Scaling long-running autonomous coding</a> Cursor makes the assumption that "planning ahead would be too rigid" for large projects, or in other words, the complexity of the decomposition problem itself is too large for modern LLMs, and thus attempts to solve long-horizon tasks by approximating the correct solution over time via decentralized task decomposition. This approach has its benefits, namely each new generation of agents can fix hallucinations of their ancestors, and the problem of compounding errors in recursive decomposition is minimized.

<strong>Nov 26, 2025</strong> <a href="https://arxiv.org/pdf/2511.21689" target="_blank" rel="noopener noreferrer">Nvidia | Elevating Intelligence via Efficient Model and Tool Orchestration</a> Here Nvidia builds a general Task Decomposer (8 billion parameters) that beats frontier large models on Humanities Last Exam, FRAMEs, and T\u00B2 Bench with a fraction of the number of steps and at much lower costs. Notably, they mention they "envision [a] more sophisticated recursive orchestrator systems to push the upper bound of intelligence but also to further enhance efficiency in solving increasingly complex agentic tasks".

<strong>Feb 2, 2026</strong> <a href="https://arxiv.org/pdf/2602.01848" target="_blank" rel="noopener noreferrer">ROMA | Recursive Open Meta-Agent Framework for Long-Horizon Multi-Agent Systems</a> ROMA shows that recursive decomposition is SOTA across a multitude of highly complex reasoning tasks, including Deep Research.

<strong>Feb 2, 2026</strong> <a href="https://www.kimi.com/blog/kimi-k2-5.html" target="_blank" rel="noopener noreferrer">Kimi 2.5 | Swarm</a> Kimi shows how, as task complexity increases, execution time increases linearly with swarms as opposed to exponentially with a single-agent system. It also shows how Agent Swarms serve as a form of "Proactive Context Management", scaling effective context length along an additional architectural dimension while preserving modularity, information locality, and reasoning integrity.

<strong>Feb 05, 2026</strong> <a href="https://www.anthropic.com/engineering/building-c-compiler" target="_blank" rel="noopener noreferrer">Opus 4.6 | Agent Teams</a> shows how scaling the number of agents, in this case to 16, can dramatically reduce the time it takes to complete a C compiler, a traditionally extremely complex task that would realistically cost hundreds of thousands of dollars in engineering costs.

<strong>Jan 17, 2026</strong> <a href="https://ensue.dev/blog/stop-throwing-a-single-agent-at-complex-problems/" target="_blank" rel="noopener noreferrer">Ensue | Stop Throwing A Single Agent At Complex Problems</a> Shows how recursive decomposition can extend LLM capabilities to new SOTA levels for math work, solving a Putnam problem previously out of reach of Opus 4.5

<strong>Jan 28, 2026</strong> <a href="https://arxiv.org/abs/2512.24601v1" target="_blank" rel="noopener noreferrer">Recursive Language Models</a> While not a task decomposer per se, recursive language models show how the effective context of a model can be extended drastically by externalizing the input prompt as an environment variable that the core LLM can query and interact with.`,
      },
      {
        id: 'whats-missing',
        title: "What's Missing",
        content: `The groundwork for how to create a generalized recursive task decomposer has been laid out, but so far, nobody has applied this orchestrator to real-world user tasks in a system that has the necessary suite of tools to take action in the real world. Additionally, the question of whether the complexity of creating a general-purpose decomposer is within reach has not been rigorously evaluated.

Additionally, existing benchmarks for task decomposers focus on a narrow set of easily verifiable tasks that, in general, are not representative of common user goals. These benchmarks include things like long-form text generation, coding capabilities, or math proofs, but do not extend to common real-world problems like buying a car at the best price, growing & launching a business, landing the optimal job, or treating illnesses.

Credit assignment for recursive task decomposition (knowing which decomposition in the entire decomposition tree was bad/good) is currently an open research problem. Previous algorithms like AlphaGo solve this problem because the problem space is perfectly simulatable, and thus, are able to generate massive amounts of end-to-end runs that make approximating any given state in the tree possible.

Decentralized task decomposers, like Agent Teams or Cursor's Long Running Code Agent are highly costly, require continued maintenance to avoid stagnation, and are bottlenecked by the complexity of creating a perfect verifier, which they rely on to ensure target drift doesn't happen. For real-world applications, these are unacceptable conditions.`,
      },
      {
        id: 'how-we-built',
        title: 'How we built a SOTA Generalizable Task Decomposer',
        content: `We started by hand-crafting our task decomposition prompt to adhere to the principles of what a good plan entails.

1. <strong>ME</strong>: All sub-tasks should be mutually exclusive, there should be no work duplicated across sub-tasks.

2. <strong>CE</strong>: All sub-tasks should collectively be exhaustive, CE, completion of all sub-tasks should imply completion of the task that is being decomposed.

3. <strong>CX</strong>: Each sub-task should be strictly less complex than the task being decomposed, CX.

4. The expected cost of each sub-task should be minimized.

5. The total time required to complete each sub-task should be minimized.

Thus, the equation for how good any given decomposition is can be described as
<em>ME<sup>w1</sup> \u00D7 CE<sup>w2</sup> \u00D7 CX<sup>w3</sup> \u00D7 Normalized(Expected(Cost)) \u00D7 Normalized(Expected(Time))</em>

In order to derive Expected Cost and Expected Time of any given decomposition in a tree of recursive decompositions, we take inspiration from AlphaGo to tackle the Credit Assignment problem. Instead of running a massive simulation though, we bootstrap Expected Cost and Expected Time via a proxy metric derived from a custom trained Bradley-Terry reward model.

We collected roughly 500 tasks generated via real user queries @ <a href="https://roselabs.ai" target="_blank" rel="noopener noreferrer">https://roselabs.ai</a>, generated a decomposition of each task from GPT-5.2, Opus 4.6, Kimi 2.5, and Gemini 3 Pro, then expertly labeled pair-wise comparisons for each decomposition. We then synthetically enhanced this data set to increase the generality of our task coverage.

We used this dataset to fine-tune a Gemma-2-9B-it Bradley Terry Model and used LLM Judges to evaluate ME, CE, CX scores.

<figure><img src="/blog/1_mutual_exclusivity.png" alt="Mutual Exclusivity (ME) \u2014 No Duplicated Work" /><figcaption>Baseline ME scores across frontier models</figcaption></figure>
<figure><img src="/blog/2_collective_exhaustiveness.png" alt="Collective Exhaustiveness (CE) \u2014 Complete Coverage" /><figcaption>Baseline CE scores across frontier models</figcaption></figure>
<figure><img src="/blog/3_complexity_invariant.png" alt="Complexity Invariant (CX) \u2014 Sub-tasks Simpler" /><figcaption>Baseline CX scores across frontier models</figcaption></figure>

We considered multiple approaches for training a generalizable tool decomposer, and settled on using GEPA for its ability to maintain generalization across unseen data and its remarkable sample efficiency.

<table><thead><tr><th>Metric</th><th>Opus 4.6</th><th>Rose-Decompose</th><th>\u0394</th></tr></thead><tbody><tr><td>ME Pass Rate</td><td>72.3%</td><td>93.8%</td><td style="color:#16a34a">+21.5%</td></tr><tr><td>CE Pass Rate</td><td>96.8%</td><td>94.8%</td><td>\u22122.0%</td></tr><tr><td>CX Pass Rate</td><td>93.6%</td><td>93.8%</td><td style="color:#16a34a">+0.2%</td></tr><tr><td>All-3 Pass Rate</td><td>63.8%</td><td>85.6%</td><td style="color:#16a34a"><strong>+21.8%</strong></td></tr><tr><td>ELO</td><td>1000</td><td>1251</td><td style="color:#16a34a"><strong>+251</strong></td></tr></tbody></table>

The resulting model, Rose-Decompose, performs dramatically better on our hold-out set, and due to the nature of the task at hand, recursive decomposition, these large increases in performance compound within a single task dramatically.

<table><thead><tr><th>Model</th><th>ELO</th><th>All-3 Pass</th><th>Tree Pass (depth=3)</th></tr></thead><tbody><tr><td><strong>Rose-Decompose</strong></td><td><strong>1251</strong></td><td><strong>85.6%</strong></td><td><strong>13.25%</strong></td></tr><tr><td>Opus 4.6</td><td>1000</td><td>63.8%</td><td>0.29%</td></tr><tr><td>GPT 5.2</td><td>864</td><td>64.9%</td><td>0.36%</td></tr><tr><td>Gemini 3 Pro</td><td>530</td><td>68.7%</td><td>0.76%</td></tr><tr><td>Kimi 2.5</td><td>716</td><td>57.5%</td><td>0.08%</td></tr></tbody></table>

<p style="font-size: 0.75em; font-style: italic; color: #6b7280; margin-top: 6px;"><strong>All-3 Pass:</strong> the percentage of decompositions where all three quality criteria (ME, CE, and CX) pass simultaneously.<br/><br/><strong>Tree Pass (depth=3):</strong> the probability that every node in a full recursive decomposition tree of depth 3 passes all three criteria.</p>

We also built out an execution engine that allows for real-world testing of our decomposition model, which you can find at <a href="https://roselabs.ai" target="_blank" rel="noopener noreferrer">https://roselabs.ai</a>`,
      },
      {
        id: 'what-weve-learned',
        title: "What we've learned",
        content: `Training a model that can decompose real-world problems is uniquely hard because of a lack of a good verifiable signal. While there is existing research that shows this direction is promising by measuring indirect signals like SWE bench scores, or Deep Research benchmarks, there is still a lack of a clear industry benchmark for determining whether task decomposition is done optimally.

Because task decomposition is a skill with an extremely high skill ceiling, curtailed training is still needed in order to reach capability sufficient for real-world use, even current SOTA models like Opus 4.6 still underperform dramatically.`,
      },
      {
        id: 'whats-next',
        title: "What's Next",
        content: `Inspired by the progress made in <a href="https://deepmind.google/discover/blog/genie-2-a-large-scale-foundation-world-model/" target="_blank" rel="noopener noreferrer">World Models | Google Genie</a>, the increasing viability of <a href="https://societies.io" target="_blank" rel="noopener noreferrer">Simulated Societies</a> and <a href="https://arxiv.org/pdf/2405.02957v1" target="_blank" rel="noopener noreferrer">simulated RL Environments</a>, Rose Labs anticipates creating a simulated, lazily-rendered, low-dimensionality, world for evolving a generalized task decomposer.

Additionally, scaling our expertly labeled & synthetically generated dataset is likely to continue to yield gains in decomposition performance.`,
      },
    ],
  },
];
