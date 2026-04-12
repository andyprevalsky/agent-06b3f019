/**
 * STATE MACHINE: TerminalHeader
 *
 * STATIC: Floating blur header with Rose branding, research button, and attention inbox.
 *         No internal state — purely prop-driven.
 */

import { useNavigate } from 'react-router-dom';

import { AttentionInbox } from '@/features/terminal-component-group';

import type { DripStyles } from '../types';

interface TerminalHeaderProps {
  onCreateNewAgent: () => void;
  onSelectAgent: (agentId: string | null) => void;
  clientSource: string;
  realtimeReady: boolean;
  dripStyles: DripStyles;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  shadowIntensity: number;
}

export function TerminalHeader({
  onCreateNewAgent,
  onSelectAgent,
  clientSource,
  realtimeReady,
  dripStyles,
  blur,
  backgroundColors,
  borderColor,
  shadowIntensity,
}: TerminalHeaderProps) {
  const navigate = useNavigate();

  return (
    <header
      className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center justify-between px-1 py-1 rounded-2xl border border-border/50 dark:border-navi-light-black/50 shadow-lg"
      style={{
        width: '320px',
        backdropFilter:
          blur > 0
            ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
            : undefined,
        WebkitBackdropFilter:
          blur > 0
            ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
            : undefined,
        backgroundColor:
          backgroundColors > 0 ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})` : undefined,
        borderColor: borderColor > 0 ? dripStyles.borderRgb : undefined,
        boxShadow:
          shadowIntensity > 0
            ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
            : undefined,
      }}
    >
      {/* Marble gradient background */}
      {backgroundColors > 0 && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(circle at 10% 20%, rgba(255, 248, 245, ${0.7 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%),
                         radial-gradient(circle at 90% 80%, rgba(248, 245, 255, ${0.6 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%),
                         radial-gradient(circle at 50% 50%, rgba(255, 252, 255, ${0.5 * dripStyles.backgroundColorsScalar}) 0%, transparent 60%)`,
            opacity: 0.3 + dripStyles.backgroundColorsScalar * 0.5,
            zIndex: -1,
          }}
        />
      )}
      <div className="flex items-center space-x-1">
        <button
          type="button"
          onClick={onCreateNewAgent}
          className="flex items-center space-x-2.5 px-1 cursor-pointer hover:opacity-80 transition-opacity"
        >
          <div
            className="w-8 h-8 rounded-lg"
            style={{
              background:
                'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          ></div>
          <span className="text-base font-semibold tracking-tight">Rose</span>
        </button>
      </div>

      {/* Research Button - Mobile web only */}
      {clientSource === 'WEB' && (
        <button
          onClick={() => navigate('/research')}
          className="md:hidden absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          Research
        </button>
      )}

      {/* Attention Inbox */}
      <AttentionInbox onSelectAgent={onSelectAgent} realtimeReady={realtimeReady} />
    </header>
  );
}
