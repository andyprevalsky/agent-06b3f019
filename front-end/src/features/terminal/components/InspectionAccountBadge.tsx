import type { InspectionContext } from '@/lib/api';

interface InspectionAccountBadgeProps {
  context: InspectionContext | null;
}

/**
 * STATE MACHINE: Admin account inspection badge
 *
 * [HIDDEN] -- foreign run response includes owner identity --> [VISIBLE]
 * [VISIBLE] -- select own/another run or clear selection ----> [HIDDEN]
 * [VISIBLE] -- foreign identity response replaces context ----> [VISIBLE, UPDATED]
 */
export function InspectionAccountBadge({ context }: InspectionAccountBadgeProps) {
  if (context === null) return null;

  return (
    <aside
      aria-live="polite"
      className="fixed left-1/2 top-16 z-[60] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 rounded-xl border border-amber-500/70 bg-amber-50/95 px-4 py-3 text-amber-950 shadow-xl backdrop-blur-md dark:bg-amber-950/95 dark:text-amber-50"
      data-testid="inspection-account-badge"
      role="status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Inspecting User Account:</p>
        <span className="rounded-full bg-amber-200/80 px-2 py-0.5 text-xs font-medium text-amber-950 dark:bg-amber-800 dark:text-amber-50">
          Read-only
        </span>
      </div>
      <dl className="mt-2 grid gap-x-5 gap-y-1 text-xs sm:grid-cols-3 sm:text-sm">
        <IdentityField label="Name" value={context.name} />
        <IdentityField label="Phone" value={context.phone} />
        <IdentityField label="Email" value={context.email} />
      </dl>
    </aside>
  );
}

function IdentityField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-amber-800 dark:text-amber-200">{label}</dt>
      <dd className="break-words">{value ?? 'Not provided'}</dd>
    </div>
  );
}
