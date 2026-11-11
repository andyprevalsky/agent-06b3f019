/**
 * STATE MACHINE: TeamInvite
 * [EMPTY] → type → [SEARCHING] → [SUGGESTIONS | NO_MATCH | SEARCH_ERROR]
 * → choose exact email → [READY] → Invite → [SENDING] → [INVITED | ERROR].
 * Contacts/on-Rose refresh from the server; identity is never inferred from a name.
 */
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchTeamContacts,
  inviteTeamMember,
  inviteDeliveryLabel,
  type Team,
} from '@/lib/api/teams';
import { useTeamMutation, useTeamSession } from '@/hooks/useTeams';

export default function TeamInvite({ team }: { team: Team }) {
  const [email, setEmail] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [receipt, setReceipt] = useState('');
  const listId = useId();
  const userId = useTeamSession();
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(email.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [email]);
  const contacts = useQuery({
    queryKey: ['team-contacts', userId, search],
    queryFn: ({ signal }) => fetchTeamContacts(search, signal),
    enabled: !!userId && search.length > 0 && open,
    retry: false,
    staleTime: 0,
    refetchInterval: open ? 15_000 : false,
  });
  const mutation = useTeamMutation(async (address: string) => {
    const result = await inviteTeamMember(team.id, address);
    setReceipt(
      `Invitation saved for ${address}. ${inviteDeliveryLabel(result.member.inviteDeliveryStatus ?? (result.delivery.toUpperCase() as import('@/lib/api/teams').InviteDeliveryStatus))}. They must accept before any access is granted.`,
    );
    setEmail('');
    setOpen(false);
    return result;
  });
  const current = team.members.find(
    (member) => member.email?.toLowerCase() === email.trim().toLowerCase(),
  );
  const suggestions = search === email.trim() ? (contacts.data?.contacts ?? []) : [];
  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (current || mutation.isPending || !email.trim()) return;
        mutation.mutate(email.trim());
      }}
    >
      <label htmlFor={`${listId}-input`} className="text-sm font-medium">
        Invite by email
      </label>
      <div className="relative mt-2 flex gap-2">
        <input
          id={`${listId}-input`}
          role="combobox"
          type="email"
          required
          autoComplete="off"
          placeholder="Name or email"
          aria-autocomplete="list"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={email}
          disabled={mutation.isPending}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setEmail(event.target.value);
            setOpen(true);
            setActive(-1);
            setReceipt('');
            mutation.reset();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActive((value) => Math.min(value + 1, suggestions.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) => Math.max(value - 1, 0));
            }
            if (event.key === 'Enter' && open && active >= 0 && suggestions[active]) {
              event.preventDefault();
              setEmail(suggestions[active].email);
              setOpen(false);
              setActive(-1);
            }
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={mutation.isPending || !!current || !email.trim()}
          className="rounded-lg bg-[#e8507f] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {mutation.isPending ? 'Inviting…' : 'Invite'}
        </button>
        {open && suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Contact suggestions"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg"
          >
            {suggestions.map((contact, index) => (
              <li
                key={contact.email}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={active === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setEmail(contact.email);
                  setOpen(false);
                  setActive(-1);
                }}
                className={`cursor-pointer rounded-md px-3 py-2 text-sm hover:bg-muted ${active === index ? 'bg-muted' : ''}`}
              >
                <span className="block font-medium">{contact.name ?? contact.email}</span>
                <span className="block break-all text-xs text-muted-foreground">
                  {contact.email} · {contact.onRose ? 'On Rose' : 'Not on Rose yet'}
                  {team.members.some(
                    (member) => member.email?.toLowerCase() === contact.email.toLowerCase(),
                  )
                    ? ' · Already in team'
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {current && (
        <p className="mt-2 text-sm text-muted-foreground">
          {current.status === 'ACCEPTED' ? 'Already a member.' : 'Invitation already pending.'}
        </p>
      )}
      {open && contacts.isFetching && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Checking contacts…
        </p>
      )}
      {open && contacts.isError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          Contact lookup failed. You can still enter an exact email.
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {mutation.error.message}
        </p>
      )}
      {receipt && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {receipt}
        </p>
      )}
    </form>
  );
}
