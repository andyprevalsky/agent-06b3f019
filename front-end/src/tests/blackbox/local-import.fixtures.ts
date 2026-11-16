/**
 * A fake Rose Mac app import bridge (window.api.roseCli) for blackbox tests.
 *
 * It answers like the real app running `rose import detect|scan|apply`: every
 * importProject() returns a run id, then the scripted CLI events arrive on
 * onImportEvent (the detect result object, progress, plan, done or error, then
 * exit). Tests read the requests the UI sent and drive the flow.
 */
import { vi } from 'vitest';

import type { LocalAgentId, LocalImportPlan } from '@/hooks/useLocalImport';

export const PICKED_FOLDER = '/Users/andy/code/acme-api';

export function makePlan(overrides: Partial<LocalImportPlan> = {}): LocalImportPlan {
  return {
    projectName: 'acme-api',
    branch: 'main',
    repo: { remoteUrl: 'https://github.com/acme/acme-api', githubRepo: 'acme/acme-api' },
    envFiles: [
      { path: '.env', variables: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] },
      { path: 'web/.env.local', variables: ['NEXT_PUBLIC_API_URL'] },
    ],
    extraFiles: [{ path: 'certs/dev.pem', reason: 'local HTTPS for the dev server' }],
    setupCommands: ['npm ci', 'npx prisma generate'],
    notes: ['Postgres runs locally on port 5432.'],
    github: { status: 'reachable_rose', login: null, canImport: true },
    ...overrides,
  };
}

export interface FakeImportOptions {
  pick?: { canceled: boolean; path?: string };
  agent?: LocalAgentId | null;
  plan?: LocalImportPlan;
  scanError?: string;
  applyError?: string;
  project?: { id: string; name: string };
  /** Hold scan events until release() (to test cancel). */
  holdScan?: boolean;
  /** importProject refuses to start (the Mac app's `{ error }` answer). */
  startError?: string;
  /** Called when apply finishes, before its done event (e.g. to add the project to a mock API). */
  onApplied?: () => void;
}

export function installImportBridge(options: FakeImportOptions = {}) {
  const listeners = new Set<(event: unknown) => void>();
  const requests: Record<string, unknown>[] = [];
  let runs = 0;
  let held: (() => void) | null = null;
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event));
  const later = (fn: () => void) => setTimeout(fn, 0);

  const script = (request: Record<string, unknown>, runId: string) => {
    if (request.action === 'detect') {
      const agent = options.agent === undefined ? 'codex' : options.agent;
      emit({
        runId,
        agents: [
          {
            id: 'codex',
            signedIn: agent === 'codex',
            binary: agent === 'codex' ? '/bin/codex' : null,
          },
          {
            id: 'claude',
            signedIn: agent === 'claude',
            binary: agent === 'claude' ? '/bin/claude' : null,
          },
        ],
        preferred: agent,
      });
      emit({ runId, event: 'exit', code: 0 });
      return;
    }
    if (request.action === 'scan') {
      const finish = () => {
        emit({
          runId,
          event: 'progress',
          stage: 'scan',
          message: 'Reading package.json and README',
        });
        if (options.scanError !== undefined) {
          emit({ runId, event: 'error', message: options.scanError });
          emit({ runId, event: 'exit', code: 1 });
          return;
        }
        emit({ runId, event: 'plan', agent: request.agent, plan: options.plan ?? makePlan() });
        emit({ runId, event: 'exit', code: 0 });
      };
      if (options.holdScan) held = finish;
      else finish();
      return;
    }
    emit({ runId, event: 'progress', stage: 'upload', message: 'Uploading 2 env files' });
    if (options.applyError !== undefined) {
      emit({ runId, event: 'error', message: options.applyError });
      emit({ runId, event: 'exit', code: 1 });
      return;
    }
    options.onApplied?.();
    emit({ runId, event: 'done', project: options.project ?? { id: 'p-acme', name: 'acme-api' } });
    emit({ runId, event: 'exit', code: 0 });
  };

  const bridge = {
    ensureInstalled: vi
      .fn()
      .mockResolvedValue({ success: true, path: '/Users/andy/.rose/bin/rose' }),
    pickProjectFolder: vi
      .fn()
      .mockResolvedValue(options.pick ?? { canceled: false, path: PICKED_FOLDER }),
    importProject: vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      if (options.startError !== undefined) return { error: options.startError };
      runs += 1;
      const runId = `run-${runs}`;
      later(() => script(request, runId));
      return { runId };
    }),
    onImportEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelImport: vi.fn().mockResolvedValue(undefined),
  };
  window.api = { isElectron: true, roseCli: bridge } as unknown as typeof window.api;
  return {
    bridge,
    requests,
    release: () => {
      const run = held;
      held = null;
      run?.();
    },
  };
}

export function removeImportBridge() {
  delete (window as { api?: unknown }).api;
}
