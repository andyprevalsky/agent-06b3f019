/**
 * Pure helpers for SubAgentTree and its sub-components.
 *
 * Extracted from SubAgentTree.tsx to keep that file under the strict
 * `max-lines: 300` budget. No React imports — only value/shape utilities.
 */

import { type TreeNode, type FilePointer, type OutputSchemaField } from '../hooks';

// ── Tree drawing characters ────────────────────────────────────────────────
export const TREE_BRANCH = '├─'; // non-last sibling
export const TREE_LAST = '└─'; // last sibling
export const TREE_VERT = '│'; // vertical continuation

/** Format a field type from the backend schema for user display. */
export function formatFieldType(type: OutputSchemaField['type']): string {
  switch (type) {
    case 'str':
      return 'string';
    case 'int':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'list[str]':
      return 'string[]';
    case 'list[int]':
      return 'integer[]';
    case 'file_pointer':
      return 'file';
    case 'list[file_pointer]':
      return 'file[]';
    default:
      return type;
  }
}

/** Duck-type check: does this value look like a FilePointer? */
export function isFilePointer(value: unknown): value is FilePointer {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.storage_path === 'string' &&
    typeof obj.original_filename === 'string'
  );
}

/** Format a structured-output value for display, handling FilePointers specially. */
export function formatValue(value: unknown, fieldType?: OutputSchemaField['type']): string {
  if (isFilePointer(value)) {
    return `📄 ${value.original_filename}`;
  }

  if (fieldType === 'list[file_pointer]' && Array.isArray(value)) {
    const filePointers = value.filter(isFilePointer);
    if (filePointers.length > 0) {
      return filePointers.map((fp) => `📄 ${fp.original_filename}`).join(', ');
    }
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Summarize the forest in display preorder without recursive or argument-stack limits. */
export function summarizeTree(
  roots: TreeNode[],
  getChildren: (parentId: string) => TreeNode[],
): { leafNodes: TreeNode[]; intermediaryNodes: TreeNode[]; maxDepth: number } {
  const leafNodes: TreeNode[] = [];
  const intermediaryNodes: TreeNode[] = [];
  const pending = roots.map((node) => ({ node, depth: 1 })).reverse();
  let maxDepth = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    maxDepth = Math.max(maxDepth, depth);
    const children = getChildren(node.agentId);
    if (children.length === 0) leafNodes.push(node);
    else intermediaryNodes.push(node);
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ node: children[index], depth: depth + 1 });
    }
  }
  return { leafNodes, intermediaryNodes, maxDepth };
}

// Extended_Pictographic covers the full pictographic-emoji block; we pair it
// with the ZWJ and VS16 codepoints that stitch sequences (family, flags, etc.)
// and use the `v` flag so ESLint's `no-misleading-character-class` is happy.
const EMOJI_REGEX = new RegExp(
  '^(\\p{Extended_Pictographic}(?:\\p{Extended_Pictographic}|\\u200D|\\uFE0F)*)\\s*',
  'v',
);

/** Extract leading emoji run from text, returning the emoji and remaining text. */
export function extractEmoji(text: string): { emoji: string; text: string } {
  const match = text.match(EMOJI_REGEX);
  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }
  return { emoji: '', text };
}

/** A node is terminal when its workflow has finished (successfully or not). */
export function isTerminalNode(node: TreeNode): boolean {
  return node.status === 'COMPLETED' || node.status === 'FAILED';
}

/**
 * Synthesize a pending placeholder node for a spawned sub-agent whose real node
 * data has not yet arrived via the REST snapshot or the realtime bus.
 *
 * The tree is driven by the known `subAgentIds` from the spawn message, so it
 * stays visible ("spinning up...") the instant a spawn happens instead of being
 * invisible-until-refresh when the two decoupled node streams haven't populated
 * yet. Real bus/REST data enriches (replaces) this node by `agentId`.
 */
export function makePendingNode(agentId: string): TreeNode {
  return {
    agentId,
    parentAgentId: null,
    goal: '',
    status: 'STARTING_UP',
    progress: 0,
    toolsInUse: [],
    messageCount: 0,
    costCents: 0,
  };
}
