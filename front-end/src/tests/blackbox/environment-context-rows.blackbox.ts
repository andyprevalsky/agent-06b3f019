/**
 * Agent environment rows ({environmentContext: true}) are model-only run-time
 * state: the trajectory filter must never render them as user bubbles.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isEnvironmentContextRow } from '@/features/terminal-component-group/components/environmentContext';
import { useFilteredMessages } from '@/features/terminal-component-group/components/useMessageFiltering';
import type { Message } from '@/lib/api';

function userRow(id: string, text: string, metadata?: Message['metadata']): Message {
  return {
    message_id: id,
    timestamp: `2026-10-19T04:1${id.length}:00.000Z`,
    text,
    role: 'USER',
    ...(metadata ? { metadata } : {}),
  };
}

const ENVIRONMENT_TEXT =
  '<environment>\nCurrent date: 2026-10-19 (UTC)\nYou are /root, the root agent.\nRunning agents you started: none\n</environment>';

describe('environment context rows', () => {
  it('detects the row by its metadata flag only', () => {
    expect(
      isEnvironmentContextRow(userRow('e', ENVIRONMENT_TEXT, { environmentContext: true })),
    ).toBe(true);
    expect(isEnvironmentContextRow(userRow('u', ENVIRONMENT_TEXT))).toBe(false);
  });

  it('drops environment rows from the trajectory with or without hidden; real user rows stay', () => {
    const messages = [
      userRow('u1', 'Plan a team offsite in Napa'),
      userRow('e1', ENVIRONMENT_TEXT, { environmentContext: true, hidden: true }),
      userRow('e22', ENVIRONMENT_TEXT, { environmentContext: true }),
      userRow('u333', 'Also invite the design team'),
    ];
    const { result } = renderHook(() => useFilteredMessages(messages, undefined));
    expect(result.current.filteredMessagesRaw.map((m) => m.message_id)).toEqual(['u1', 'u333']);
  });
});
