/**
 * STATE MACHINE: TeamSharing
 * [LOADING] → [READY | ERROR]; [READY] → explicit checkbox → [SAVING]
 * [SAVING] → refetch authoritative shares → [READY]; failure → [ERROR + unchanged checkbox].
 * Membership never enables sharing. Only the resource owner can issue these writes.
 *
 * AccountTeamShare (one shareable account on its Integrations row: a Gmail address or iMessage):
 *   [PRIVATE] dashed "Share" button
 *   [SHARED]  "Shared with <team>" | "Shared with N teams" (hover → tooltip naming every team) + ⌄
 *   either --click--> [PICKER OPEN]: one checkbox per accepted team, even when there is only one
 *     checkbox --toggle--> [SAVING] (same cycle as above) → caption follows the refetched shares
 *     escape / outside click → closed
 *   Not rendered while loading, signed out, with no accepted team, or for an account the backend
 *   does not list as shareable (damaged Gmail credential, ambiguous iMessage).
 *   A failed teams/accounts load shows once, page-level (TeamShareLoadError).
 *
 * System context:
 *   Integrations page → TeamShareLoadError (top) and each Gmail / iMessage account
 *     (DesktopIntegrations → desktopSectionViews, or stock GmailRow / iMessage row)
 *     → useAccountShares().shareTarget(provider, email) → AccountTeamShare
 *     → GET /teams + GET /teams/shareable-integrations (one shared react-query cache)
 *     → PUT | DELETE /teams/:teamId/integrations/:accountId → refetch both
 */
import { useId, type ReactNode } from 'react';
import { ChevronDown, UserPlus, Users } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  setTeamIntegration,
  setTeamProject,
  isAccountShared,
  type ShareableIntegration,
  type Team,
} from '@/lib/api/teams';
import { useAccountShares, useTeamMutation, useTeams } from '@/hooks/useTeams';

export function TeamShareToggle({
  label,
  detail,
  checked,
  disabled = false,
  save,
}: {
  label: string;
  /** Muted right-aligned note (member count); visual only, not part of the checkbox name. */
  detail?: string;
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
        {detail !== undefined && (
          <span aria-hidden="true" className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {detail}
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

const CAPTION_CLASSES =
  'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground data-[state=open]:bg-black/5 data-[state=open]:text-foreground dark:hover:bg-white/[0.08] dark:data-[state=open]:bg-white/[0.08]';
const PRIVATE_CLASSES = `${CAPTION_CLASSES} border border-dashed border-border hover:text-[#e8507f] data-[state=open]:text-[#e8507f] dark:hover:text-[#ff7aa2] dark:data-[state=open]:text-[#ff7aa2]`;

const accountName = (account: ShareableIntegration) =>
  account.accountEmail ?? (account.provider === 'imessage' ? 'iMessage' : account.name);

function memberCount(team: Team): string {
  const count = team.members.filter((member) => member.status === 'ACCEPTED').length;
  return `${count} ${count === 1 ? 'member' : 'members'}`;
}

/** Hovering "N teams" names every team the account is shared with. */
function TeamsTooltip({ teams, children }: { teams: Team[]; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="text-xs">
          <p className="mb-0.5 text-muted-foreground">Shared with</p>
          {teams.map((team) => (
            <p key={team.id} className="flex items-center gap-1.5">
              <Users className="h-3 w-3 opacity-60" aria-hidden="true" />
              {team.name}
            </p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** "Shared with …" / "Share" beside one account; opens a checkbox per team. */
export function AccountTeamShare({
  account,
  teams,
}: {
  account: ShareableIntegration;
  teams: Team[];
}) {
  const shared = teams.filter((team) => isAccountShared(team, account));
  const name = accountName(account);
  const who = shared.length === 1 ? shared[0].name : `${shared.length} teams`;
  const trigger = (
    <PopoverTrigger asChild>
      {shared.length === 0 ? (
        <button type="button" className={PRIVATE_CLASSES} aria-label={`Share ${name}`}>
          <UserPlus className="h-3 w-3" aria-hidden="true" />
          Share
        </button>
      ) : (
        <button type="button" className={CAPTION_CLASSES} aria-label={`${name} shared with ${who}`}>
          <Users className="h-3 w-3" aria-hidden="true" />
          Shared with
          <span
            className={`font-medium text-foreground/85 ${shared.length > 1 ? 'underline decoration-dotted underline-offset-2' : ''}`}
          >
            {who}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
        </button>
      )}
    </PopoverTrigger>
  );
  return (
    <Popover>
      {shared.length > 1 ? <TeamsTooltip teams={shared}>{trigger}</TeamsTooltip> : trigger}
      <PopoverContent
        align="start"
        aria-label={`Share ${name} with teams`}
        className="z-[230] w-64 rounded-xl p-3"
      >
        <p className="text-[13px] font-medium">Share with teams</p>
        <p className="mb-1 truncate text-[11.5px] text-muted-foreground">{name}</p>
        {teams.map((team) => (
          <TeamShareToggle
            key={team.id}
            label={team.name}
            detail={memberCount(team)}
            checked={isAccountShared(team, account)}
            save={(next) => setTeamIntegration(team.id, account.id, next)}
          />
        ))}
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
          Teammates&apos; agents can read this account&apos;s messages. Credentials stay private.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** The one page-level notice when sharing settings fail to load (captions stay hidden). */
export function TeamShareLoadError() {
  const { error } = useAccountShares();
  if (error === null) return null;
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-300">
      Team sharing unavailable: {error}
    </p>
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
