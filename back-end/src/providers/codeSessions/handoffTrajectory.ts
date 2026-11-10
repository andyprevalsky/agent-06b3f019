import type { CodeSessionRow } from './store';
import type { CodeSessionFs } from './sandboxFs';
const HANDOFF_DIR = '/home/user/.rose/handoff';

/** The previous provider's CLI session log, exported into the next provider's sandbox. */
export interface HandoffTrajectory {
  /** Path inside an E2B sandbox (HOME /home/user). */
  path: string;
  content: Buffer;
}

/** The session a spawn runs in; after a provider switch it carries the previous CLI's log. */
export type SpawnCodeSession = CodeSessionRow & {
  handoffTrajectory?: HandoffTrajectory | null;
  retainFailedStartLease?: boolean;
};

export function handoffTrajectoryPath(codeSessionId: string, previousProvider: string): string {
  return `${HANDOFF_DIR}/${codeSessionId}-${previousProvider === 'codex' ? 'codex' : 'claude'}.jsonl`;
}

/**
 * Write the previous provider's trajectory into the sandbox that continues the
 * session. A local HOME maps /home/user onto its own HOME; returns the path
 * the file is at (the one the handoff prompt names for an E2B sandbox).
 */
export async function writeHandoffTrajectory(
  fs: CodeSessionFs,
  trajectory: HandoffTrajectory
): Promise<string> {
  const path = trajectory.path.split('/home/user').join(fs.home);
  await fs.writeFile(path, trajectory.content);
  return path;
}
