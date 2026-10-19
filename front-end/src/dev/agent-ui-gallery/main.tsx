/**
 * STATE MACHINE: Agent UI Gallery (dev only — /dev/agent-ui-gallery/)
 *
 * Vite-only page (not part of the production build: `vite build` only builds
 * the root index.html). Renders every agent-to-agent element with realistic
 * fixture data through the REAL components (MessageBubble → SubAgentTree /
 * ToolMessage, WebPreviewBanner) so edits apply live via HMR.
 *
 * [MOUNTED] --> fetch() stub serves /agents/tree?busId=… from TREES (the real
 *               useAgentTree REST snapshot path); realtime is not needed
 *   +--> only NEW/CHANGED UI: running-agents dock (all states + output
 *        schemas), direction legend, inbound agent message / completion rows,
 *        new agent tool chips (open + closed), wait_for(agents) as compact tool rows,
 *        chip, Preview Mode notice last. Spawn UI is main's, unchanged.
 * [EXPANDED copies] --> AutoExpand clicks the tool card header once on mount
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { WebPreviewBanner } from '@/features/terminal-component-group/components/StatusBanners';
import { BackgroundAgentsBanner } from '@/features/terminal-component-group/components/background-agents/BackgroundAgentsBanner';
import type { Message } from '@/lib/api';
import {
  AGENT_MESSAGES,
  TOOL_CHIPS,
  TREES,
  dockMixedRows,
  dockRows,
  exploreWithListAgents,
} from './fixtures';
import '@/index.css';

// The tree hook reads REST snapshots with the user's session headers.
localStorage.setItem(
  'rose-session',
  JSON.stringify({
    access_token: 'gallery',
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    user: { id: 'gallery-user' },
  }),
);
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const busId = /\/agents\/tree\?busId=([^&]+)/.exec(url)?.[1];
  if (busId) {
    const agents = TREES[decodeURIComponent(busId)] ?? [];
    return Promise.resolve(new Response(JSON.stringify({ agents }), { status: 200 }));
  }
  return realFetch(input, init);
};

const agentContext = {
  agent: null,
  applyAgentDetail: () => true,
  inspectionContext: null,
  stagePendingAgentCreation: () => {},
  reconcilePendingAgentCreation: async () => {},
  rollbackPendingAgentCreation: () => false,
  selectedAgentId: 'gallery-root',
  setSelectedAgentId: () => {},
  messages: [],
  streamingBubbles: new Map(),
  streamingPlan: null,
  streamingAttention: null,
  streamingTools: new Map(),
  streamedTextsRef: { current: new Set<string>() },
  registerMessageHandler: () => () => {},
  sendMessage: async () => {},
  isLoadingAgent: false,
  forceResubscribe: () => {},
  isChatMode: false,
} as unknown as AgentContextValue;

/** Same contract as the app's handleSelectAgent: the URL gains ?agent-id=… */
function navigateToAgent(agentId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('agent-id', agentId);
  window.history.pushState({}, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useAgentIdParam(): string | null {
  const [agentId, setAgentId] = useState(() =>
    new URL(window.location.href).searchParams.get('agent-id'),
  );
  useEffect(() => {
    const sync = () => setAgentId(new URL(window.location.href).searchParams.get('agent-id'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return agentId;
}

function Bubble({ message }: { message: Message }) {
  return <MessageBubble message={message} onNavigateToAgent={navigateToAgent} />;
}

/** Renders a tool card and opens it once, like a user clicking its header. */
function AutoExpand({ message }: { message: Message }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>('[aria-expanded="false"]') ??
      root?.querySelector<HTMLElement>('.cursor-pointer');
    target?.click();
  }, []);
  return (
    <div ref={ref}>
      <Bubble message={message} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border pb-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Pair({ label, message }: { label: string; message: Message }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[160px_minmax(0,1fr)]">
      <span className="text-xs text-muted-foreground">{label} · collapsed</span>
      <Bubble message={message} />
      <span className="text-xs text-muted-foreground">{label} · expanded</span>
      <AutoExpand message={message} />
    </div>
  );
}

function Dock({ messages, expand = false }: { messages: Message[]; expand?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expand) return;
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('button')?.click(), 600);
    return () => clearTimeout(timer);
  }, [expand]);
  return (
    <div ref={ref} className="max-w-4xl">
      <BackgroundAgentsBanner
        selectedAgentId="gallery-root"
        messages={messages}
        onNavigate={navigateToAgent}
      />
      <div className="rounded-xl border border-border px-4 py-4 text-sm text-muted-foreground group-has-[[data-query-input-attachment]]:rounded-t-none">
        Type your message… (stand-in for the query box)
      </div>
    </div>
  );
}

/** Running → all finished: shows the "All agents finished" flash, then hides. */
function FinishingDock() {
  const [cycle, setCycle] = useState(0);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    setFinished(false);
    const timer = setTimeout(() => setFinished(true), 2500);
    return () => clearTimeout(timer);
  }, [cycle]);
  const messages = useMemo(
    () =>
      finished
        ? dockRows('bus-dock-done', ['d-1'], false)
        : dockRows('bus-dock-running', ['d-1'], false),
    [finished],
  );
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start rounded border border-border px-2 py-0.5 text-xs"
        onClick={() => setCycle((c) => c + 1)}
      >
        Replay (running 2.5s → finished → flash 5s → hidden)
      </button>
      <div className="group">
        <Dock key={cycle} messages={messages} />
      </div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** Main's Exploring chip via the real MessageList; opens its steps, then the list_agents step. */
function ExploreListAgents() {
  const ref = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => ({ ...agentContext, messages: exploreWithListAgents() }), []);
  useEffect(() => {
    const open = setTimeout(() => {
      ref.current?.querySelector<HTMLElement>('.cursor-pointer')?.click();
      setTimeout(() => {
        const step = [
          ...(ref.current?.querySelectorAll<HTMLElement>('.cursor-pointer') ?? []),
        ].find((el) => el.textContent?.includes('agents'));
        step?.click();
      }, 400);
    }, 400);
    return () => clearTimeout(open);
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      <AgentContext.Provider value={ctx}>
        <MessageList
          containerClassName="flex w-full min-w-0 flex-col gap-1.5"
          showStatusBanners={false}
          showThinkingIndicator={false}
          onNavigateToAgent={navigateToAgent}
        />
      </AgentContext.Provider>
    </div>
  );
}

function Gallery() {
  const agentId = useAgentIdParam();
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6 overflow-x-hidden p-4 sm:p-8">
      <h1 className="text-lg font-semibold">Agent UI gallery</h1>
      <div
        className="rounded border border-border bg-muted/40 px-3 py-2 text-xs"
        data-testid="gallery-nav"
      >
        Navigation:{' '}
        {agentId ? (
          <>
            URL now has <code>?agent-id={agentId}</code> (the app would open this agent)
          </>
        ) : (
          'click an agent row to navigate (sets ?agent-id=… like the app)'
        )}
      </div>
      <Section title="Running-agents dock (on the query box)">
        <Label>hidden (nothing running → renders nothing above the box)</Label>
        <div className="group">
          <Dock messages={[]} />
        </div>
        <Label>running N · collapsed</Label>
        <div className="group">
          <Dock messages={dockRows('bus-dock-running', ['d-1', 'd-2', 'd-3'])} />
        </div>
        <Label>running N · expanded</Label>
        <div className="group">
          <Dock messages={dockRows('bus-dock-running', ['d-1', 'd-2', 'd-3'])} expand />
        </div>
        <Label>mixed running / finished · expanded</Label>
        <div className="group">
          <Dock messages={dockMixedRows()} expand />
        </div>
        <Label>&quot;All agents finished&quot; (transition)</Label>
        <FinishingDock />
      </Section>
      <Section title="↓ Inbound · agent message (arrived from another agent: “↓”, left accent, no chip frame)">
        <Pair label="from /root" message={AGENT_MESSAGES.user} />
      </Section>
      <Section title="↑ Outbound · agent tool chips (actions this agent took: main tool-chip style; child completions are not shown in the trajectory)">
        <Pair label="send_message_to_agent" message={TOOL_CHIPS.sendMessage} />
        <Pair label="kill_agent" message={TOOL_CHIPS.killAgent} />
        <Pair label="failed tool" message={TOOL_CHIPS.failed} />
      </Section>
      <Section title="list_agents inside an explore agent (explore-only tool) · main's Exploring chip">
        <ExploreListAgents />
      </Section>
      <Section title="wait_for(agents=…) · compact tool row (other waits keep main's wait chip)">
        <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[160px_minmax(0,1fr)]">
          <span className="text-xs text-muted-foreground">
            wait_for · waiting (not expandable while running)
          </span>
          <Bubble message={TOOL_CHIPS.waitRunning} />
        </div>
        <Pair label="wait_for · woken" message={TOOL_CHIPS.waitWoken} />
      </Section>
      <Section title="Preview Mode notice (always last in the transcript)">
        <WebPreviewBanner agentId="gallery-root" />
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <AgentContext.Provider value={agentContext}>
    <TooltipProvider>
      <Gallery />
    </TooltipProvider>
  </AgentContext.Provider>,
);
