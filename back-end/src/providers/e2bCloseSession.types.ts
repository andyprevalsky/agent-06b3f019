import type { FilePointer } from './storage';
import type { CodeAgentHandoff } from './codeAgentHandoff';
import type { RepoFacts } from './codeSessions/lifecycle';
import type { CodeSessionMergeFacts } from './codeSessions/mergeFacts';

export interface ClaudeCodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CodeSessionCloseFacts {
  code_session_id: string;
  state: string;
  checkpoint_seq: number | null;
  cli_session_id: string | null;
  /** Branch this session works on and where it merges (plan §1b). */
  branch: string | null;
  merge_target: string | null;
  repo: RepoFacts | null;
  /** merged=true only when GitHub confirms the PR merged and the target contains head. */
  merge: CodeSessionMergeFacts;
}

export interface CloseResult {
  outputFiles: FilePointer[];
  usage?: ClaudeCodeUsage;
  codeSession?: CodeSessionCloseFacts;
  handoff?: CodeAgentHandoff;
}

export interface CloseReceipt {
  version: 1;
  complete: boolean;
  extracted: boolean;
  result: CloseResult;
  uploads: Record<string, string>;
  phase?: 'collecting' | 'pause_requested' | 'paused';
  localStopped?: boolean;
  sandboxMissing?: boolean;
  failure?: string;
}
