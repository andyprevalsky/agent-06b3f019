/**
 * Browser world domain types (plan row A6): the Root browser and its world
 * state split by website.
 */
import { z } from 'zod';

export const openRootBrowserSchema = z
  .object({
    start_url: z.string().url().max(8192).optional(),
  })
  .strict();

export const agentIdParamSchema = z.string().uuid();

/** A registrable domain such as `github.com`; never a URL or a path. */
export const siteParamSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i);

export type ForkState =
  'forked' | 'merged' | 'unchanged' | 'no_login' | 'signed_out' | 'no_login_signal' | 'stale';

export interface RootSiteView {
  site: string;
  revision: number;
  cookie_count: number;
  updated_at: string;
  last_writer: { kind: string | null; task_id: string | null; agent_id: string | null };
}

export interface BrowserTaskLinks {
  /** GET: live-view URL and liveness for this exact task (existing route). */
  live_view_path: string;
  /** GET/POST {mode:'user'|'agent'}: take over or hand back (existing route). */
  control_path: string;
}

export interface RootBrowserView extends BrowserTaskLinks {
  task_id: string;
  session_id: string;
  status: string;
  provider: string;
  live_view_url: string | null;
  forked_sites: number;
}

export interface ForkView {
  site: string;
  state: ForkState;
  base_revision: number;
  merged_revision: number | null;
  root_revision: number;
  forked_at: string;
  merged_at: string | null;
}

export interface AgentBrowserTaskView extends BrowserTaskLinks {
  task_id: string;
  session_id: string;
  status: string;
  live_view_url: string | null;
  sites: ForkView[];
}

export class RootBrowserNotOpenError extends Error {
  constructor() {
    super('Root browser is not open');
    this.name = 'RootBrowserNotOpenError';
  }
}
