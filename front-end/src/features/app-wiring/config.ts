import { createElement, lazy } from 'react';
import type { RouteEntry } from './types';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';
import Terminal from '@/features/terminal';
import { AgentContext, type AgentContextValue } from '@/features/agent-context';
import { GranolaCallback, PlaidOAuthRedirect } from '@/features/integrations';

const Index = lazy(() => import('@/features/index'));
const Privacy = lazy(() => import('@/features/privacy'));
const Terms = lazy(() => import('@/features/terms'));
const NotFound = lazy(() => import('@/features/not-found'));
const About = lazy(() => import('@/features/about'));
const ResearchBlog = lazy(() => import('@/features/research-blog'));
const ResearchBlogPost = lazy(() => import('@/features/research-blog-post'));
const Careers = lazy(() => import('@/features/careers'));
const CareersRole = lazy(() =>
  import('@/features/careers').then((m) => ({ default: m.CareersRole })),
);
const Download = lazy(() => import('@/features/download'));
const TestPayment = lazy(() => import('@/features/test-payment'));
const GatePlayground = lazy(() => import('@/features/gate-playground'));
const Waitlist = lazy(() => import('@/pages/Waitlist'));
const OpenAgentRedirect = lazy(() => import('@/features/open-agent-redirect'));

/** Design harness code is never loaded by the production app. */
const DEV_ROUTES: readonly RouteEntry[] = import.meta.env.DEV
  ? [
      {
        path: '/mobile-preview',
        component: lazy(async () => {
          const { default: MobilePreview, PREVIEW_AGENT_CONTEXT } =
            await import('@/features/mobile-preview');
          return {
            default: () =>
              createElement(
                AgentContext.Provider,
                { value: PREVIEW_AGENT_CONTEXT as unknown as AgentContextValue },
                createElement(MobilePreview),
              ),
          };
        }),
      },
    ]
  : [];

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
  { path: '/careers', component: Careers },
  { path: '/careers/:slug', component: CareersRole },
  { path: '/download', component: Download },
  { path: '/waitlist', component: Waitlist },
  { path: '/open-agent', component: OpenAgentRedirect },
  { path: '/test_payment', component: TestPayment },
  { path: '/gate-playground', component: GatePlayground },
  { path: '/plaid-oauth-redirect', component: PlaidOAuthRedirect },
  { path: '/integrations/granola/callback', component: GranolaCallback },
  ...DEV_ROUTES,
  { path: '*', component: NotFound, isCatchAll: true },
];

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
