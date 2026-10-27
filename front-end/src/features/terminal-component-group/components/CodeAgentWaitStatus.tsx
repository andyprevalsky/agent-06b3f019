/**
 * STATE MACHINE: CodeAgentWaitStatus (Rose Desktop, UI ledger row 44)
 *
 * One muted line under the code-agent chips in the root trajectory, derived
 * from the trajectory alone (useRootWaitStatus):
 *   [HIDDEN]  ← flag off, or no live code agent and no open pinned question
 *   [ANSWER]  ← a code agent's pinned question is open
 *               "<agent> is waiting on your answer[, then merges its branch into <base>]"
 *   [ONE]     ← exactly one live code agent
 *               "Rose is waiting on <agent>[, then merges <branch> into <base>]"
 *   [MANY]    ← n > 1 live code agents: "Rose is waiting on <n> code agents"
 * Answering/dismissing the question or the agents finishing moves it along.
 */

import { useRootWaitStatus, type RootWaitStatus } from '../hooks/codeAgentSteering';

const BRANCH = 'font-mono text-[12.5px] text-[#e8507f]';

function StatusText({ status }: { status: RootWaitStatus }) {
  if (status.kind === 'many') return <>Rose is waiting on {status.count} code agents</>;
  if (status.kind === 'answer') {
    return (
      <>
        {status.agent} is waiting on your answer
        {status.base && (
          <>
            , then merges its branch into <code className={BRANCH}>{status.base}</code>
          </>
        )}
      </>
    );
  }
  return (
    <>
      Rose is waiting on {status.agent}
      {status.branch && status.base && (
        <>
          , then merges <code className={BRANCH}>{status.branch}</code> into{' '}
          <code className={BRANCH}>{status.base}</code>
        </>
      )}
    </>
  );
}

export function CodeAgentWaitStatus() {
  const status = useRootWaitStatus();
  if (!status) return null;
  return (
    <div
      data-testid="code-agent-wait-status"
      data-wait-kind={status.kind}
      role="status"
      className="flex items-center gap-2 text-[13px] text-muted-foreground dark:text-[#a3a39d]"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 flex-none animate-pulse rounded-full bg-[#e8507f]"
      />
      <span className="min-w-0">
        <StatusText status={status} />
      </span>
    </div>
  );
}
