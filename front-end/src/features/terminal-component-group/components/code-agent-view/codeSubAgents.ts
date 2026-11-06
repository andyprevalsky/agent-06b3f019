/**
 * A code agent's own sub-agents (Claude Code's Task / Agent tool) as the running
 * agents drawer's panel model, so the code-agent view's query box shows them in
 * the existing BackgroundAgentsBanner exactly like a Rose agent's children.
 *
 * Source: the session's persisted transcript (foldSessionTranscript): every
 * tool record named Task / Agent is one sub-agent; its description (the tool
 * target) is the row's goal.
 *   tool status running → ACTIVE while the session runs; once the session ended
 *                         it takes the session's state (paused → PAUSED,
 *                         failed → FAILED, else COMPLETED)
 *   ok → COMPLETED · error → FAILED
 * Rows are synthetic task nodes (no agent page to open, no trajectory).
 */

import type { Message } from '@/lib/api/types';
import type { TreeNode } from '../../hooks';
import { foldSessionTranscript, type TranscriptEntry } from '../../hooks/codeSessionTranscript';
import {
  countAll,
  taskTreeNode,
  type AgentPanelModel,
  type PanelGroup,
} from '../background-agents/agentsPanelGroups';

const SUB_AGENT_TOOLS = /^(Task|Agent)$/;
const NO_TRAJECTORIES: ReadonlyMap<string, string> = new Map();
const noChildren = (): TreeNode[] => [];

export type CodeSessionState = 'running' | 'completed' | 'failed' | 'paused';

function status(entry: TranscriptEntry, session: CodeSessionState): TreeNode['status'] {
  const tool = entry.tool?.status;
  if (tool === 'ok') return 'COMPLETED';
  if (tool === 'error') return 'FAILED';
  if (session === 'running') return 'ACTIVE';
  return session === 'paused' ? 'PAUSED' : session === 'failed' ? 'FAILED' : 'COMPLETED';
}

export function buildCodeSubAgentPanelModel(
  messages: Message[],
  taskId: string,
  session: CodeSessionState,
): AgentPanelModel {
  const roots = foldSessionTranscript(messages, taskId)
    .filter((entry) => entry.type === 'tool' && SUB_AGENT_TOOLS.test(entry.tool?.name ?? ''))
    .map((entry) =>
      taskTreeNode({
        address: entry.key,
        parentAgentId: taskId,
        type: 'agent',
        goal: entry.tool?.target || entry.text,
        path: null,
        status: status(entry, session),
        activity: null,
      }),
    );
  const groups: PanelGroup[] = roots.length > 0 ? [{ key: 'children', header: null, roots }] : [];
  return {
    groups,
    getChildren: noChildren,
    counts: countAll(groups, noChildren),
    trajectories: NO_TRAJECTORIES,
  };
}
