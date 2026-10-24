/**
 * The code agent's result handoff file (R3b): one JSON object whose structure the
 * parent's output schema fixes. E2B sandboxes and the local Claude Code
 * fallback both read and consume it at close.
 */
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { CODE_AGENT_HANDOFF_PATH } from './codeAgentPrompt';
import { createLogger } from './logger';

const log = createLogger('CodeAgentHandoff');

/** The code agent's handoff file at close (absent for sessions with no sandbox filesystem). */
export type CodeAgentHandoff =
  | { status: 'present'; content: string }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string };

export interface HandoffFiles {
  exists(path: string): Promise<boolean>;
  read(path: string, opts: { format: 'text' }): Promise<string>;
  remove(path: string): Promise<void>;
}

/**
 * Read and consume the handoff file. A persistent sandbox outlives this spawn,
 * so the file is removed once read: the next spawn must write its own result.
 */
export async function readCodeAgentHandoff(
  files: HandoffFiles,
  path: string = CODE_AGENT_HANDOFF_PATH
): Promise<CodeAgentHandoff> {
  let content: string;
  try {
    if (!(await files.exists(path))) return { status: 'missing' };
    content = await files.read(path, { format: 'text' });
  } catch (err) {
    return { status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await files.remove(path);
  } catch (err) {
    log.error('Failed to consume code-agent handoff file', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { status: 'present', content };
}

/** The local fallback's handoff file: the same `.rose/handoff.json`, under its own HOME. */
export function localHandoffPath(home: string): string {
  return join(home, '.rose', 'handoff.json');
}

/** /home/user does not exist on the backend host; point the contract at the CLI's HOME. */
export function pointHandoffAtHome(text: string, home: string): string {
  return text.split(CODE_AGENT_HANDOFF_PATH).join(localHandoffPath(home));
}

export function isCodeAgentHandoff(value: unknown): value is CodeAgentHandoff {
  if (typeof value !== 'object' || value === null) return false;
  const handoff = value as { status?: unknown; content?: unknown; error?: unknown };
  return (
    (handoff.status === 'present' && typeof handoff.content === 'string') ||
    handoff.status === 'missing' ||
    (handoff.status === 'unreadable' && typeof handoff.error === 'string')
  );
}

/** Read and consume the local fallback's handoff file under its session HOME. */
export function readLocalCodeAgentHandoff(home: string): Promise<CodeAgentHandoff> {
  return readCodeAgentHandoff(
    {
      exists: async (path) => existsSync(path),
      read: async (path) => readFileSync(path, 'utf8'),
      remove: async (path) => rmSync(path, { force: true }),
    },
    localHandoffPath(home)
  );
}

/** The local fallback's goal and prompt, with the handoff path under its HOME. */
export function pointLaunchAtHome(
  goal: string,
  envs: Record<string, string>,
  home: string
): { goal: string; envs: Record<string, string> } {
  const prompt = envs.CODE_AGENT_SYSTEM_PROMPT;
  return {
    goal: pointHandoffAtHome(goal, home),
    envs:
      prompt === undefined
        ? envs
        : { ...envs, CODE_AGENT_SYSTEM_PROMPT: pointHandoffAtHome(prompt, home) },
  };
}
