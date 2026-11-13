/**
 * STATE MACHINE: TeamSharing
 * [LOADING] → [READY | ERROR]; [READY] → explicit checkbox → [SAVING]
 * [SAVING] → refetch authoritative shares → [READY]; failure → [ERROR + unchanged checkbox].
 * Membership never enables sharing. Only the resource owner can issue these writes.
 */
import { useId } from 'react';
import {
  setTeamIntegration,
  setTeamProject,
  isAccountShared,
  integrationLabel,
} from '@/lib/api/teams';
import { useShareableIntegrations, useTeamMutation, useTeams } from '@/hooks/useTeams';

export function TeamShareToggle({
  label,
  checked,
  disabled = false,
  save,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  save: (shared: boolean) => Promise<unknown>;
}) {
  const mutation = useTeamMutation(save);
  const errorId = useId();
  return (
    <div className="py-1.5">
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || mutation.isPending}
          aria-describedby={mutation.isError ? errorId : undefined}
          className="h-4 w-4 accent-[#e8507f]"
          onChange={(event) => mutation.mutate(event.target.checked)}
        />
        <span className="min-w-0 break-words">{label}</span>
        {mutation.isPending && (
          <span role="status" className="text-xs text-muted-foreground">
            Saving…
          </span>
        )}
      </label>
      {mutation.isError && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-600">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}

/** Also used on Integrations: each account chooses each accepted team independently. */
export function IntegrationTeamSharing() {
  const teams = useTeams();
  const accounts = useShareableIntegrations();
  if (!teams.userId) return null;
  return (
    <section aria-label="Integration team sharing" className="rounded-xl border border-border p-5">
      <h2 className="font-semibold">Share integration data with teams</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose each account and team explicitly. New connections stay private. Email and iMessage
        data can be shared; iPhone access and credentials stay private.
      </p>
      {(teams.isPending || accounts.isPending) && (
        <p role="status" className="mt-3 text-sm">
          Loading sharing settings…
        </p>
      )}
      {(teams.isError || accounts.isError) && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {teams.error?.message || accounts.error?.message}
        </p>
      )}
      {accounts.data?.integrations.map((account) => (
        <fieldset key={account.id} className="mt-4 border-t border-border pt-3">
          <legend className="text-sm font-medium">{integrationLabel(account)}</legend>
          {teams.data?.teams.map((team) => (
            <TeamShareToggle
              key={team.id}
              label={`Share ${integrationLabel(account)} with ${team.name}`}
              checked={isAccountShared(team, account)}
              save={(shared) => setTeamIntegration(team.id, account.id, shared)}
            />
          ))}
        </fieldset>
      ))}
      {teams.data?.teams.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Create or join a team to choose what to share.
        </p>
      )}
      {accounts.data?.integrations.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          No connected email or iMessage accounts.
        </p>
      )}
    </section>
  );
}

/** Project Settings reuses the same opt-in API; credentials and settings stay owner-only. */
export function ProjectTeamSharing({ projectId }: { projectId: string }) {
  const teams = useTeams();
  if (!teams.userId) return null;
  return (
    <section aria-label="Project team sharing" className="mt-6 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Team sharing</h3>
      <p className="my-2 text-sm text-muted-foreground">
        Share this project with selected teams. Environment files and credentials stay private.
      </p>
      {teams.isPending && <p role="status">Loading teams…</p>}
      {teams.isError && (
        <p role="alert" className="text-red-600">
          {teams.error.message}
        </p>
      )}
      {teams.data?.teams.map((team) => (
        <TeamShareToggle
          key={team.id}
          label={`Share project with ${team.name}`}
          checked={team.projectShares.some((share) => share.projectId === projectId)}
          save={(shared) => setTeamProject(team.id, projectId, shared)}
        />
      ))}
      {teams.data?.teams.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Create or join a team to share this project.
        </p>
      )}
    </section>
  );
}
