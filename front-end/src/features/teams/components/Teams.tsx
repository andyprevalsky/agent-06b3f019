/**
 * STATE MACHINE: Teams
 * [SIGNED_OUT] | [LOADING] → [ERROR + RETRY | EMPTY | READY]
 * [EMPTY/READY] → name + Create team → [CREATING] → [SELECTED | ERROR]
 * [READY] → select team → [SELECTED]; accept invitation → refetch membership.
 * Closing the drawer unmounts the bounded membership poll.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw, Users } from 'lucide-react';
import { acceptTeamInvitation, createTeam, previewTeamInvitation } from '@/lib/api/teams';
import {
  captureTeamInviteLink,
  clearTeamInviteLink,
  removeTeamInviteFromUrl,
} from '@/lib/teamInviteLink';
import { useTeamMutation, useTeams } from '@/hooks/useTeams';
import TeamDetails from './TeamDetails';

export default function Teams() {
  const teams = useTeams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [inviteLink, setInviteLink] = useState(captureTeamInviteLink);
  useEffect(removeTeamInviteFromUrl, []);
  const create = useTeamMutation(async (title: string) => {
    const team = await createTeam(title);
    setSelectedId(team.id);
    setName('');
    return team;
  });
  const accept = useTeamMutation(async (id: string) => {
    const team = await acceptTeamInvitation(id, inviteLink.token ?? '');
    clearTeamInviteLink();
    setInviteLink({ teamId: null, token: null });
    setSelectedId(team.id);
    return team;
  });
  const knownInvitation = teams.data?.invitations.some((team) => team.id === inviteLink.teamId);
  const knownMember = teams.data?.teams.some((team) => team.id === inviteLink.teamId);
  const invitationPreview = useQuery({
    queryKey: ['team-invitation', teams.userId, inviteLink.teamId],
    queryFn: ({ signal }) => previewTeamInvitation(inviteLink.teamId!, inviteLink.token!, signal),
    enabled:
      !!teams.userId &&
      !!inviteLink.teamId &&
      !!inviteLink.token &&
      teams.isSuccess &&
      !knownMember &&
      !knownInvitation,
    retry: false,
    staleTime: 0,
  });
  const invitations = [
    ...(teams.data?.invitations ?? []),
    ...(invitationPreview.data && !knownInvitation ? [invitationPreview.data] : []),
  ].filter((team) => !teams.data?.teams.some((joined) => joined.id === team.id));
  const selected = teams.data?.teams.find((team) => team.id === selectedId) ?? teams.data?.teams[0];
  if (!teams.userId)
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Teams</h1>
        <p className="mt-3 text-sm">Sign in to create or join a team.</p>
      </div>
    );
  return (
    <main aria-label="Teams" className="mx-auto max-w-3xl space-y-6 p-5 pb-12 sm:p-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Users className="text-[#e8507f]" size={24} /> Teams
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Work together with control over what you share.
          </p>
        </div>
        <button
          type="button"
          aria-label="Refresh teams"
          disabled={teams.isFetching}
          onClick={() => void teams.refetch()}
          className="rounded-lg p-2 hover:bg-muted disabled:opacity-40"
        >
          <RefreshCw size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
        className="flex gap-2"
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New team title</span>
          <input
            aria-label="New team title"
            placeholder="New team title"
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-[#e8507f] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          <Plus size={16} />
          {create.isPending ? 'Creating…' : 'Create team'}
        </button>
      </form>
      {create.isError && (
        <p role="alert" className="text-sm text-red-600">
          {create.error.message}
        </p>
      )}
      {teams.isPending && <p role="status">Loading teams…</p>}
      {teams.isError && (
        <div role="alert" className="text-sm text-red-600">
          {teams.error.message}{' '}
          <button onClick={() => void teams.refetch()} className="underline">
            Retry
          </button>
        </div>
      )}
      {invitationPreview.isFetching && <p role="status">Checking invitation link…</p>}
      {invitationPreview.isError && (
        <p role="alert" className="text-sm text-red-600">
          {invitationPreview.error.message}
        </p>
      )}
      {invitations.map((team) => (
        <section
          key={team.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e8507f]/30 bg-[#e8507f]/5 p-4"
        >
          <div>
            <h2 className="font-semibold">Invitation to {team.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Accept to join. Your data stays private until you choose to share.
            </p>
          </div>
          {inviteLink.teamId === team.id && inviteLink.token ? (
            <button
              disabled={accept.isPending}
              onClick={() => accept.mutate(team.id)}
              className="text-sm font-semibold text-[#e8507f]"
            >
              {accept.isPending ? 'Accepting…' : 'Accept invitation'}
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Open the invitation email to accept securely.
            </p>
          )}
        </section>
      ))}
      {accept.isError && (
        <p role="alert" className="text-sm text-red-600">
          {accept.error.message}
        </p>
      )}
      {teams.data?.teams.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Users className="mx-auto mb-3 text-muted-foreground" size={28} />
          <h2 className="font-semibold">Your first team starts here</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Give it a title, invite people by email, then choose the accounts and projects to share.
          </p>
        </div>
      )}
      {(teams.data?.teams.length ?? 0) > 1 && (
        <nav aria-label="Your teams" className="flex flex-wrap gap-2">
          {teams.data?.teams.map((team) => (
            <button
              key={team.id}
              onClick={() => setSelectedId(team.id)}
              aria-pressed={selected?.id === team.id}
              className="rounded-full border border-border px-3 py-1.5 text-sm aria-pressed:border-[#e8507f] aria-pressed:text-[#e8507f]"
            >
              {team.name}
            </button>
          ))}
        </nav>
      )}
      {selected && <TeamDetails key={`${teams.userId}:${selected.id}`} team={selected} />}
    </main>
  );
}
