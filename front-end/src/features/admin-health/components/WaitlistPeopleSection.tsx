/**
 * STATE MACHINE: WaitlistPeopleSection
 *
 * [LOADING] --fetch ok--> [READY] --(no phone rows)--> [EMPTY]
 *     |                      |
 *     +--fetch err--> [ERROR]|
 *                            |
 * Per row (independent):
 *   [IDLE] --click Invite--> [SENDING] --ok--> [INVITED] (row stamped, gate cleared)
 *                                |
 *                                +--err--> [IDLE] (toast error, retryable)
 *
 * The list comes from GET /api/admin-health/waitlist (the same phone-bearing
 * population the signup metric counts). "Invite" POSTs to
 * /api/admin-health/waitlist/:id/invite, which clears the invite gate for the
 * matching account and texts the Mac-app download link via Surge.
 */

import { useMemo } from 'react';
import { Loader2, Send } from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

import { useWaitlistPeople } from '../hooks';
import type { AdminWaitlistPerson } from '../types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

type StatusTone = 'invited' | 'gated' | 'in-app' | 'no-account';

function personStatus(person: AdminWaitlistPerson): { label: string; tone: StatusTone } {
  if (person.invitedAt !== null) return { label: 'Invited', tone: 'invited' };
  if (!person.hasAccount) return { label: 'No account yet', tone: 'no-account' };
  if (person.isGated) return { label: 'On waitlist', tone: 'gated' };
  return { label: 'In app', tone: 'in-app' };
}

const TONE_CLASS: Record<StatusTone, string> = {
  invited: 'bg-emerald-500/12 text-emerald-600 border-emerald-500/25',
  gated: 'bg-amber-500/12 text-amber-600 border-amber-500/25',
  'in-app': 'bg-sky-500/12 text-sky-600 border-sky-500/25',
  'no-account': 'bg-muted text-muted-foreground border-border/60',
};

function StatusPill({ person }: { person: AdminWaitlistPerson }) {
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

function SectionPanel({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-lg font-semibold">Waitlist People</h2>
      </div>
      {children}
    </section>
  );
}

export default function WaitlistPeopleSection() {
  const { toast } = useToast();
  const { people, error, invitingIds, invite } = useWaitlistPeople();

  const pendingCount = useMemo(
    () => (people ?? []).filter((person) => person.invitedAt === null).length,
    [people],
  );

  const handleInvite = (person: AdminWaitlistPerson) => {
    invite(person.id)
      .then((result) => {
        toast({
          title: result.smsSent ? 'Invite sent' : 'Invite recorded',
          description: result.smsSent
            ? `Texted ${person.phone} · flagged to subscribe`
            : `Flagged to subscribe · SMS skipped (non-production)`,
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

  if (error !== null) {
    return (
      <SectionPanel eyebrow="Text a download link to pull people off the waitlist">
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      </SectionPanel>
    );
  }

  if (people === null) {
    return (
      <SectionPanel eyebrow="Text a download link to pull people off the waitlist">
        <div className="flex h-[200px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </SectionPanel>
    );
  }

  return (
    <SectionPanel eyebrow={`${people.length} on the waitlist · ${pendingCount} not yet invited`}>
      {people.length === 0 ? (
        <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
          No one on the waitlist yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs uppercase tracking-normal text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Phone</th>
                <th className="py-2 pr-4 font-medium">Joined</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pl-4 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const inviting = invitingIds.has(person.id);
                const invited = person.invitedAt !== null;
                return (
                  <tr key={person.id} className="border-b border-border/40 last:border-0">
                    <td className="py-2.5 pr-4 font-medium">{person.name.trim() || '—'}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                      {person.phone}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {formatDate(person.joinedAt)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill person={person} />
                    </td>
                    <td className="py-2.5 pl-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleInvite(person)}
                        disabled={inviting}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
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
                        {inviting ? 'Sending…' : invited ? 'Re-send' : 'Invite & text'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionPanel>
  );
}
