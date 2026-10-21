/**
 * STATE MACHINE: RoseAppPanelDrawer (the right-panel slot for non-browser apps)
 *
 *   openApp ∈ {integrations, benchmarks, feedback, health, settings} --> [OPEN(app)]
 *   anything else --> [CLOSING] the shell keeps the last body while it slides
 *                     out, then --after DRAWER_DURATION_MS--> [CLOSED] body
 *                     unmounted, so a closed panel runs no polls or requests
 *                     (e.g. the Integrations sync-progress poll)
 *   [OPEN] --Escape | its trigger again (icon / left-bar row)--> [CLOSING]
 *
 * Header = icon + title; no close X (the triggers toggle, UI ledger row 67).
 * Bodies reuse existing pages (loaded lazily through the pages layer; features
 * never import other features):
 *   integrations → Integrations page   benchmarks → BenchmarksView
 *   health       → AdminHealth page ("Biz health", admins only)
 *   settings     → admin account switcher (inline, admins only; it replaced the
 *                  floating top-right pill for Rose Desktop accounts), then the
 *                  Settings page with its own tabs (Customization · Personal
 *                  Info · Billing · API Keys); Billing adds the payments UI the
 *                  stock left bar's card icon showed; Sign out below the tabs
 *   feedback     → FeedbackAppPanel (existing submitFeedback)
 */

import { Loader2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

import SidebarCreditIndicator from '../SidebarCreditIndicator';
import { AppDrawerShell } from './AppDrawerShell';
import { FeedbackAppPanel } from './FeedbackAppPanel';
import { DRAWER_DURATION_MS } from './roseAppsLayout';
import { useRoseApps, type RoseApp } from './roseAppsState';

const ProjectsHub = lazy(() => import('../rose-sidebar/ProjectsHub'));
const IntegrationsPage = lazy(() => import('@/pages/Integrations'));
const BenchmarksPage = lazy(() => import('@/pages/Benchmarks'));
const SettingsPage = lazy(() => import('@/pages/Settings'));
const AdminHealthPage = lazy(() => import('@/pages/AdminHealth'));
const AccountSwitcherPage = lazy(() => import('@/pages/AccountSwitcher'));

type PanelApp = Extract<
  RoseApp,
  'integrations' | 'benchmarks' | 'feedback' | 'health' | 'settings' | 'projects'
>;

const PANELS: Record<PanelApp, { title: string }> = {
  projects: { title: 'Projects' },
  integrations: { title: 'Integrations' },
  benchmarks: { title: 'Benchmarks' },
  feedback: { title: 'Feedback' },
  health: { title: 'Biz health' },
  settings: { title: 'Settings' },
};

function isPanelApp(app: RoseApp | null): app is PanelApp {
  return app !== null && app in PANELS;
}

function Fallback() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-[hsl(240_8%_45%)] dark:text-[#a3a39d]" />
    </div>
  );
}

function BillingPayments() {
  return (
    <section aria-label="Payments" data-testid="rose-billing-payments" className="space-y-2">
      <p className="font-medium">Credits</p>
      <SidebarCreditIndicator isCollapsed={false} />
    </section>
  );
}

function SettingsBody({ onLogout }: { onLogout?: () => void }) {
  return (
    <div className="px-5 pb-6">
      <AccountSwitcherPage />
      <SettingsPage embedded billingExtra={<BillingPayments />} />
      {onLogout !== undefined && (
        <button type="button" onClick={onLogout} className="mt-6 font-semibold text-[#e5484d]">
          Sign out
        </button>
      )}
    </div>
  );
}

function PanelBody({ app }: { app: PanelApp }): ReactNode {
  const apps = useRoseApps();
  if (app === 'projects') return <ProjectsHub />;
  if (app === 'integrations') return <IntegrationsPage />;
  if (app === 'benchmarks') return <BenchmarksPage onOpenAgent={apps?.openAgent} />;
  if (app === 'feedback') return <FeedbackAppPanel />;
  if (app === 'health') return <AdminHealthPage />;
  return <SettingsBody onLogout={apps?.onLogout} />;
}

export function RoseAppPanelDrawer() {
  const apps = useRoseApps();
  const openApp = apps?.openApp ?? null;
  // Keep the last panel's body while the shell slides out, then unmount it.
  const [shown, setShown] = useState<PanelApp | null>(null);
  if (isPanelApp(openApp) && shown !== openApp) setShown(openApp);
  const open = isPanelApp(openApp);
  useEffect(() => {
    if (open || shown === null) return undefined;
    const timer = window.setTimeout(() => setShown(null), DRAWER_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, shown]);
  if (apps === null) return null;
  const meta = shown === null ? null : PANELS[shown];
  return (
    <AppDrawerShell open={open} label={`${meta?.title ?? 'App'} panel`} testId="rose-app-panel">
      {shown !== null && meta !== null && (
        <>
          <div
            data-testid="rose-app-panel-header"
            className="flex h-[56px] flex-none items-center border-b border-gray-200/90 px-[18px] pr-12 text-sm dark:border-white/[0.07] md:pr-56"
          >
            <b className="font-semibold">{meta.title}</b>
          </div>
          <div data-testid={`rose-app-panel-${shown}`} className="min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<Fallback />}>
              <PanelBody app={shown} />
            </Suspense>
          </div>
        </>
      )}
    </AppDrawerShell>
  );
}
