/**
 * STATE MACHINE: SidebarCreditIndicator
 *
 * [LOADING] <-- loading: true (initial)
 *     |
 *     | (fetchCreditsUsage resolves)
 *     v
 * [LOADED] <-- usage populated (or null on failure)
 *     |
 *     | (30s poll)
 *     v
 * [LOADED]
 *
 * [MODAL_CLOSED] <-- showSubscriptionModal: false
 *     |
 *     | (user clicks indicator)
 *     v
 * [MODAL_OPEN] <-- showSubscriptionModal: true
 */

import { useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';
import SubscriptionModal from '@/components/SubscriptionModal';
import SidebarTooltip from './SidebarTooltip';
import { CREDITS_POLL_INTERVAL_MS } from '../config';
import { fetchCreditsUsage } from '../hooks';
import type { UsageData } from '../types';

const EMPTY_COLOR = '#ef4444';
const LOW_COLOR = '#f97316';
const MEDIUM_COLOR = '#eab308';
const HIGH_COLOR = '#22c55e';

function getRingColor(credits: number, isEmpty: boolean): string {
  if (isEmpty) return EMPTY_COLOR;
  if (credits <= 2) return LOW_COLOR;
  if (credits <= 5) return MEDIUM_COLOR;
  return HIGH_COLOR;
}

interface RingGeometry {
  size: number;
  radius: number;
  strokeWidth: number;
  circumference: number;
  strokeDashoffset: number;
  color: string;
}

function computeGeometry(isCollapsed: boolean, credits: number, loading: boolean, isEmpty: boolean): RingGeometry {
  const size = isCollapsed ? 40 : 32;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const percentage = loading ? 50 : Math.min(100, (credits / 10) * 100);
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  return {
    size,
    radius,
    strokeWidth,
    circumference,
    strokeDashoffset,
    color: getRingColor(credits, isEmpty),
  };
}

function CreditRing({ size, radius, strokeWidth, circumference, strokeDashoffset, color }: RingGeometry) {
  return (
    <>
      <svg className="absolute" width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-gray-200 dark:text-zinc-700"
        />
      </svg>
      <svg className="absolute -rotate-90" width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className="transition-all duration-500"
        />
      </svg>
    </>
  );
}

function useCreditsPolling(): { usage: UsageData | null; loading: boolean } {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchCreditsUsage();
        if (!cancelled) setUsage(data);
      } catch (error) {
        if (!cancelled) console.error('Error fetching credits:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), CREDITS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { usage, loading };
}

interface IndicatorBodyProps {
  geom: RingGeometry;
  isCollapsed: boolean;
  isEmpty: boolean;
  loading: boolean;
  credits: number;
}

function IndicatorBody({ geom, isCollapsed, isEmpty, loading, credits }: IndicatorBodyProps) {
  return (
    <>
      <div
        className="relative flex items-center justify-center"
        style={{ width: geom.size, height: geom.size }}
      >
        <CreditRing {...geom} />
        <CreditCard
          className={cn(
            'relative z-10',
            isEmpty ? 'text-red-500' : 'text-gray-600 dark:text-gray-400',
          )}
          style={{ width: geom.size * 0.45, height: geom.size * 0.45 }}
        />
      </div>
      {!isCollapsed && (
        <div className="flex flex-col">
          <span
            className={cn(
              'text-sm font-medium',
              isEmpty ? 'text-red-500' : 'text-gray-700 dark:text-gray-300',
            )}
          >
            {loading ? '...' : credits}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-500">credits</span>
        </div>
      )}
    </>
  );
}

export default function SidebarCreditIndicator({ isCollapsed }: { isCollapsed: boolean }) {
  const { usage, loading } = useCreditsPolling();
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);

  const credits = usage ? Math.floor(usage.remaining) : 0;
  const isEmpty = credits === 0 && !loading;
  const geom = computeGeometry(isCollapsed, credits, loading, isEmpty);

  return (
    <>
      <SidebarTooltip label={`${credits} credits remaining`} isCollapsed={isCollapsed}>
        <div
          onClick={() => setShowSubscriptionModal(true)}
          className={cn(
            'flex items-center gap-2 rounded-lg transition-all duration-200 cursor-pointer',
            'hover:bg-gray-100 dark:hover:bg-zinc-800',
            isCollapsed ? 'justify-center p-2 mx-auto' : 'px-3 py-2',
          )}
        >
          <IndicatorBody
            geom={geom}
            isCollapsed={isCollapsed}
            isEmpty={isEmpty}
            loading={loading}
            credits={credits}
          />
        </div>
      </SidebarTooltip>

      <SubscriptionModal
        open={showSubscriptionModal}
        onOpenChange={setShowSubscriptionModal}
        currentTier={usage?.tier ?? null}
        upgradeOptions={usage?.upgradeOptions ?? []}
        remaining={usage?.remaining ?? 0}
      />
    </>
  );
}
