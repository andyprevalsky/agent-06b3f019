/**
 * Browser world domain types (plan row A6): the user's one browser template,
 * split by website and account, and the home browser that shows it.
 */
import { z } from 'zod';
import type { SiteMergeOutcome } from '../../providers/browser/worldState';

export const openRootBrowserSchema = z
  .object({
    start_url: z.string().url().max(8192).optional(),
    // Root agent whose tree's active browser task supplies the default URL.
    agent_id: z.string().uuid().optional(),
  })
  .strict();

export const agentIdParamSchema = z.string().uuid();

/** A registrable domain such as `github.com`; never a URL or a path. */
export const siteParamSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i);

export type ForkState = 'forked' | SiteMergeOutcome;

export interface RootSiteView {
  site: string;
  /** Template account: the rose_root CookieBundle's browserProfile ('' = Rose's own). */
  account: string;
  revision: number;
  cookie_count: number;
  validated_at: string | null;
  auth_expires_at: string | null;
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
  /** The URL this home browser session opened at (null: the provider default). */
  start_url: string | null;
  forked_sites: number;
}

export interface ForkView {
  site: string;
  account: string;
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
