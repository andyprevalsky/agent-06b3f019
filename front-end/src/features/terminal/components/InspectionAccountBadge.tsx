import { Eye } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { TOP_RIGHT_INSPECTION_SLOT_ID } from '@/components/TopRightControls';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { InspectionContext } from '@/lib/api/types';

interface InspectionAccountBadgeProps {
  context: InspectionContext | null;
}

/**
 * STATE MACHINE: Admin account inspection badge
 *
 * [HIDDEN] -- foreign run response includes owner identity --> [PORTALLED PILL]
 * [PORTALLED PILL] -- hover/focus --> [IDENTITY TOOLTIP]
 * [PORTALLED PILL] -- select own/another run or clear selection --> [HIDDEN]
 * [PORTALLED PILL] -- foreign identity replaces context --> [PORTALLED PILL, UPDATED]
 */
export function InspectionAccountBadge({ context }: InspectionAccountBadgeProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setSlot(document.getElementById(TOP_RIGHT_INSPECTION_SLOT_ID));
  }, []);

  if (context === null || slot === null) return null;

  const primaryLabel = context.name ?? context.phone ?? context.email ?? context.user_id;
  const identitySummary = [context.name, context.phone, context.email]
    .filter((value): value is string => value !== null)
    .join(', ');

  return createPortal(
    <Tooltip>
      <TooltipTrigger asChild>
        <aside
          aria-label={`Inspecting ${identitySummary || context.user_id} (read-only)`}
          aria-live="polite"
          className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur-md"
          data-testid="inspection-account-badge"
          role="status"
          tabIndex={0}
        >
          <Eye className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
          <span className="truncate">Inspecting {primaryLabel}</span>
        </aside>
      </TooltipTrigger>
      <TooltipContent align="end" side="bottom" className="max-w-xs">
        <p className="text-xs font-semibold">Inspecting user account · Read-only</p>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <IdentityField label="Name" value={context.name} />
          <IdentityField label="Phone" value={context.phone} />
          <IdentityField label="Email" value={context.email} />
        </dl>
      </TooltipContent>
    </Tooltip>,
    slot,
  );
}

function IdentityField({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ?? 'Not provided'}</dd>
    </>
  );
}
