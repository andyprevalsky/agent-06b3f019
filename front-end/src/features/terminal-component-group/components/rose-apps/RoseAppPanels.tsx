/**
 * STATE MACHINE: RoseAppPanelDrawer (the right-panel slot for non-browser apps)
 *
 *   openApp ∈ {integrations, benchmarks, feedback, health, settings} --> [OPEN(app)]
 *   anything else --> [CLOSED] (the shell keeps the last body while it slides out)
 *   [OPEN] --Escape | its trigger again (icon / left-bar row)--> [CLOSED]
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

import {
  Activity,
  FlaskConical,
  Loader2,
  Megaphone,
  Plug,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import SidebarCreditIndicator from '../SidebarCreditIndicator';
import { AppDrawerShell } from './AppDrawerShell';
import { FeedbackAppPanel } from './FeedbackAppPanel';
import { useRoseApps, type RoseApp } from './roseAppsState';

const IntegrationsPage = lazy(() => import('@/pages/Integrations'));
const BenchmarksPage = lazy(() => import('@/pages/Benchmarks'));
const SettingsPage = lazy(() => import('@/pages/Settings'));
const AdminHealthPage = lazy(() => import('@/pages/AdminHealth'));
const AccountSwitcherPage = lazy(() => import('@/pages/AccountSwitcher'));

type PanelApp = Extract<
  RoseApp,
  'integrations' | 'benchmarks' | 'feedback' | 'health' | 'settings'
>;

const PANELS: Record<PanelApp, { title: string; icon: LucideIcon }> = {
  integrations: { title: 'Integrations', icon: Plug },
  benchmarks: { title: 'Benchmarks', icon: FlaskConical },
  feedback: { title: 'Feedback', icon: Megaphone },
  health: { title: 'Biz health', icon: Activity },
  settings: { title: 'Settings', icon: SettingsIcon },
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
  if (app === 'integrations') return <IntegrationsPage />;
  if (app === 'benchmarks') return <BenchmarksPage onOpenAgent={apps?.openAgent} />;
  if (app === 'feedback') return <FeedbackAppPanel />;
  if (app === 'health') return <AdminHealthPage />;
  return <SettingsBody onLogout={apps?.onLogout} />;
}

export function RoseAppPanelDrawer() {
  const apps = useRoseApps();
  const openApp = apps?.openApp ?? null;
  // Keep the last panel's body while the shell slides out.
  const [shown, setShown] = useState<PanelApp | null>(null);
  if (isPanelApp(openApp) && shown !== openApp) setShown(openApp);
  if (apps === null) return null;
  const open = isPanelApp(openApp);
  const meta = shown === null ? null : PANELS[shown];
  return (
    <AppDrawerShell open={open} label={`${meta?.title ?? 'App'} panel`} testId="rose-app-panel">
      {shown !== null && meta !== null && (
        <>
          <div className="flex flex-none items-center gap-2.5 border-b border-gray-200/90 px-3.5 py-3 text-[13px] dark:border-white/[0.09]">
            <meta.icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.7} />
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
