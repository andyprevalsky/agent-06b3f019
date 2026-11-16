/**
 * STATE MACHINE: useLocalImport (import a project from this Mac, no copy-paste)
 *
 *   The Rose Mac app opens the native folder picker and runs the bundled `rose`
 *   CLI (`rose import detect|scan|apply`), which runs the user's own Codex or
 *   Claude Code read-only in that folder to plan the import (boxes.dev's
 *   desktop local-folder setup). window.api.roseCli is the app's bridge;
 *   elsewhere (browser, older app) the flow is unavailable.
 *
 *   [IDLE] --start()--> [PICKING] native folder picker
 *     --canceled--> [IDLE]
 *     --folder--> [DETECTING] which local agent is signed in (codex first, then claude)
 *       --none--> [NO_AGENT] --start()--> [PICKING]
 *       --agent--> [SCANNING] one-time login code (bound to `projectId` when syncing
 *         an existing project) → `scan`: progress messages → plan
 *         --plan--> [REVIEW plan] --approve(githubImport)--> [APPLYING]
 *           `apply`: upload, GitHub, verify --done--> [DONE project]
 *         --error event | non-zero exit--> [FAILED message] --start()--> [PICKING]
 *   [REVIEW] --reset()--> [IDLE];  [DETECTING|SCANNING|APPLYING] --reset()--> cancel run, [IDLE]
 *
 * Events for other runs are ignored, so a late event never moves a newer flow;
 * events that arrive before the run id is known are buffered and replayed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { BACKEND_BASE_URL } from '@/lib/backendUrl';
import { createCliLoginCode } from '@/lib/api/projects';

export type LocalAgentId = 'codex' | 'claude';

export interface LocalImportPlan {
  projectName: string;
  branch: string | null;
  repo: { remoteUrl: string | null; githubRepo: string | null };
  envFiles: { path: string; variables: string[] }[];
  extraFiles: { path: string; reason: string }[];
  setupCommands: string[];
  notes: string[];
  github: {
    status: 'reachable_user' | 'reachable_rose' | 'unreachable' | 'not_github' | 'no_remote';
    login: string | null;
    canImport: boolean;
  };
}

export type LocalImportState =
  | { status: 'idle' }
  | { status: 'picking' }
  | { status: 'detecting'; folder: string }
  | { status: 'no_agent'; folder: string }
  | { status: 'scanning'; folder: string; agent: LocalAgentId; message: string | null }
  | { status: 'review'; folder: string; agent: LocalAgentId; plan: LocalImportPlan }
  | { status: 'applying'; folder: string; agent: LocalAgentId; message: string | null }
  | { status: 'done'; project: { id: string; name: string } }
  | { status: 'failed'; message: string };

export const LOCAL_AGENT_LABEL: Record<LocalAgentId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

type ImportRequest =
  | { action: 'detect' }
  | {
      action: 'scan';
      folder: string;
      loginCode: string;
      apiUrl: string;
      project?: string;
      agent?: LocalAgentId;
    }
  | { action: 'apply'; folder: string; plan: unknown; githubImport: boolean; apiUrl: string };

/** One event the Mac app forwards from the CLI (a parsed stdout JSON line, or its exit). */
interface ImportEvent {
  runId: string;
  event?: string;
  code?: number;
  message?: string;
  agents?: { id: string; signedIn: boolean; binary: string | null }[];
  preferred?: LocalAgentId | null;
  plan?: LocalImportPlan;
  agent?: LocalAgentId;
  project?: { id: string; name: string };
}

function bridge() {
  return typeof window === 'undefined' ? undefined : window.api?.roseCli;
}

export function hasLocalImport(): boolean {
  const b = bridge();
  return (
    typeof b?.pickProjectFolder === 'function' &&
    typeof b.importProject === 'function' &&
    typeof b.onImportEvent === 'function'
  );
}

/** The backend origin the CLI talks to (absolute, even when the page uses same-origin /api). */
function apiUrl(): string {
  return BACKEND_BASE_URL !== '' ? BACKEND_BASE_URL : window.location.origin;
}

const GENERIC_FAILURE = 'The import stopped unexpectedly. Try again.';

export function useLocalImport(projectId: string | null = null) {
  const [state, setStateValue] = useState<LocalImportState>({ status: 'idle' });
  // Event handlers read the latest state synchronously; one setter keeps both in step.
  const stateRef = useRef(state);
  const setState = useCallback((next: LocalImportState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);
  const runId = useRef<string | null>(null);
  const starting = useRef(false);
  const early = useRef<ImportEvent[]>([]);
  const sawResult = useRef(false);
  const handleRef = useRef<(event: ImportEvent) => void>(() => undefined);

  const run = useCallback(
    async (request: ImportRequest): Promise<boolean> => {
      starting.current = true;
      early.current = [];
      runId.current = null;
      sawResult.current = false;
      const started = await bridge()?.importProject(request);
      starting.current = false;
      if (started === undefined) {
        early.current = [];
        setState({ status: 'failed', message: GENERIC_FAILURE });
        return false;
      }
      if ('error' in started) {
        early.current = [];
        setState({ status: 'failed', message: started.error });
        return false;
      }
      runId.current = started.runId;
      const buffered = early.current.filter((event) => event.runId === started.runId);
      early.current = [];
      for (const event of buffered) handleRef.current(event);
      return true;
    },
    [setState],
  );

  const scan = useCallback(
    async (folder: string, agent: LocalAgentId) => {
      setState({ status: 'scanning', folder, agent, message: null });
      let loginCode: string;
      try {
        loginCode = (await createCliLoginCode(projectId)).code;
      } catch {
        setState({ status: 'failed', message: 'Could not start the import. Try again.' });
        return;
      }
      await run({
        action: 'scan',
        folder,
        loginCode,
        apiUrl: apiUrl(),
        agent,
        ...(projectId !== null ? { project: projectId } : {}),
      });
    },
    [projectId, run, setState],
  );

  const handleEvent = (event: ImportEvent) => {
    const current = stateRef.current;
    if (event.event === 'exit') {
      runId.current = null;
      if (!sawResult.current && event.code !== 0)
        setState({ status: 'failed', message: GENERIC_FAILURE });
      return;
    }
    if (event.event === 'error') {
      sawResult.current = true;
      setState({ status: 'failed', message: event.message ?? GENERIC_FAILURE });
      return;
    }
    if (current.status === 'detecting' && Array.isArray(event.agents)) {
      sawResult.current = true;
      const agent = event.preferred ?? null;
      if (agent === null) setState({ status: 'no_agent', folder: current.folder });
      else void scan(current.folder, agent);
      return;
    }
    if (event.event === 'progress') {
      if (current.status === 'scanning' || current.status === 'applying')
        setState({ ...current, message: event.message ?? null });
      return;
    }
    if (event.event === 'plan' && event.plan !== undefined && current.status === 'scanning') {
      sawResult.current = true;
      setState({
        status: 'review',
        folder: current.folder,
        agent: event.agent ?? current.agent,
        plan: event.plan,
      });
      return;
    }
    if (event.event === 'done' && event.project !== undefined) {
      sawResult.current = true;
      setState({ status: 'done', project: event.project });
    }
  };
  useEffect(() => {
    handleRef.current = handleEvent;
  });

  useEffect(() => {
    const b = bridge();
    if (b?.onImportEvent === undefined) return undefined;
    return b.onImportEvent((raw: unknown) => {
      const event = raw as ImportEvent;
      if (runId.current === null && starting.current) {
        early.current.push(event);
        return;
      }
      if (event.runId === runId.current) handleRef.current(event);
    });
  }, []);

  const start = useCallback(async () => {
    const b = bridge();
    if (b?.pickProjectFolder === undefined) return;
    setState({ status: 'picking' });
    const picked = await b.pickProjectFolder();
    if (picked.canceled || picked.path === undefined) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'detecting', folder: picked.path });
    await run({ action: 'detect' });
  }, [run, setState]);

  const approve = useCallback(
    async (githubImport: boolean) => {
      const current = stateRef.current;
      if (current.status !== 'review') return;
      setState({ status: 'applying', folder: current.folder, agent: current.agent, message: null });
      await run({
        action: 'apply',
        folder: current.folder,
        plan: current.plan,
        githubImport,
        apiUrl: apiUrl(),
      });
    },
    [run, setState],
  );

  const reset = useCallback(() => {
    const active = runId.current;
    runId.current = null;
    if (active !== null) void bridge()?.cancelImport(active);
    setState({ status: 'idle' });
  }, [setState]);

  return { state, start, approve, reset };
}
