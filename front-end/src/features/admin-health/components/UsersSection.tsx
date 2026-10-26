/**
 * STATE MACHINE: UsersSection
 *
 * [LOADING(page n, q)] --fetch ok--> [READY] --(no rows)--> [EMPTY]
 *        |                              |
 *        +--fetch err--> [ERROR]        +--type in search--> debounced [LOADING(page 1, q')]
 *                                       +--Previous/Next----> [LOADING(page n±1)]
 *
 * Per row (independent):
 *   [IDLE] --Invite--> [SENDING] --ok--> [INVITED] (channels sent, row stamped)
 *                          +--err--> [IDLE] (toast error, retryable)
 *   [IDLE] --Switch to--> mints a session for that account and reloads the app
 *                          as them; the purple top-right badge is the way back.
 *
 * The list comes from GET /api/admin-health/users — real accounts merged with
 * phone-bearing waitlist signups — so an admin can find anyone by name, email,
 * or phone and either pull them off the waitlist or step into their account.
 *
 * AdminHealth owns the directory hook (UsersDirectorySection) so this request
 * starts with the metrics request instead of after it; the default export owns
 * its own hook for standalone use.
 */

import { ArrowLeftRight, ChevronLeft, ChevronRight, Loader2, Search, Send } from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import { displayLabel, type AdminDirectoryPerson } from '@/lib/adminUsers';
import { cn } from '@/lib/utils';

import { useAccountSwitch, useUserDirectory } from '../hooks';
import type { AdminWaitlistInviteResponse } from '../types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

type StatusTone = 'in-app' | 'invited' | 'gated' | 'no-account';

function personStatus(person: AdminDirectoryPerson): { label: string; tone: StatusTone } {
  if (!person.hasAccount) return { label: 'No account yet', tone: 'no-account' };
  if (person.isGated) {
    return person.invitedAt !== null
      ? { label: 'Invited', tone: 'invited' }
      : { label: 'On waitlist', tone: 'gated' };
  }
  return { label: 'In app', tone: 'in-app' };
}

const TONE_CLASS: Record<StatusTone, string> = {
  invited: 'bg-emerald-500/12 text-emerald-600 border-emerald-500/25',
  gated: 'bg-amber-500/12 text-amber-600 border-amber-500/25',
  'in-app': 'bg-sky-500/12 text-sky-600 border-sky-500/25',
  'no-account': 'bg-muted text-muted-foreground border-border/60',
};

function StatusPill({ person }: { person: AdminDirectoryPerson }) {
  const { label, tone } = personStatus(person);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

function inviteGateOutcome(result: AdminWaitlistInviteResponse): string {
  if (result.flagged) return 'flagged to subscribe';
  if (result.alreadyOffWaitlist) return 'already flagged to subscribe';
  if (!result.hasAccount) return 'no account available to flag';
  return 'account status unchanged';
}

function SectionPanel({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-lg font-semibold">Users</h2>
      </div>
      {children}
    </section>
  );
}

function SearchBar({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <label className="mb-4 flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search by name, email, or phone"
        aria-label="Search users"
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

export type UserDirectory = ReturnType<typeof useUserDirectory>;

export default function UsersSection() {
  return <UsersDirectorySection directory={useUserDirectory()} />;
}

export function UsersDirectorySection({ directory }: { directory: UserDirectory }) {
  const { toast } = useToast();
  const {
    people,
    error,
    search,
    setSearch,
    invitingIds,
    invite,
    page,
    pageSize,
    total,
    totalPages,
    previousPage,
    nextPage,
  } = directory;
  const { switchTo, switchingUserId, switchError } = useAccountSwitch();

  const handleInvite = (person: AdminDirectoryPerson) => {
    if (person.waitlistId === null) return;
    invite(person.waitlistId)
      .then((result) => {
        const sent = result.smsSent || result.emailSent;
        const delivery =
          result.smsSent && result.emailSent
            ? 'Sent by text and email'
            : result.smsSent
              ? `Texted ${person.phone ?? 'them'} · no email on file`
              : result.emailSent
                ? 'Sent by email'
                : 'Notifications skipped (non-production)';
        toast({
          title: sent ? 'Invite sent' : 'Invite recorded',
          description: `${delivery} · ${inviteGateOutcome(result)}`,
        });
      })
      .catch((err: unknown) => {
        toast({
          title: 'Invite failed',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      });
  };

  const eyebrow =
    search.trim() === ''
      ? `${total} people · Page ${page} of ${totalPages}`
      : `${total} matching “${search.trim()}” · Page ${page} of ${totalPages}`;

  if (error !== null) {
    return (
      <SectionPanel eyebrow="Search accounts, switch into one, or send an invite">
        <SearchBar value={search} onChange={setSearch} />
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      </SectionPanel>
    );
  }

  const switchFailure =
    switchError === null ? null : (
      <p className="mb-3 text-sm text-destructive">Could not switch account: {switchError}</p>
    );

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <SectionPanel eyebrow={people === null ? 'Loading people…' : eyebrow}>
      <SearchBar value={search} onChange={setSearch} />
      {switchFailure}

      {people === null ? (
        <div className="flex h-[200px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : people.length === 0 ? (
        <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
          {search.trim() === '' ? 'No people yet.' : 'No one matches that search.'}
        </div>
      ) : (
        <div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase tracking-normal text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Phone</th>
                  <th className="py-2 pr-4 font-medium">Joined</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pl-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.key} className="border-b border-border/40 last:border-0">
                    <td className="py-2.5 pr-4 font-medium">{displayLabel(person)}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {person.email?.trim() || '—'}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                      {person.phone ?? '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {formatDate(person.joinedAt)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill person={person} />
                    </td>
                    <td className="py-2.5 pl-4">
                      <div className="flex items-center justify-end gap-2">
                        {person.waitlistId !== null && (
                          <InviteButton
                            inviting={invitingIds.has(person.waitlistId)}
                            invited={person.invitedAt !== null}
                            onClick={() => handleInvite(person)}
                          />
                        )}
                        {person.userId !== null && (
                          <SwitchButton
                            switching={switchingUserId === person.userId}
                            disabled={switchingUserId !== null}
                            label={displayLabel(person)}
                            onClick={() => void switchTo(person.userId as string)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-border/60 pt-4">
            <p className="text-sm text-muted-foreground">
              Showing {rangeStart}–{rangeEnd} of {total}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous page"
                onClick={previousPage}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 rounded-lg border border-border/70 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <button
                type="button"
                aria-label="Next page"
                onClick={nextPage}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 rounded-lg border border-border/70 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionPanel>
  );
}

function InviteButton({
  inviting,
  invited,
  onClick,
}: {
  inviting: boolean;
  invited: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inviting}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
        invited
          ? 'border-border/60 text-muted-foreground hover:bg-muted'
          : 'border-navi-black bg-navi-black text-white hover:bg-navi-black/90',
      )}
    >
      {inviting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Send className="h-3.5 w-3.5" />
      )}
      {inviting ? 'Sending…' : invited ? 'Re-send' : 'Invite, text & email'}
    </button>
  );
}

function SwitchButton({
  switching,
  disabled,
  label,
  onClick,
}: {
  switching: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Switch to ${label}`}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-purple-500/40 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-600 transition-colors hover:bg-purple-500/20 disabled:opacity-50 dark:text-purple-300"
    >
      {switching ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowLeftRight className="h-3.5 w-3.5" />
      )}
      {switching ? 'Switching…' : 'Switch to'}
    </button>
  );
}
