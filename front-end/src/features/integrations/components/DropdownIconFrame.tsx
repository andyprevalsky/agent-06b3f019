/**
 * STATE MACHINE: DropdownIconFrame
 *
 * [RAW_ICON_ASSET|RAW_GLYPH] --wrap--> [FRAMED_DROPDOWN_ICON]
 *
 * System context:
 *   Integrations dropdown row -> DropdownIconFrame -> consistent 32px icon art
 *     inside a 1px diagonal border shared by row icons and parent dropdown icons.
 *     Synced rows keep their original icon and signal status with a static rose glow.
 */

import type { CSSProperties, ReactNode } from 'react';

import {
  liquidMetalBorderBackground,
  roseIconGlowGradient,
} from '@/components/ui/liquidMetalBorder';

interface DropdownIconFrameProps {
  children: ReactNode;
  className?: string;
  iconFit?: 'contain' | 'cover' | 'fill';
  iconScale?: number;
  isSynced?: boolean;
  /** Override the synced glow gradient (defaults to roseIconGlowGradient, the rose glow). */
  glowGradient?: string;
}

export const dropdownIconImageClassName = 'h-8 w-8 object-cover';

/**
 * Amber glow for a connected-but-damaged integration. Same shape and opacity as
 * the rose glow so the row reads as "still connected, needs attention" rather
 * than as a different kind of element; only the hue changes.
 */
export const warningGlowGradient =
  'linear-gradient(to bottom left, rgba(245, 158, 11, 0.5), rgba(251, 191, 36, 0.45), rgba(252, 211, 77, 0.45), rgba(245, 158, 11, 0.5))';

export const DropdownIconPreset = {
  browserMain: { iconScale: 62, iconFit: 'contain' },
  chrome: { iconScale: 100, iconFit: 'cover' },
  brave: { iconScale: 88, iconFit: 'cover' },
  safari: { iconScale: 87, iconFit: 'cover' },
  edge: { iconScale: 66, iconFit: 'cover' },
  arc: { iconScale: 71, iconFit: 'cover' },
  opera: { iconScale: 67, iconFit: 'cover' },
  vivaldi: { iconScale: 67, iconFit: 'cover' },
  chromium: { iconScale: 60, iconFit: 'cover' },
  applePasswords: { iconScale: 108, iconFit: 'cover' },
  atlas: { iconScale: 100, iconFit: 'cover' },
  passwordsMain: { iconScale: 62, iconFit: 'contain' },
  computeMain: { iconScale: 62, iconFit: 'contain' },
  claude: { iconScale: 56, iconFit: 'contain' },
  chatgpt: { iconScale: 66, iconFit: 'contain' },
  gemini: { iconScale: 60, iconFit: 'cover' },
  messagesMain: { iconScale: 69, iconFit: 'contain' },
  imessage: { iconScale: 100, iconFit: 'cover' },
  gmail: { iconScale: 58, iconFit: 'contain' },
  whatsapp: { iconScale: 100, iconFit: 'cover' },
  telegram: { iconScale: 100, iconFit: 'cover' },
  messenger: { iconScale: 104, iconFit: 'cover' },
  socialsMain: { iconScale: 73, iconFit: 'contain' },
  x: { iconScale: 100, iconFit: 'cover' },
  linkedin: { iconScale: 100, iconFit: 'cover' },
  instagram: { iconScale: 100, iconFit: 'cover' },
  agentPay: { iconScale: 82, iconFit: 'contain' },
  plaid: { iconScale: 64, iconFit: 'contain' },
  fileSystem: { iconScale: 62, iconFit: 'contain' },
  pebbleIndex: { iconScale: 108, iconFit: 'cover' },
} as const;

export function BrowserDropdownIconPreset(
  type: string,
): Pick<DropdownIconFrameProps, 'iconFit' | 'iconScale'> {
  switch (type) {
    case 'chrome':
      return DropdownIconPreset.chrome;
    case 'brave':
      return DropdownIconPreset.brave;
    case 'safari':
      return DropdownIconPreset.safari;
    case 'edge':
      return DropdownIconPreset.edge;
    case 'arc':
      return DropdownIconPreset.arc;
    case 'opera':
      return DropdownIconPreset.opera;
    case 'vivaldi':
      return DropdownIconPreset.vivaldi;
    case 'chromium':
      return DropdownIconPreset.chromium;
    case 'atlas':
      return DropdownIconPreset.atlas;
    default:
      return DropdownIconPreset.chromium;
  }
}

export default function DropdownIconFrame({
  children,
  className = '',
  iconFit = 'cover',
  iconScale = 100,
  isSynced = false,
  glowGradient = roseIconGlowGradient,
}: DropdownIconFrameProps): JSX.Element {
  return (
    <div className="relative h-[34px] w-[34px] shrink-0">
      {isSynced && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[3px] rounded-xl opacity-75 blur-sm"
          style={{ backgroundImage: glowGradient }}
        />
      )}
      <div
        className={`relative z-10 flex h-[34px] w-[34px] items-center justify-center overflow-hidden rounded-lg border border-transparent shadow-[0_1px_2px_rgba(0,0,0,0.16)] [&>*]:h-full [&>*]:w-full [&>*]:scale-[var(--dropdown-icon-scale)] [&>*]:[object-fit:var(--dropdown-icon-fit)] ${className}`}
        style={
          {
            '--dropdown-icon-fit': iconFit,
            '--dropdown-icon-scale': String(iconScale / 100),
            background: liquidMetalBorderBackground('#f5f5f5'),
          } as CSSProperties
        }
      >
        {children}
      </div>
    </div>
  );
}
