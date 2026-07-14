// GatePlayground — design sandbox for the Gate card (docs/plans/active/
// sms-onboarding-and-gates.md). Dev route: /gate-playground.
//
// State (all local, no network — pure UI prototype):
//   gateType : GateTypeKey       ── selects the content preset + faux thread
//   design   : GateDesign        ── every visual knob the sliders drive
//   dark     : boolean           ── toggles the `dark` class on the preview only
//   showSms  : boolean           ── also render the plain-text SMS version
//
// Flow:
//   GateControls ──(onGateType / onDesign patch / onDark / onShowSms)──►
//     setState ──► re-render preview (FauxChat wrapping GateCard [+ SmsPreview]).
//   Switching gateType re-seeds `design.accent` to that preset's default accent.
//   Reset ──► DEFAULT_DESIGN (seeded with the current preset's accent).
//   Nothing here touches attention-requests or the backend.

import { useMemo, useState } from 'react';
import { GateCard } from './GateCard';
import { FauxChat, SmsPreview } from './FauxChat';
import { GateControls } from './GateControls';
import { DEFAULT_DESIGN, GATE_PRESETS, type GateDesign, type GateTypeKey } from '../presets';

export default function GatePlayground(): JSX.Element {
  const [gateType, setGateType] = useState<GateTypeKey>('subscription');
  const [design, setDesign] = useState<GateDesign>({
    ...DEFAULT_DESIGN,
    accent: GATE_PRESETS.subscription.defaultAccent,
  });
  const [dark, setDark] = useState(false);
  const [showSms, setShowSms] = useState(true);

  const preset = GATE_PRESETS[gateType];

  const configJson = useMemo(() => JSON.stringify(design, null, 2), [design]);

  const handleGateType = (t: GateTypeKey): void => {
    setGateType(t);
    setDesign((d) => ({ ...d, accent: GATE_PRESETS[t].defaultAccent }));
  };

  const patchDesign = (patch: Partial<GateDesign>): void => {
    setDesign((d) => ({ ...d, ...patch }));
  };

  const handleReset = (): void => {
    setDesign({ ...DEFAULT_DESIGN, accent: preset.defaultAccent });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Gate card playground</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Design the standard Gate object rendered in a live agent chat. Pick a gate type and a
            layout option, then tune the tokens. See{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              docs/plans/active/sms-onboarding-and-gates.md
            </code>
            .
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
          {/* control panel */}
          <aside className="lg:sticky lg:top-8 lg:self-start">
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <GateControls
                gateType={gateType}
                design={design}
                dark={dark}
                showSms={showSms}
                onGateType={handleGateType}
                onDesign={patchDesign}
                onDark={setDark}
                onShowSms={setShowSms}
                onReset={handleReset}
              />
            </div>
            <details className="mt-3 rounded-xl border border-border bg-card p-3 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                design config (copy into plan)
              </summary>
              <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-foreground">
                {configJson}
              </pre>
            </details>
          </aside>

          {/* live preview */}
          <main className="space-y-4">
            <div className="mx-auto w-full max-w-xl">
              <FauxChat preset={preset} dark={dark}>
                <GateCard design={design} preset={preset} />
              </FauxChat>
            </div>

            {showSms && (
              <div className="mx-auto w-full max-w-xl">
                <div className="rounded-2xl border border-border bg-background p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Same gate over SMS (the minimal path)
                  </p>
                  <SmsPreview preset={preset} />
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
