/**
 * Grep path grammar — ONE definition, used to both emit and parse.
 *
 * grep advertises grep semantics, so the addresses it prints must be addresses
 * callers can feed back as `filters.path`. Before this module the two halves
 * lived apart: `format.ts` synthesized display paths, while the only `path`
 * filter (documents) substring-matched unrelated raw columns. Nothing grep
 * emitted could be fed back to it — see
 * docs/rca/cases/2026-08-04-grep-emits-pointers-no-tool-can-dereference.md
 *
 * Keep `build*Path` and `parseGrepPath` inverses. `grep-path-roundtrip.test.ts`
 * enforces it; a new source must land in both directions or that test fails.
 *
 * Paths are hierarchical, so a prefix addresses a subtree:
 *   `messages/+19729777432.thread`      -> the whole thread
 *   `messages/+19729777432.thread/<id>` -> one message
 */

import { pathSegment, stripTrailingSlashes } from './format.snippets';

export const THREAD_SUFFIX = '.thread';
export const CONTACT_SUFFIX = '.contact';
export const ACCOUNT_MASK_PREFIX = ' ****';
export const UNKNOWN_INSTITUTION = 'unknown-institution';

export type ParsedGrepPath =
  | { source: 'messages'; thread: string; messageId?: string }
  | { source: 'network'; contact: string }
  | { source: 'agent_network'; depth?: number; agentId?: string; role?: string; messageId?: string }
  | {
      source: 'agent_trajectories';
      rootAgentId?: string;
      agentId?: string;
      role?: string;
      messageId?: string;
    }
  | { source: 'transactions'; institution?: string; account?: string; transactionId?: string }
  | { source: 'documents'; documentSource?: string; rest?: string }
  | { source: 'calendar' | 'drive'; rest?: string };

// ── Agent task paths ──

/**
 * An agent address in the caller's own tree (`/root`, `/root/outreach/draft_a`),
 * as list_agents prints it. Same grammar as the agents domain's task paths;
 * as a grep `trace_path` it scopes agent_network / agent_trajectories to that
 * agent and every agent below it.
 */
const AGENT_TASK_PATH_PATTERN = /^\/root(\/[a-z][a-z0-9_]{0,59})*$/;
export const ROOT_AGENT_TASK_PATH = '/root';

export function isAgentTaskPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 400 && AGENT_TASK_PATH_PATTERN.test(value);
}

/** A `trace_path` value naming an agent task path (trailing slashes tolerated), else undefined. */
export function agentTaskPathParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = stripTrailingSlashes(value.trim());
  return isAgentTaskPath(trimmed) ? trimmed : undefined;
}

// ── Build ──

export function buildMessagePath(threadName: string, messageId?: string): string {
  const thread = `${pathSegment(threadName)}${THREAD_SUFFIX}`;
  return messageId === undefined ? `messages/${thread}` : `messages/${thread}/${messageId}`;
}

export function buildNetworkPath(contactName: string): string {
  return `network/${pathSegment(contactName)}${CONTACT_SUFFIX}`;
}

export function buildAgentNetworkPath(
  depth: number,
  agentId: string,
  role: string,
  messageId: string
): string {
  return `agent_network/depth-${depth}/${agentId}/${role}/${messageId}`;
}

export function buildAgentTrajectoryPath(
  rootAgentId: string,
  agentId: string,
  role: string,
  messageId: string
): string {
  const agentPart = agentId === rootAgentId ? '' : `/${agentId}`;
  return `agent_trajectories/${rootAgentId}${agentPart}/${role}/${messageId}`;
}

/** Account label as printed in results: `<name>` or `<name> ****<mask>`. */
export function buildAccountLabel(accountName: string, accountMask: string | null): string {
  return accountMask !== null && accountMask !== ''
    ? `${accountName}${ACCOUNT_MASK_PREFIX}${accountMask}`
    : accountName;
}

export function buildTransactionPath(
  institutionName: string | null,
  accountName: string,
  accountMask: string | null,
  transactionId: string
): string {
  const institution = pathSegment(institutionName ?? UNKNOWN_INSTITUTION);
  const account = pathSegment(buildAccountLabel(accountName, accountMask));
  return `transactions/${institution}/${account}/${transactionId}`;
}

export function buildDocumentPath(documentSource: string, ...rest: string[]): string {
  return ['documents', pathSegment(documentSource), ...rest.map(pathSegment)].join('/');
}

/**
 * `calendar/<account>/<date>/<event>` and `drive/<account>/<folders>/<file>`.
 * `storedPath` is the row's `metadata.path`, already built from safe segments.
 */
export function buildGoogleSourcePath(source: 'calendar' | 'drive', storedPath: string): string {
  return `${source}/${storedPath}`;
}

/** Split an account label back into the name and mask that produced it. */
export function parseAccountLabel(label: string): { accountName: string; accountMask?: string } {
  const at = label.lastIndexOf(ACCOUNT_MASK_PREFIX);
  if (at === -1) return { accountName: label };
  return {
    accountName: label.slice(0, at),
    accountMask: label.slice(at + ACCOUNT_MASK_PREFIX.length),
  };
}

// ── Parse ──

/**
 * Parse an emitted path back into its components. Returns null when the string
 * is not a grep path, so callers can reject rather than silently match nothing.
 * Trailing slashes are tolerated so a subtree prefix parses like its directory.
 */
export function parseGrepPath(value: string): ParsedGrepPath | null {
  const trimmed = stripTrailingSlashes(value.trim());
  if (!trimmed) return null;

  const [head, ...rest] = trimmed.split('/');

  switch (head) {
    case 'messages': {
      const [thread, messageId] = rest;
      if (!thread || !thread.endsWith(THREAD_SUFFIX)) return null;
      return {
        source: 'messages',
        thread: thread.slice(0, -THREAD_SUFFIX.length),
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'network': {
      const [contact] = rest;
      if (!contact || !contact.endsWith(CONTACT_SUFFIX)) return null;
      return { source: 'network', contact: contact.slice(0, -CONTACT_SUFFIX.length) };
    }
    case 'agent_network': {
      const [depthSegment, agentId, role, messageId] = rest;
      const depth =
        depthSegment && depthSegment.startsWith('depth-')
          ? Number(depthSegment.slice('depth-'.length))
          : undefined;
      if (depthSegment !== undefined && (depth === undefined || Number.isNaN(depth))) return null;
      return {
        source: 'agent_network',
        ...(depth === undefined ? {} : { depth }),
        ...(agentId ? { agentId } : {}),
        ...(role ? { role } : {}),
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'agent_trajectories': {
      if (rest.length > 4) return null;
      const [rootAgentId, second, third, fourth] = rest;
      const rootMessage = ['SYSTEM', 'USER', 'ASSISTANT', 'TOOL'].includes(second ?? '');
      const agentId = rootMessage ? rootAgentId : second;
      const role = rootMessage ? second : third;
      const messageId = rootMessage ? third : fourth;
      return {
        source: 'agent_trajectories',
        ...(rootAgentId ? { rootAgentId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(role ? { role } : {}),
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'transactions': {
      const [institution, account, transactionId] = rest;
      return {
        source: 'transactions',
        ...(institution ? { institution } : {}),
        ...(account ? { account } : {}),
        ...(transactionId ? { transactionId } : {}),
      };
    }
    case 'documents': {
      const [documentSource, ...tail] = rest;
      return {
        source: 'documents',
        ...(documentSource ? { documentSource } : {}),
        ...(tail.length > 0 ? { rest: tail.join('/') } : {}),
      };
    }
    case 'calendar':
    case 'drive':
      return { source: head, ...(rest.length > 0 ? { rest: rest.join('/') } : {}) };
    default:
      return null;
  }
}
