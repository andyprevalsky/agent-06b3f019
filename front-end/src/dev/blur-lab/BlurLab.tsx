/**
 * STATE MACHINE: BlurLab (diagnostic panel, only mounted with ?blurlab=1)
 *
 * [COLLAPSED] --tap "Blur lab"--> [OPEN]
 * [OPEN] --tap toggle--> effect applied (revert fn stored); tap again --> reverted
 * [OPEN] --Rescan--> top-band fixed/sticky list refreshed
 * [OPEN] --Report--> computed-style text of the top 80px shown in the panel
 * [OPEN] --tap "Reset all"--> every active effect reverted
 * unmount --> every active effect reverted
 *
 * Lives at the bottom of the screen, away from the top band under inspection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CSS_EFFECTS,
  STATUS_STYLES,
  findTopElements,
  hideElement,
  injectCss,
  setStatusBarStyle,
  topBandReport,
  type TopElement,
} from './blurLabEffects';

type Revert = () => void;

const buttonClass = 'rounded border border-white/40 px-2 py-1 text-left text-[11px]';

export default function BlurLab() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const [tops, setTops] = useState<TopElement[]>([]);
  const [report, setReport] = useState('');
  const reverts = useRef(new Map<string, Revert>());

  const toggle = useCallback((key: string, apply: () => Revert) => {
    const existing = reverts.current.get(key);
    if (existing) {
      existing();
      reverts.current.delete(key);
    } else {
      reverts.current.set(key, apply());
    }
    setActive(new Set(reverts.current.keys()));
  }, []);

  const resetAll = useCallback(() => {
    reverts.current.forEach((revert) => revert());
    reverts.current.clear();
    setActive(new Set());
  }, []);

  useEffect(() => {
    const store = reverts.current;
    return () => {
      store.forEach((revert) => revert());
      store.clear();
    };
  }, []);

  const rescan = useCallback(() => setTops(findTopElements()), []);

  const mark = (key: string) => (active.has(key) ? 'bg-emerald-600 text-white' : 'text-white');

  return (
    <div
      data-blurlab-panel
      data-testid="blur-lab"
      className="fixed inset-x-0 bottom-0 z-[100000] bg-black/90 p-2 text-white"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <button type="button" className={buttonClass} onClick={() => setOpen((v) => !v)}>
        Blur lab {open ? '(close)' : '(open)'}
      </button>
      {open && (
        <div className="mt-2 max-h-[55vh] space-y-2 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1">
            {CSS_EFFECTS.map((effect) => (
              <button
                key={effect.id}
                type="button"
                data-testid={`blurlab-${effect.id}`}
                className={`${buttonClass} ${mark(effect.id)}`}
                onClick={() => {
                  if (effect.id.startsWith('pos-') || effect.id.startsWith('header-')) rescan();
                  toggle(effect.id, () => injectCss(effect.id, effect.css));
                }}
              >
                {effect.label}
              </button>
            ))}
          </div>
          <div className="text-[11px]">
            Status-bar style (iOS reads at launch: reopen or re-add the app to see it):
          </div>
          <div className="grid grid-cols-3 gap-1">
            {STATUS_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                data-testid={`blurlab-status-${style}`}
                className={`${buttonClass} ${mark(`status-${style}`)}`}
                onClick={() => toggle(`status-${style}`, () => setStatusBarStyle(style))}
              >
                {style}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            Hide one top element
            <button type="button" className={buttonClass} onClick={rescan}>
              Rescan
            </button>
          </div>
          <div className="grid grid-cols-1 gap-1">
            {tops.map((top, i) => (
              <button
                key={`${top.label}-${i}`}
                type="button"
                data-testid={`blurlab-hide-${i}`}
                className={`${buttonClass} ${mark(`hide-${i}`)}`}
                onClick={() => toggle(`hide-${i}`, () => hideElement(top.el))}
              >
                hide {top.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              data-testid="blurlab-report"
              className={buttonClass}
              onClick={() => setReport(topBandReport())}
            >
              Print top-80px styles
            </button>
            <button type="button" className={buttonClass} onClick={resetAll}>
              Reset all
            </button>
          </div>
          {report && (
            <pre
              data-testid="blurlab-report-output"
              className="whitespace-pre-wrap break-all text-[9px] leading-tight"
            >
              {report}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
