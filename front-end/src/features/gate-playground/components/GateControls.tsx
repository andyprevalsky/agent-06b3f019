// GateControls — the design panel. Controlled component: it holds no state of
// its own; it renders the current GateDesign + gateType and calls back on every
// change. Small primitives (Segmented / Slider / Toggle / Swatches) are defined
// inline to stay dependency-free (no ui/slider primitive exists in this repo).

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  ACCENTS,
  GATE_PRESETS,
  GATE_TYPE_ORDER,
  ROSE_GRADIENT,
  type AccentKey,
  type ButtonStyle,
  type GateDesign,
  type GateTypeKey,
  type GateVariant,
} from '../presets';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
            value === opt.value
              ? 'border-transparent bg-primary text-primary-foreground'
              : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="block space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
    >
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
            checked ? 'left-0.5 translate-x-3' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

function Swatches({
  value,
  onChange,
}: {
  value: AccentKey;
  onChange: (v: AccentKey) => void;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      {(Object.keys(ACCENTS) as AccentKey[]).map((key) => {
        const a = ACCENTS[key];
        return (
          <button
            key={key}
            type="button"
            title={a.label}
            onClick={() => onChange(key)}
            className={cn(
              'h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition-all',
              value === key ? 'ring-2 ring-foreground' : 'ring-0',
            )}
            style={{ background: a.gradient ?? a.dot }}
          />
        );
      })}
    </div>
  );
}

export interface GateControlsProps {
  gateType: GateTypeKey;
  design: GateDesign;
  dark: boolean;
  showSms: boolean;
  onGateType: (t: GateTypeKey) => void;
  onDesign: (patch: Partial<GateDesign>) => void;
  onDark: (v: boolean) => void;
  onShowSms: (v: boolean) => void;
  onReset: () => void;
}

export function GateControls(props: GateControlsProps): JSX.Element {
  const { gateType, design, dark, showSms, onDesign } = props;

  return (
    <div className="space-y-5">
      <Section title="Gate type">
        <Segmented
          value={gateType}
          onChange={props.onGateType}
          options={GATE_TYPE_ORDER.map((k) => ({ value: k, label: GATE_PRESETS[k].label }))}
        />
      </Section>

      <Section title="Layout option">
        <p className="text-[11px] text-muted-foreground">Card family (roomy — fits receipts)</p>
        <Segmented<GateVariant>
          value={design.variant}
          onChange={(variant) => onDesign({ variant })}
          options={[
            { value: 'card', label: 'Card' },
            { value: 'card_header', label: 'Header' },
            { value: 'card_rail', label: 'Rail' },
            { value: 'card_split', label: 'Split' },
            { value: 'card_hero', label: 'Hero' },
          ]}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">Compact</p>
        <Segmented<GateVariant>
          value={design.variant}
          onChange={(variant) => onDesign({ variant })}
          options={[
            { value: 'inline', label: 'Inline' },
            { value: 'banner', label: 'Banner' },
            { value: 'chip', label: 'Chip' },
          ]}
        />
      </Section>

      <Section title="Accent">
        <Swatches value={design.accent} onChange={(accent) => onDesign({ accent })} />
      </Section>

      <Section title="Button style">
        <Segmented<ButtonStyle>
          value={design.buttonStyle}
          onChange={(buttonStyle) => onDesign({ buttonStyle })}
          options={[
            { value: 'filled', label: 'Filled' },
            { value: 'outline', label: 'Outline' },
            {
              value: 'gradient',
              label: (
                <span
                  className="bg-clip-text text-transparent"
                  style={{ backgroundImage: ROSE_GRADIENT }}
                >
                  Gradient
                </span>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Tokens">
        <div className="space-y-3">
          <Slider
            label="Corner radius"
            value={design.radius}
            min={0}
            max={28}
            suffix="px"
            onChange={(radius) => onDesign({ radius })}
          />
          <Slider
            label="Density (padding)"
            value={design.padding}
            min={8}
            max={28}
            suffix="px"
            onChange={(padding) => onDesign({ padding })}
          />
          <Slider
            label="Accent intensity"
            value={design.accentIntensity}
            min={0}
            max={40}
            suffix="%"
            onChange={(accentIntensity) => onDesign({ accentIntensity })}
          />
          <Slider
            label="Elevation"
            value={design.elevation}
            min={0}
            max={3}
            onChange={(elevation) => onDesign({ elevation })}
          />
          <Slider
            label="Border weight"
            value={design.borderEmphasis}
            min={0}
            max={2}
            onChange={(borderEmphasis) => onDesign({ borderEmphasis })}
          />
        </div>
      </Section>

      <Section title="Elements">
        <div className="grid grid-cols-2 gap-1.5">
          <Toggle
            label="Icon"
            checked={design.showIcon}
            onChange={(v) => onDesign({ showIcon: v })}
          />
          <Toggle
            label="Status dot"
            checked={design.showStatusDot}
            onChange={(v) => onDesign({ showStatusDot: v })}
          />
          <Toggle
            label="Reason text"
            checked={design.showReason}
            onChange={(v) => onDesign({ showReason: v })}
          />
          <Toggle
            label="Full width"
            checked={design.fullWidth}
            onChange={(v) => onDesign({ fullWidth: v })}
          />
        </div>
      </Section>

      <Section title="Preview">
        <div className="grid grid-cols-2 gap-1.5">
          <Toggle label="Dark mode" checked={dark} onChange={props.onDark} />
          <Toggle label="SMS render" checked={showSms} onChange={props.onShowSms} />
        </div>
      </Section>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <button
          type="button"
          onClick={props.onReset}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Reset
        </button>
        <span className="text-xs text-muted-foreground">
          {design.variant} · {ACCENTS[design.accent].label} · r{design.radius}
        </span>
      </div>
    </div>
  );
}
