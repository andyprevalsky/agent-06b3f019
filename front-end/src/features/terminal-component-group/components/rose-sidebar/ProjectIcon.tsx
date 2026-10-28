/**
 * STATE MACHINE: ProjectIcon (Rose project row icon, UI item 32)
 *
 *   repoUrl without a GitHub owner (none, other host, unparseable) --> [FOLDER]
 *   GitHub owner, URL not known to fail --> [AVATAR] <img> owner avatar
 *   [AVATAR] --img error--> [FOLDER]; the URL is remembered as failed for this
 *                           page load, so remounts (bar collapse/expand) never retry
 *
 * PENDING (prop, owned by the left bar): the project the next new agent will be
 * created in (its "+" was clicked). The icon then sits in the integration
 * ("interface") icons' liquid-metal ring (liquidMetalBorderBackground in
 * components/ui, shared with DropdownIconFrame) with their drop shadow and a soft rose glow
 * (roseIconGlowGradient); the tile stays #f5f5f5 with a dark glyph in dark
 * mode too, as the interface icons do. Screen readers hear "(new agents go here)".
 *   [AT REST] --pending--> [PENDING ring + shadow + glow] --!pending--> [AT REST]
 *
 * Same 20px box as the folder, a square with modest rounding; decorative
 * (alt=""), the row's text names the project. One stable URL per owner, so the
 * browser cache serves every row and surface; no polling or API calls.
 */

import { Folder } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';

import {
  liquidMetalBorderBackground,
  roseIconGlowGradient,
} from '@/components/ui/liquidMetalBorder';

import { githubOwnerAvatarUrl, githubRepoOwner } from './githubRepoOwner';

const FAILED_AVATAR_URLS = new Set<string>();

function OwnerAvatar({ src }: { src: string }) {
  const [failed, setFailed] = useState(() => FAILED_AVATAR_URLS.has(src));
  if (failed) return <Folder className="h-5 w-5 flex-none" strokeWidth={1.7} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => {
        FAILED_AVATAR_URLS.add(src);
        setFailed(true);
      }}
      className="h-5 w-5 flex-none rounded-[4px] object-cover"
    />
  );
}

// Same light tile as the interface icons in both themes (they keep #f5f5f5 in dark).
const PENDING_RING_STYLE: CSSProperties = { background: liquidMetalBorderBackground('#f5f5f5') };

/** Liquid-metal ring + shadow + rose glow around a 20px sidebar icon (no layout shift). */
export function PendingProjectFrame({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}) {
  if (!pending) return <>{children}</>;
  return (
    <span
      data-testid="pending-project-frame"
      className="relative inline-grid h-5 w-5 flex-none place-items-center"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-[6px] rounded-[10px] opacity-75 blur-[5px]"
        style={{ backgroundImage: roseIconGlowGradient }}
      />
      <span
        aria-hidden="true"
        data-testid="pending-project-ring"
        className="pointer-events-none absolute -inset-[3px] rounded-[7px] border border-transparent shadow-[0_1px_3px_rgba(0,0,0,0.22)]"
        style={PENDING_RING_STYLE}
      />
      {/* On the light tile the glyph stays dark in both themes, like the interface icons. */}
      <span className="relative grid h-5 w-5 place-items-center text-[hsl(240_8%_30%)]">
        {children}
      </span>
      <span className="sr-only">(new agents go here)</span>
    </span>
  );
}

function ProjectGlyph({ repoUrl }: { repoUrl: string | null }) {
  const owner = githubRepoOwner(repoUrl);
  if (owner === null) return <Folder className="h-5 w-5 flex-none" strokeWidth={1.7} />;
  const src = githubOwnerAvatarUrl(owner);
  // Keyed by URL: an edited repo gets a fresh load attempt for its new owner.
  return <OwnerAvatar key={src} src={src} />;
}

export default function ProjectIcon({
  repoUrl,
  pending = false,
}: {
  repoUrl: string | null;
  pending?: boolean;
}) {
  return (
    <PendingProjectFrame pending={pending}>
      <ProjectGlyph repoUrl={repoUrl} />
    </PendingProjectFrame>
  );
}
