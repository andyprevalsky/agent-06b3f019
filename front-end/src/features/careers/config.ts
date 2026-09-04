import type { JobType, Role, WorkStyle } from './types';

/** Rose Labs gradient used for the logo mark. Mirrors the research blog header. */
export const LOGO_GRADIENT =
  'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)';

/** Font stack applied to the careers pages. Mirrors the research blog. */
export const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';

/** Mac app download URL shown in the page header. */
export const DOWNLOAD_URL =
  'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg';

/** Location shown on every role. Every role is currently in one place. */
export const LOCATION = 'San Francisco';

/** Employment type shown on every role. */
export const JOB_TYPE: JobType = 'Full-time';

/** Work style shown on every role. */
export const WORK_STYLE: WorkStyle = 'On-site';

/** Compensation shown on every role. */
export const COMPENSATION = {
  /** Headline total cash figure. Lead with this, not the base. */
  totalCash: '$600,000 – $800,000 total cash',
  /** How the total cash breaks down. */
  breakdown: '$300,000 – $400,000 base plus a performance bonus of up to 1× base',
  /** Equity offered on top of cash. */
  equity: 'Equity up to 1%',
} as const;

/** Maximum resume size accepted by the application form, in bytes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Accepted resume MIME type. */
export const RESUME_MIME_TYPE = 'application/pdf';

/** Prefix rendered inside the LinkedIn field so applicants only type their handle. */
export const LINKEDIN_PREFIX = 'linkedin.com/in/';

/**
 * "About Rose Labs": identical on the overview page and every role page.
 * The thesis paragraph is what makes four separate postings read as one company.
 */
export const ABOUT_ROSE: readonly string[] = [
  'Frontier models are not the bottleneck. A model that reasons brilliantly for twenty minutes, pointed at one task at a time, is a demo. Real-world superintelligence is that capability held together for hours, run across thousands of agents at once, reliably, at a cost that makes sense. Nobody has built it, because almost nobody is measuring it.',
  'We think agent scale is the binding constraint, and that it is a measurable one. So we have compressed the company into a single object: a proprietary benchmark of long-horizon, high-complexity, mass-agent tasks, fed continuously by real user runs. It scores whether the task finished, whether it held together over hours, whether it held at N agents at once, what it cost, and whether it worked every time.',
  'Everything we do is either raising that number or shortening the loop that raises it. Then we ship it to users. Rose is a personal superintelligence that does real work for real people: in the browser, over messages, on the phone, and across the tools they already use.',
];

/** The scope pitch that runs underneath the compensation block. */
export const SCOPE_PITCH =
  'You will be one of four engineers, you will own an entire loop rather than a slice of one, and the thing you change on Monday shows up in the number on Friday.';

export const ROLES: readonly Role[] = [
  {
    slug: 'founding-research-engineer-agent-harness',
    title: 'Founding Research Engineer, Agent Harness',
    discipline: 'Research',
    openings: 2,
    summary:
      'Own the loop end to end: write the long-horizon task that exposes where we break, then improve the harness and the models until it passes.',
    about: [
      'We run one loop, and this role owns it end to end.',
      'Real user runs come in. You mine them for the tasks where our agents actually break, and promote those into hard, reproducible benchmark tasks. Then you improve the harness and the models until those tasks pass: context and memory, planning and verification, tool design, orchestration, recovery, and the decomposition models underneath. Then you prove the gain was real and go again.',
      'We are hiring two people into this role. You will cross-review each other’s benchmark tasks, and nobody merges their own, because the fastest way to ruin an eval-driven company is to let the person climbing the benchmark also decide what it says.',
    ],
    sections: [
      {
        title: 'What You’ll Work On',
        bullets: [
          'Build the pipelines that turn real user trajectories into the benchmarks we care about. The suite should be fed by production, not hand-invented. The tasks that matter are the ones users are already failing to get done.',
          'Author long-horizon evaluation tasks with deterministic environments, fixtures, and verifiers. Define what “good” means per task, build the judges that enforce it, and push complexity forward each generation so the suite stays one the current harness fails.',
          'Make measured improvements to the agent harness: memory, context compression, planner and verifier loops, tool schemas, sub-agent orchestration, failure recovery. Every improvement lands with a before and after on tasks that were failing.',
          'Build and optimize custom models for real-world task decomposition, the step that most determines whether a long-horizon run succeeds or wanders. Whether that is program and prompt optimization over the existing planner, a fine-tune, or a separately trained model is an open research question and part of the job.',
          'Improve the continual-learning system that turns completed runs into durable capability, so each run makes the next one better without a human writing the lesson down.',
          'Refine the world simulation model that replays and predicts agent-environment interaction from archived trajectories, so evaluation does not need live services on every run. Raise prediction fidelity until simulated runs are trustworthy enough to gate decisions on.',
          'Own trajectory stability at scale: a thousand-agent run that still converges on the goal: error propagation between agents, supervision, and the degradation modes that only appear at high agent counts. You own the trajectories; the platform engineer owns the runtime under them.',
        ],
      },
      {
        title: 'What We’re Looking For',
        bullets: [
          'Meaningful time spent building agent harnesses with LLMs, in production or in research. You have been inside the loop, not just calling an API.',
          'Strong ML fundamentals. You can reason from first principles about why a harness or model change should help before you run it, and you design the ablation that tells you whether it did.',
          'Discipline about attribution. You do not ship a change you cannot measure, and you are suspicious of your own green results.',
          'Strong engineering fundamentals; Python. Comfortable with containers, fixtures, and distributed execution.',
          'Judgment about real user data. This role works with production trajectories, so redaction, consent, and access boundaries are part of the job, not a compliance afterthought.',
        ],
      },
      {
        title: 'Especially Exciting',
        bullets: [
          'Post-training or RL experience on language models. You have owned experiments to improve capability and can tell meaningful progress from a misleading result.',
          'You have built a production-to-eval pipeline, an agentic benchmark, or environments other people depended on.',
          'Program and prompt optimization (GEPA, DSPy-style), reward modeling, or learned memory systems.',
          'Multi-agent systems, or world models and simulators for agent evaluation.',
          'You have climbed a public agentic benchmark and can say what actually moved the number.',
        ],
      },
    ],
  },
  {
    slug: 'founding-infrastructure-developer-tooling-engineer',
    title: 'Founding Infrastructure & Developer Tooling Engineer',
    discipline: 'Infrastructure',
    openings: 1,
    summary:
      'Run agents at mass concurrency at a cost and reliability that hold, and own the factory that sets how fast everyone else iterates.',
    about: [
      'Most infrastructure roles are judged on dashboards. This one is judged on a benchmark.',
      'Cost per completed task and reliability under mass-agent load are scored dimensions of the same suite the research team climbs, so when you cut cost per agent-hour or kill a failure mode that only appears at a thousand agents, the number moves and everyone sees it.',
      'You also own the factory the other engineers work inside: the tooling and deploy pipeline that determine how many improvement cycles we get per month. That makes you the clock speed of the research, not support behind it.',
    ],
    sections: [
      {
        title: 'What You’ll Work On',
        bullets: [
          'Scale the agent execution platform toward mass concurrent agents: durable workflows, workers, sandboxed execution, Postgres, and realtime fan-out. Kill every bottleneck whose cost grows with agent count: shared channels, connection fan-in, single-writer contention, retry storms.',
          'Own runtime stability at scale. No cascading failures, no degradation that only shows up at high agent counts, no run that succeeds at ten agents and collapses at a thousand. You own the runtime; the harness engineers own the trajectories on top of it.',
          'Own cost per completed task and reliability as first-class, benchmark-scored metrics.',
          'Build and sharpen the software factory (test tiers, review and deploy gates, automated benchmark selection) so changes ship safely and fast.',
          'Build the diagnostics everyone depends on: trace waterfalls, cost and cache attribution, failure triage.',
          'Build 0 to 1 quickly, then scale it by orders of magnitude.',
        ],
      },
      {
        title: 'What We’re Looking For',
        bullets: [
          'Deep experience with distributed systems at scale. You reason fluently about bottlenecks, backpressure, and failure modes, and you have debugged the ones that only appear under load.',
          'A real eye for performance and cost. You have made a distributed system meaningfully faster or cheaper and can show the numbers.',
          'You treat internal tooling as a product with users, and you measure its adoption and its effect on how fast the team ships.',
          'Fluent in TypeScript or Python, and comfortable owning infrastructure end to end rather than handing it off.',
        ],
      },
      {
        title: 'Especially Exciting',
        bullets: [
          'You have run agentic or ML workloads in production at scale.',
          'Durable execution (Temporal or similar), sandboxed code execution, or multi-tenant isolation.',
          'You have built a developer platform that visibly changed a team’s shipping velocity.',
          'Comfort reading model traces and reasoning about LLM cost structure, not just infrastructure cost.',
        ],
      },
    ],
  },
  {
    slug: 'founding-product-engineer',
    title: 'Founding Product Engineer',
    discipline: 'Product',
    openings: 1,
    summary:
      'Invent what it looks like to supervise, trust, and steer thousands of agents doing hours-long work, and keep the integrations that reach the real world alive.',
    about: [
      'Nobody has figured out what it looks like to work alongside agents that run for hours and number in the thousands. Not a chat box. You need to see what an agent is doing without drowning in it, trust it enough to walk away, catch it when it is wrong, and steer it back without starting over, across many agents at once.',
      'That is this role. You own every surface a human touches, and the integrations that give agents real-world reach. Both feed back into everything else here: real user runs are what our benchmark is built from, so the quality of the interface determines the quality of the data the whole company improves on. An integration that breaks is a failed task and a lower score.',
    ],
    sections: [
      {
        title: 'What You’ll Work On',
        bullets: [
          'Design and build the product surfaces for supervising long-running agents: following work in progress, interrupting and correcting mid-run, reviewing what happened, and deciding whether to trust it next time.',
          'Solve the scale problem on the human side: legible oversight of many concurrent agents without turning it into a firehose.',
          'Keep integrations stable: email, messaging, payments, browser sessions, phone. These are how agents reach the real world; when one silently breaks, the agent fails and we lose the run.',
          'Own usability as a measurable property. Instrument the product, find where users stall or abandon, and fix it.',
          'Ship fast across the stack: React and TypeScript on the front end, Node and Express behind it, realtime throughout, plus the desktop app.',
          'Close the loop with research: make sure real user runs come back as usable trajectories, and that the failures users hit become benchmark tasks.',
        ],
      },
      {
        title: 'What We’re Looking For',
        bullets: [
          'Strong full-stack engineer with real product taste. You have shipped interfaces users chose to keep using, and you can tell a good one from a busy one.',
          'You own outcomes, not tickets. You will decide what to build as often as you are told.',
          'Comfort with ambiguity. The interaction patterns for this do not exist yet, and you will be inventing them and throwing most of them away.',
          'Rigor about reliability. Integrations are unglamorous and they are the difference between a working product and a demo.',
        ],
      },
      {
        title: 'Especially Exciting',
        bullets: [
          'You have built products on top of LLMs or agents, and have opinions about what actually works.',
          'Design ability. You can go from a rough idea to a shipped interface without a spec or a mock.',
          'Realtime, streaming, or collaborative interfaces.',
          'You have owned third-party integrations at scale and know how they really fail.',
        ],
      },
    ],
  },
];
