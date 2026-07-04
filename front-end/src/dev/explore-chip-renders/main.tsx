/**
 * STATE MACHINE: Explore Chip Render Fixture
 *
 * Vite-only visual fixture for explore chips.
 *
 * [MOUNTED] --> renders the real app components with fixed mock props
 *   |
 *   +--> Standalone ExploreAgentBubble examples
 *   +--> WaitForChip examples with nested InlineExploreChip
 *   +--> IN_PROGRESS examples include parallel active tool calls so the
 *        active-tool carousel rotation and thinking stream spring count can
 *        be inspected live.
 *
 * Live timing cycle:
 *   0s-3s   rotate real active tool calls
 *   3s-5s   emit llm_started_at_ms with 0 tokens, matching pre-TTFT state
 *   5s-13s  emit token updates while the thinking metric keeps counting from
 *            the original LLM request start
 *   13s+    hold the completed thinking metric briefly, then reset counters
 *
 * The fixture intentionally imports src/index.css and component code directly
 * so text, colors, borders, spacing, markdown, and animation assets come from
 * the main app instead of duplicated static CSS.
 */

import { StrictMode, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import ExploreAgentBubble from '@/features/terminal-component-group/components/ExploreAgentBubble';
import { PlanChip } from '@/features/terminal-component-group/components/PlanChip';
import { ThinkingIndicator } from '@/features/terminal-component-group/components/ThinkingIndicator';
import WaitForChip from '@/features/terminal-component-group/components/WaitForChip';
import { InlineExploreChip } from '@/features/terminal-component-group/components/wait-for-chip/InlineExploreChip';
import { useAnimatedCounter } from '@/features/terminal-component-group/hooks';
import type { ExploreStep, WaitForCheck } from '@/features/terminal-component-group/types';
import '@/index.css';

type ExploreStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR';

const TOOL_ROTATION_WINDOW_MS = 3_000;
const TOKEN_STREAM_DELAY_MS = 2_000;
const STREAM_WINDOW_MS = 10_000;
const STREAM_HOLD_MS = 10_500;
const DEMO_CYCLE_MS = TOOL_ROTATION_WINDOW_MS + STREAM_HOLD_MS;
const STREAM_START_TOKEN_COUNT = 1;
const STREAM_END_TOKEN_COUNT = 1_260;

interface ToolCallExample {
  title: string;
  toolName: string;
  finishedMessage: string;
}

interface FixtureData {
  goal: string;
  latestAction: string;
  latestToolName: string;
  finishedResult: string;
  failedResult: string;
  finishedStepResult: string;
  failedStepResult: string;
  widthStressResult: string;
  condition: string;
}

const baseSteps = (
  latestAction: string,
  latestToolName: string,
  latestStepStatus: ExploreStatus = 'IN_PROGRESS',
  latestStepMessage = '',
): ExploreStep[] => [
  {
    title: 'Explore agent thinking',
    status: 'FINISHED',
    timestamp: new Date(Date.now() - 180_000).toISOString(),
    message: 'Looking through the terminal chip render path and grouping logic.',
    toolName: 'spawn_agent',
  },
  {
    title: 'Search local messages for explore chip references',
    status: 'FINISHED',
    timestamp: new Date(Date.now() - 150_000).toISOString(),
    message: 'Matched ExploreAgentBubble, ExploreBubble, and message routing.',
    toolName: 'grep',
  },
  {
    title: latestAction,
    status: latestStepStatus,
    timestamp: new Date(Date.now() - 30_000).toISOString(),
    message: latestStepStatus === 'IN_PROGRESS' ? '' : latestStepMessage,
    toolName: latestToolName,
  },
];

const liveToolCalls: ToolCallExample[] = [
  {
    title: 'Searching the web for Vercel production deployment status roselabs.ai',
    toolName: 'web_search',
    finishedMessage:
      '**Result:** Found the Vercel deployment dashboard and current production alias.',
  },
  {
    title:
      'Fetching https://vercel.com/rose-labs/rose-labs-web/deployments for deployment event details',
    toolName: 'web_fetch',
    finishedMessage: '**Result:** Deployment event reports status `READY` for the `main` branch.',
  },
  {
    title: 'Searching messages for "deploy confirmation"',
    toolName: 'grep',
    finishedMessage:
      '**Result:** Matched the latest production deploy notification in local message history.',
  },
];

function buildLiveSteps(toolsFinished: boolean, finishedAtMs: number): ExploreStep[] {
  const now = Date.now();

  return [
    {
      title: 'Explore agent thinking',
      status: 'FINISHED',
      timestamp: new Date(now - 180_000).toISOString(),
      message: 'Planning which evidence source to inspect next.',
      toolName: 'spawn_agent',
    },
    ...liveToolCalls.map((tool, index): ExploreStep => ({
      title: tool.title,
      status: toolsFinished ? 'FINISHED' : 'IN_PROGRESS',
      timestamp: new Date(toolsFinished ? finishedAtMs + index : now + index).toISOString(),
      message: toolsFinished ? tool.finishedMessage : '',
      toolName: tool.toolName,
      toolCallId: `demo-tool-${index + 1}`,
    })),
  ];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-3">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="min-w-0 text-[11px] text-muted-foreground">{label}</div>
      {/* min-w-0 mirrors the real message list, where bubbles sit in width-
          constrained block wrappers instead of intrinsically-sized grid tracks. */}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function WaitExample({
  data,
  status,
  liveSteps,
  liveTitle,
  thinkingStreamTokenCount,
  thinkingStreamStartedAtMs,
}: {
  data: FixtureData;
  status: ExploreStatus;
  liveSteps: ExploreStep[];
  liveTitle: string;
  thinkingStreamTokenCount: number;
  thinkingStreamStartedAtMs: number;
}) {
  const terminalResult = status === 'ERROR' ? data.failedResult : data.finishedResult;
  const terminalStepResult = status === 'ERROR' ? data.failedStepResult : data.finishedStepResult;

  const checks: WaitForCheck[] = useMemo(
    () => [
      {
        title: 'Check 1',
        status: 'FINISHED',
        timestamp: new Date(Date.now() - 240_000).toISOString(),
        checkNum: 1,
        conditionMet: false,
        explore: {
          title: data.latestAction,
          fullGoal: data.goal,
          message: 'Condition was not met yet.',
          status: 'FINISHED',
          steps: baseSteps(
            data.latestAction,
            data.latestToolName,
            'FINISHED',
            data.finishedStepResult,
          ).slice(0, 2),
        },
      },
      {
        title: 'Check 2',
        status,
        timestamp: new Date(Date.now() - 45_000).toISOString(),
        checkNum: 2,
        conditionMet: status === 'FINISHED',
        explore: {
          title: status === 'IN_PROGRESS' ? liveTitle : data.latestAction,
          fullGoal: data.goal,
          message: terminalResult,
          status,
          steps:
            status === 'IN_PROGRESS'
              ? liveSteps
              : baseSteps(data.latestAction, data.latestToolName, status, terminalStepResult),
        },
      },
    ],
    [
      data.failedResult,
      data.failedStepResult,
      data.finishedResult,
      data.finishedStepResult,
      data.goal,
      data.latestAction,
      data.latestToolName,
      liveSteps,
      liveTitle,
      status,
      terminalResult,
      terminalStepResult,
    ],
  );

  return (
    <WaitForChip
      title={`Waiting for ${data.condition}`}
      message={terminalResult}
      status={status}
      checks={checks}
      thinkingStreamTokenCount={thinkingStreamTokenCount}
      thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
      metadata={{
        waitForMode: 'condition',
        condition: data.condition,
        checkIntervalSeconds: 60,
        conditionMet: status === 'FINISHED',
        data: { condition_met: status === 'FINISHED', checks_completed: checks.length },
      }}
    />
  );
}

function InlineExample({ data, status }: { data: FixtureData; status: ExploreStatus }) {
  const terminalResult = status === 'ERROR' ? data.failedResult : data.finishedResult;
  const terminalStepResult = status === 'ERROR' ? data.failedStepResult : data.finishedStepResult;

  return (
    <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm shadow-sm overflow-hidden">
      <InlineExploreChip
        isLive={status === 'IN_PROGRESS'}
        explore={{
          title: data.latestAction,
          fullGoal: data.goal,
          message: terminalResult,
          status,
          steps: baseSteps(data.latestAction, data.latestToolName, status, terminalStepResult),
        }}
      />
    </div>
  );
}

function useDemoThinkingStream() {
  const [cycleOriginMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, []);

  const elapsedSinceOriginMs = nowMs - cycleOriginMs;
  const cycleIndex = Math.floor(elapsedSinceOriginMs / DEMO_CYCLE_MS);
  const cycleElapsedMs = elapsedSinceOriginMs % DEMO_CYCLE_MS;
  const streamStartedAtMs = cycleOriginMs + cycleIndex * DEMO_CYCLE_MS + TOOL_ROTATION_WINDOW_MS;
  const streamElapsedMs = Math.max(0, cycleElapsedMs - TOOL_ROTATION_WINDOW_MS);
  const isStreaming = cycleElapsedMs >= TOOL_ROTATION_WINDOW_MS;
  const tokenElapsedMs = Math.max(0, streamElapsedMs - TOKEN_STREAM_DELAY_MS);
  const hasTokens = tokenElapsedMs > 0;
  const streamProgress = Math.min(1, tokenElapsedMs / (STREAM_WINDOW_MS - TOKEN_STREAM_DELAY_MS));

  return {
    thinkingStreamStartedAtMs: streamStartedAtMs,
    thinkingStreamTokenCount:
      isStreaming && hasTokens
        ? Math.round(
            STREAM_START_TOKEN_COUNT +
              (STREAM_END_TOKEN_COUNT - STREAM_START_TOKEN_COUNT) * streamProgress,
          )
        : 0,
    toolsFinished: isStreaming,
  };
}

function App() {
  const { thinkingStreamTokenCount, thinkingStreamStartedAtMs, toolsFinished } =
    useDemoThinkingStream();
  const animatedThinkingTokenCount = useAnimatedCounter(thinkingStreamTokenCount, 0.3);
  const visibleStreamStartedAtMs = toolsFinished ? thinkingStreamStartedAtMs : undefined;

  const data: FixtureData = {
    goal: 'Find how explore-agent chips render, including status treatment, step rows, expansion, and wait_for nesting.',
    latestAction: 'Searching the web for Vercel production deployment status roselabs.ai',
    latestToolName: 'web_search',
    finishedResult:
      'The production deployment is ready.\n\n- Project: `rose-labs-web`\n- Deployment status: `READY`\n- Production URL: https://roselabs.ai\n- Evidence: the latest Vercel deployment event for `main` completed successfully.',
    failedResult:
      'Activity task failed: web_search_activity failed: Parallel AI search returned HTTP 429 Too Many Requests',
    finishedStepResult:
      '**Params Passed:**\n\n- **query**: Vercel production deployment status roselabs.ai\n- **max_tokens**: 1500\n\n**Result:**\n\n**Vercel Deployment Status**\nThe latest production deployment for `rose-labs-web` is READY and serving traffic at https://roselabs.ai.\n\n**Sources:**\n- https://vercel.com/rose-labs/rose-labs-web/deployments\n\n**Time Elapsed:** 2s\n\n**Cost:** $0.0100',
    failedStepResult:
      '**Params Passed:**\n\n- **query**: Vercel production deployment status roselabs.ai\n- **max_tokens**: 1500\n\n**Error:**\n\nParallel AI search returned HTTP 429 Too Many Requests\n\n**Time Elapsed:** 4s\n\n**Cost:** $0.0000',
    condition: 'the production deploy to finish',
    widthStressResult: [
      'Identify exactly 50 top creators in the health, longevity, biohacking, health-tech, and founder journey niche across four platforms: YouTube, Instagram, TikTok, and Substack.',
      '',
      '    17. Arnold Schwarzenegger (Arnold’s Pump Club) | Substack-style newsletter | arnoldspumpclub.com | ~700K+ subscribers (est.) [33] | daily fitness/longevity positivity',
      '    18. Nikhil Krishnan | Substack | outofpocket.health | ~50K subscribers (est.) [34] | healthcare-business/health-tech founder analysis',
      '    19. Greg Katz, MD | Substack | gregorykatz.substack.com | ~20K subscribers (est.) [35] | cardiology & practical longevity for patients',
      '',
      '```',
      'curl -sS https://api.roselabs.ai/v1/agents/ac267c32-470f-41da-8343-091b8965c410/messages?include=metadata,tool_calls,step_history&format=jsonl&page_size=200 -H "Authorization: Bearer AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag="',
      '```',
      '',
      '| Creator | Platform | Handle | Followers | Niche focus and detailed positioning notes for the longevity and health-tech founder audience |',
      '| --- | --- | --- | --- | --- |',
      '| Bryan Johnson | YouTube | @bryanjohnson | 1.2M | longevity protocol content with heavy data instrumentation and founder-journey framing |',
      '| Andrew Huberman | YouTube | @hubermanlab | 5.8M | neuroscience-grounded health optimization protocols |',
      '',
      'Unbreakable-token check: https://vercel.com/rose-labs/rose-labs-web/deployments/dpl_4Gt8Yq2kJ9XwLmN3pRsTuVzAbCdEfGhIjKlMnOpQrStUvWxYzVeryLongDeploymentIdentifierThatNeverWraps',
    ].join('\n'),
  };

  const steps = useMemo(
    () => buildLiveSteps(toolsFinished, thinkingStreamStartedAtMs),
    [thinkingStreamStartedAtMs, toolsFinished],
  );
  const activeTool = liveToolCalls[0];

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto grid max-w-3xl gap-6 px-5 py-6">
          <header className="grid gap-1">
            <h1 className="text-xl font-semibold text-foreground">Explore Chip Renders</h1>
            <p className="text-sm text-muted-foreground">
              Real app components rendered with the main frontend styles.
            </p>
          </header>

          <div className="grid min-w-0 gap-6">
            <Section title="Main Streaming States">
              <Example label="ThinkingIndicator">
                <ThinkingIndicator
                  compact={false}
                  isClaudeStreaming={false}
                  streamStartedAtMs={visibleStreamStartedAtMs}
                  streamingTokenCount={thinkingStreamTokenCount}
                  animatedTokenCount={animatedThinkingTokenCount}
                />
              </Example>
              <Example label="PlanChip IN_PROGRESS">
                <PlanChip
                  plan={{
                    title: 'Generating Plan',
                    content: '',
                    tasks: [],
                    dependencies: null,
                    join: 'all',
                    status: 'planning',
                  }}
                  toolStatus="IN_PROGRESS"
                  charCount={thinkingStreamTokenCount * 4}
                  streamStartedAtMs={visibleStreamStartedAtMs}
                />
              </Example>
            </Section>

            <Section title="Standalone ExploreAgentBubble">
              <Example label="IN_PROGRESS">
                <ExploreAgentBubble
                  title={activeTool.title}
                  fullGoal={data.goal}
                  message=""
                  status="IN_PROGRESS"
                  stepHistory={steps}
                  thinkingStreamTokenCount={thinkingStreamTokenCount}
                  thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
                />
              </Example>
              <Example label="FINISHED">
                <ExploreAgentBubble
                  title="Map explore chip render states"
                  fullGoal={data.goal}
                  message={data.finishedResult}
                  status="FINISHED"
                  stepHistory={baseSteps(
                    data.latestAction,
                    data.latestToolName,
                    'FINISHED',
                    data.finishedStepResult,
                  )}
                />
              </Example>
              <Example label="ERROR">
                <ExploreAgentBubble
                  title="Gather release facts"
                  fullGoal={data.goal}
                  message={data.failedResult}
                  status="ERROR"
                  stepHistory={baseSteps(
                    data.latestAction,
                    data.latestToolName,
                    'ERROR',
                    data.failedStepResult,
                  )}
                />
              </Example>
              <Example label="FINISHED width stress (long lines, code block, table, URL)">
                <ExploreAgentBubble
                  title="Identify 50 top creators"
                  fullGoal={data.goal}
                  message={data.widthStressResult}
                  status="FINISHED"
                  stepHistory={baseSteps(
                    'Fetching https://vercel.com/rose-labs/rose-labs-web/deployments/dpl_4Gt8Yq2kJ9XwLmN3pRsTuVzAbCdEfGhIjKlMnOpQrStUvWxYz for deployment event details',
                    'web_fetch',
                    'FINISHED',
                    data.widthStressResult,
                  )}
                />
              </Example>
            </Section>

            <Section title="wait_for InlineExploreChip">
              <Example label="Live condition check">
                <WaitExample
                  data={data}
                  status="IN_PROGRESS"
                  liveSteps={steps}
                  liveTitle={activeTool.title}
                  thinkingStreamTokenCount={thinkingStreamTokenCount}
                  thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
                />
              </Example>
              <Example label="Completed condition check">
                <InlineExample data={data} status="FINISHED" />
              </Example>
              <Example label="Failed condition check">
                <InlineExample data={data} status="ERROR" />
              </Example>
            </Section>
          </div>
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
