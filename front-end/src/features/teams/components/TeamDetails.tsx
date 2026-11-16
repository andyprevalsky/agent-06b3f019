/**
 * STATE MACHINE: TeamDetails
 * [VIEW] → edit title → [DRAFT] → Save → [SAVING] → [VIEW | ERROR].
 * [VIEW] + refreshed team.name → [VIEW] (untouched draft follows the server name);
 * [DRAFT] + refreshed team.name → [DRAFT] (in-progress edit is preserved).
 * Invite email: FAILED/UNAVAILABLE/PENDING → Retry; UNKNOWN → explicit Resend (may duplicate).
 * Members/opt-ins reflect refetched server state. Remove requires confirmation;
 * shares are changed one account/project and one team at a time.
 * "Your shared accounts" lists every shareable connected account (everything except
 * iPhone, browser cookies, passwords and Pebble Index 01) by integration name + label.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, Mail, Users } from 'lucide-react';
import { fetchProjects } from '@/lib/api/projects';
import {
  removeTeamMember,
  inviteDeliveryLabel,
  inviteTeamMember,
  renameTeam,
  setTeamIntegration,
  setTeamProject,
  isAccountShared,
  integrationLabel,
  type Team,
} from '@/lib/api/teams';
import { TeamShareToggle } from '@/components/teams/TeamSharing';
import { useShareableIntegrations, useTeamMutation, useTeamSession } from '@/hooks/useTeams';
import TeamInvite from './TeamInvite';

export default function TeamDetails({ team }: { team: Team }) {
  const [title, setTitle] = useState({ base: team.name, value: team.name });
  if (title.base !== team.name)
    setTitle({ base: team.name, value: title.value === title.base ? team.name : title.value });
  const name = title.value;
  const setName = (value: string) => setTitle((current) => ({ ...current, value }));
  const [removing, setRemoving] = useState<string | null>(null);
  const userId = useTeamSession();
  const rename = useTeamMutation((title: string) => renameTeam(team.id, title));
  const remove = useTeamMutation(async (memberId: string) => {
    await removeTeamMember(team.id, memberId);
    setRemoving(null);
  });
  const retryInvite = useTeamMutation(
    ({ email, resendUncertain }: { email: string; resendUncertain: boolean }) =>
      inviteTeamMember(team.id, email, resendUncertain),
  );
  const accounts = useShareableIntegrations();
  const projects = useQuery({
    queryKey: ['team-owned-projects', userId],
    queryFn: fetchProjects,
    enabled: !!userId,
    retry: false,
  });
  return (
    <div className="space-y-7">
      <section>
        {team.role === 'OWNER' ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) rename.mutate(name.trim());
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="sr-only">Team title</span>
              <input
                aria-label="Team title"
                maxLength={100}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full border-b border-transparent bg-transparent py-2 text-2xl font-semibold focus:border-[#e8507f] focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={rename.isPending || !name.trim() || name.trim() === team.name}
              className="text-sm font-medium text-[#e8507f] disabled:opacity-40"
            >
              {rename.isPending ? 'Saving…' : 'Save title'}
            </button>
          </form>
        ) : (
          <h2 className="text-2xl font-semibold">{team.name}</h2>
        )}
        {rename.isError && (
          <p role="alert" className="text-sm text-red-600">
            {rename.error.message}
          </p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Members choose which accounts and projects to share. Joining shares nothing automatically.
        </p>
      </section>
      <section aria-label="Team members">
        <h3 className="flex items-center gap-2 font-semibold">
          <Users size={17} /> Members{' '}
          <span className="text-sm font-normal text-muted-foreground">{team.members.length}</span>
        </h3>
        <ul className="mt-3 divide-y divide-border">
          {team.members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">
                  {member.name ?? member.email ?? 'Team member'}
                  {member.userId === userId ? ' (you)' : ''}
                </p>
                {member.email && (
                  <p className="break-all text-xs text-muted-foreground">{member.email}</p>
                )}
                <p className="mt-1 text-xs">
                  <span
                    className={
                      member.onRose
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-muted-foreground'
                    }
                  >
                    {member.onRose ? '● On Rose' : 'Not on Rose yet'}
                  </span>{' '}
                  · {member.status === 'ACCEPTED' ? 'Joined' : 'Invited · awaiting acceptance'} ·{' '}
                  {member.role === 'OWNER' ? 'Owner' : 'Member'}
                  {member.status === 'INVITED'
                    ? ` · ${inviteDeliveryLabel(member.inviteDeliveryStatus)}`
                    : ''}
                </p>
              </div>
              {team.role === 'OWNER' && member.role !== 'OWNER' && (
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {member.email &&
                    member.status === 'INVITED' &&
                    ['FAILED', 'UNAVAILABLE', 'PENDING'].includes(
                      member.inviteDeliveryStatus ?? '',
                    ) && (
                      <button
                        type="button"
                        disabled={retryInvite.isPending}
                        aria-label={`Retry invitation email to ${member.email}`}
                        onClick={() => {
                          if (member.email)
                            retryInvite.mutate({ email: member.email, resendUncertain: false });
                        }}
                        className="text-[#e8507f]"
                      >
                        Retry email
                      </button>
                    )}
                  {member.email &&
                    member.status === 'INVITED' &&
                    member.inviteDeliveryStatus === 'UNKNOWN' && (
                      <button
                        type="button"
                        disabled={retryInvite.isPending}
                        aria-label={`Resend invitation email to ${member.email} (it may already have arrived)`}
                        onClick={() => {
                          if (member.email)
                            retryInvite.mutate({ email: member.email, resendUncertain: true });
                        }}
                        className="text-[#e8507f]"
                      >
                        Resend email
                      </button>
                    )}
                  {removing === member.id ? (
                    <>
                      <span>Remove and revoke shares?</span>
                      <button
                        disabled={remove.isPending}
                        className="text-red-600"
                        onClick={() => remove.mutate(member.id)}
                      >
                        Confirm remove
                      </button>
                      <button onClick={() => setRemoving(null)}>Cancel</button>
                    </>
                  ) : (
                    <button
                      className="text-muted-foreground hover:text-red-600"
                      onClick={() => setRemoving(member.id)}
                      aria-label={`Remove ${member.email ?? member.name ?? `team member ${member.id.slice(-6)}`}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {remove.isError && (
          <p role="alert" className="text-sm text-red-600">
            {remove.error.message}
          </p>
        )}
        {retryInvite.isError && (
          <p role="alert" className="text-sm text-red-600">
            {retryInvite.error.message}
          </p>
        )}
        {team.role === 'OWNER' && <TeamInvite team={team} />}
      </section>
      <section aria-label="Team integration sharing">
        <h3 className="flex items-center gap-2 font-semibold">
          <Mail size={17} /> Your shared accounts
        </h3>
        <p className="my-2 text-sm text-muted-foreground">
          Opt in per account. Every connected integration can be shared except iPhone, browser
          cookies, passwords, and Pebble Index 01. Credentials stay private.
        </p>
        {accounts.isPending && <p role="status">Loading accounts…</p>}
        {accounts.isError && (
          <p role="alert" className="text-sm text-red-600">
            {accounts.error.message}
          </p>
        )}
        {accounts.data?.integrations.map((account) => (
          <TeamShareToggle
            key={account.id}
            label={`Share ${integrationLabel(account)}`}
            checked={isAccountShared(team, account)}
            save={(shared) => setTeamIntegration(team.id, account.id, shared)}
          />
        ))}
        {accounts.data?.integrations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Connect an integration in Integrations to share it here.
          </p>
        )}
        {team.integrationShares
          .filter((share) => share.ownerUserId !== userId)
          .map((share) => (
            <p key={share.id} className="mt-2 text-sm text-muted-foreground">
              {share.ownerName ?? 'Team member'} shares {integrationLabel(share)}
            </p>
          ))}
      </section>
      <section aria-label="Team project sharing">
        <h3 className="flex items-center gap-2 font-semibold">
          <Folder size={17} /> Projects
        </h3>
        <p className="my-2 text-sm text-muted-foreground">
          Share projects individually. Environment files and credentials remain private.
        </p>
        {projects.isPending && <p role="status">Loading projects…</p>}
        {projects.isError && (
          <p role="alert" className="text-sm text-red-600">
            {projects.error.message}
          </p>
        )}
        {projects.data?.map((project) => (
          <TeamShareToggle
            key={project.id}
            label={`Share project ${project.name}`}
            checked={team.projectShares.some((share) => share.projectId === project.id)}
            save={(shared) => setTeamProject(team.id, project.id, shared)}
          />
        ))}
        {projects.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No projects to share yet.</p>
        )}
        {team.projectShares
          .filter((share) => share.ownerUserId !== userId)
          .map((share) => (
            <p key={share.id} className="mt-2 text-sm">
              {share.name}{' '}
              <span className="text-muted-foreground">
                · Shared by {share.ownerName ?? 'Team member'}
              </span>
            </p>
          ))}
      </section>
    </div>
  );
}
