import type { RouteEntry } from './types';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';

import Index from '@/features/index';
import Privacy from '@/features/privacy';
import Terms from '@/features/terms';
import NotFound from '@/features/not-found';
import About from '@/features/about';
import Terminal from '@/features/terminal';
import ResearchBlog from '@/features/research-blog';
import ResearchBlogPost from '@/features/research-blog-post';
import Download from '@/features/download';
import TestPayment from '@/features/test-payment';
import GatePlayground from '@/features/gate-playground';
import { PlaidOAuthRedirect } from '@/features/integrations';
import Waitlist from '@/pages/Waitlist';

/**
 * Application route table.
 * ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE.
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  { path: '/', component: Terminal },
  { path: '/privacy', component: Privacy },
  { path: '/terms', component: Terms },
  { path: '/about', component: About },
  { path: '/terminal', component: Index },
  { path: '/research', component: ResearchBlog },
  { path: '/research/:slug', component: ResearchBlogPost },
  { path: '/download', component: Download },
  { path: '/waitlist', component: Waitlist },
  { path: '/test_payment', component: TestPayment },
  { path: '/gate-playground', component: GatePlayground },
  { path: '/plaid-oauth-redirect', component: PlaidOAuthRedirect },
  { path: '*', component: NotFound, isCatchAll: true },
] as const;

/** Amplitude analytics configuration. */
export const AMPLITUDE_API_KEY = 'ff5280db0f34594af90323d5ef9e3e34';

/** Session replay sample rate (1 = capture all sessions). */
export const SESSION_REPLAY_SAMPLE_RATE = 1;

/** Delay (ms) before re-measuring viewport height after orientation/focus events. */
export const VH_REMEASURE_DELAY_MS = 100;

/** Minimum desktop width before adaptive rem scaling is enabled. */
export const VIEWPORT_SCALE_MIN_WIDTH = 768;

/** Design dimensions where the app renders at its default 16px root rem. */
export const VIEWPORT_SCALE_DESIGN_WIDTH = 1440;
export const VIEWPORT_SCALE_DESIGN_HEIGHT = 900;

/** Smallest root rem scale for compact desktop windows. Mirrors repeated browser zoom-out. */
export const VIEWPORT_SCALE_MIN = 0.7;

/** Dev log endpoint path (appended to VITE_BACKEND_API_URL). */
export const DEV_LOG_ENDPOINT = '/api/dev/log';

/** Whether the app is running in Vite dev mode. */
export const IS_DEV = import.meta.env.DEV;

/** Backend API base URL, with any trailing slash stripped. */
export const BACKEND_URL = BACKEND_BASE_URL;
