/**
 * STATE MACHINE: LocalImportFlow (presentation of hooks/useLocalImport)
 *
 *   idle | picking             --> nothing (the caller's Import / Sync action starts it)
 *   detecting | scanning       --> "Reading <folder> with <Codex|Claude Code>…" + latest progress
 *   no_agent                   --> neither agent is signed in on this Mac + Try again
 *   review                     --> what Rose will import (project, branch, GitHub access,
 *                                  env files by variable NAME, extra files, setup commands,
 *                                  notes) · Import (the caller's Cancel action cancels
 *                                  any state). No GitHub checkbox: whenever this Mac has a
 *                                  GitHub login (gh), the import brings it by default, so
 *                                  code agents clone, push and use gh as the user (the
 *                                  GitHub line says so)
 *   applying                   --> "Importing <name>…" + latest progress
 *   done                       --> "✓ <name> is ready"
 *   failed                     --> the CLI's message + Try again
 *
 * Shared by Integrations › GitHub Repositories › Import from your computer and
 * project settings › Sync from your computer. Secret values never reach here.
 */

import { Check, Loader2 } from 'lucide-react';

import {
  LOCAL_AGENT_LABEL,
  type LocalImportPlan,
  type useLocalImport,
} from '@/hooks/useLocalImport';

const MUTED = 'text-muted-foreground';
const ACTION =
  'shrink-0 text-[12.5px] font-semibold text-[#e8507f] hover:opacity-80 disabled:opacity-50 dark:text-[#ff7aa2]';
const MONO = 'font-mono text-[11.5px]';

function folderName(folder: string): string {
  const parts = folder.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

function Working({ text, detail }: { text: string; detail: string | null }) {
  return (
    <div role="status" className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {text}
      </span>
      {detail !== null && <span className={`${MUTED} text-[12px]`}>{detail}</span>}
    </div>
  );
}

/** This Mac has a GitHub login: the import brings it along by default. */
function usesLocalGithubLogin(plan: LocalImportPlan): boolean {
  return plan.github.canImport;
}

function githubLine(plan: LocalImportPlan): string {
  const repo = plan.repo.githubRepo ?? plan.repo.remoteUrl ?? 'this repository';
  switch (plan.github.status) {
    case 'reachable_user':
      return `${repo} · Rose can reach it as @${plan.github.login ?? 'you'}`;
    case 'reachable_rose':
      return usesLocalGithubLogin(plan)
        ? `${repo} · code agents will use your GitHub login on this Mac`
        : `${repo} · Rose can reach it`;
    case 'unreachable':
      return usesLocalGithubLogin(plan)
        ? `${repo} · code agents will use your GitHub login on this Mac`
        : `${repo} · Rose can't reach it yet: sign in with gh on this Mac, or connect it below`;
    case 'not_github':
      return `${repo} · not on GitHub`;
    case 'no_remote':
      return 'No git remote: Rose keeps the copy it uploads';
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className={MUTED}>{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Review({
  folder,
  agent,
  plan,
  onApprove,
}: {
  folder: string;
  agent: keyof typeof LOCAL_AGENT_LABEL;
  plan: LocalImportPlan;
  onApprove: (githubImport: boolean) => void;
}) {
  return (
    <div data-testid="local-import-review" className="flex flex-col gap-3">
      <p className={MUTED}>
        {LOCAL_AGENT_LABEL[agent]} read {folderName(folder)}. Check what Rose will import:
      </p>
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
        <Row label="Project">{plan.projectName}</Row>
        {plan.branch !== null && (
          <Row label="Branch">
            <span className={MONO}>{plan.branch}</span>
          </Row>
        )}
        <Row label="GitHub">{githubLine(plan)}</Row>
        <Row label="Env files">
          {plan.envFiles.length === 0 ? (
            <span className={MUTED}>None found</span>
          ) : (
            <ul aria-label="Env files" className="flex flex-col gap-0.5">
              {plan.envFiles.map((file) => (
                <li key={file.path}>
                  <span className={MONO}>{file.path}</span>
                  {file.variables.length > 0 && (
                    <span className={MUTED}> · {file.variables.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Row>
        {plan.extraFiles.length > 0 && (
          <Row label="Extra files">
            <ul aria-label="Extra files" className="flex flex-col gap-0.5">
              {plan.extraFiles.map((file) => (
                <li key={file.path}>
                  <span className={MONO}>{file.path}</span>
                  <span className={MUTED}> · {file.reason}</span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {plan.setupCommands.length > 0 && (
          <Row label="Setup">
            <ul aria-label="Setup commands" className="flex flex-col gap-0.5">
              {plan.setupCommands.map((command) => (
                <li key={command} className={MONO}>
                  {command}
                </li>
              ))}
            </ul>
          </Row>
        )}
      </dl>
      {plan.notes.length > 0 && (
        <ul aria-label="Notes" className={`${MUTED} flex list-disc flex-col gap-0.5 pl-4`}>
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <p className={`${MUTED} text-[11.5px]`}>
        Env files are encrypted on this Mac before they upload; their values are never shown.
      </p>
      <button
        type="button"
        onClick={() => onApprove(usesLocalGithubLogin(plan))}
        className={`${ACTION} w-fit`}
      >
        Import
      </button>
    </div>
  );
}

export function LocalImportFlow({ flow }: { flow: ReturnType<typeof useLocalImport> }) {
  const { state } = flow;
  if (state.status === 'idle' || state.status === 'picking') return null;
  return (
    <div data-testid="local-import" className="flex flex-col gap-2 text-[12.5px]">
      {state.status === 'detecting' && (
        <Working text={`Looking for Codex or Claude Code on this Mac…`} detail={null} />
      )}
      {state.status === 'scanning' && (
        <Working
          text={`Reading ${folderName(state.folder)} with ${LOCAL_AGENT_LABEL[state.agent]}…`}
          detail={state.message}
        />
      )}
      {state.status === 'no_agent' && (
        <div role="alert" className="flex flex-col gap-1.5">
          <span>
            Rose reads your project with Codex or Claude Code on this Mac, and neither is signed in.
            Run <span className={MONO}>codex login</span> or <span className={MONO}>claude</span> in
            Terminal, then try again.
          </span>
          <button type="button" onClick={() => void flow.start()} className={`${ACTION} w-fit`}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'review' && (
        <Review
          folder={state.folder}
          agent={state.agent}
          plan={state.plan}
          onApprove={(githubImport) => void flow.approve(githubImport)}
        />
      )}
      {state.status === 'applying' && (
        <Working text={`Importing ${folderName(state.folder)}…`} detail={state.message} />
      )}
      {state.status === 'done' && (
        <span role="status" className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-500" /> {state.project.name} is ready
        </span>
      )}
      {state.status === 'failed' && (
        <div role="alert" className="flex flex-col gap-1.5">
          <span className="text-destructive">{state.message}</span>
          <button type="button" onClick={() => void flow.start()} className={`${ACTION} w-fit`}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
