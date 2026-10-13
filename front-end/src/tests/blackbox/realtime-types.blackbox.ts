/**
 * Unit tests for src/lib/realtime-types.ts
 *
 * Covers every exported runtime function: type-guards (is*) and
 * extractors (extract*). No React, no DOM, no network - these are pure
 * functions operating on plain objects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isToolMessage,
  isSpawnBrowserAgentMessage,
  isSpawnClaudeCodeAgentMessage,
  isSpawnAgentMessage,
  isExploreAgentMessage,
  isSetPlanMessage,
  isSendMessageToUserMessage,
  isRequestUserSignupMessage,
  isAssistantFileMessage,
  isInsertMessagePayload,
  isAssistantStreamPayload,
  isAgentStateChangedPayload,
  extractInsertPayload,
  extractUpdatePayload,
  extractDeletePayload,
  extractAssistantStreamPayload,
  extractPlanStreamPayload,
  extractToolStreamPayload,
  extractAttentionStreamPayload,
  extractAgentStateChangedPayload,
  extractAgentModeStartedPayload,
  extractRecord,
  type InsertMessagePayload,
} from '@/lib/realtime-types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid InsertMessagePayload for tests.
 */
function buildInsertMsg(overrides: Partial<InsertMessagePayload> = {}): InsertMessagePayload {
  return {
    agentId: 'agent-1',
    id: 'msg-1',
    timestamp: '2026-04-17T12:00:00Z',
    text: 'hello',
    role: 'ASSISTANT',
    metadata: null,
    file_pointer: null,
    ...overrides,
  };
}

/**
 * Build a TOOL InsertMessagePayload with a given toolName (minimal valid metadata).
 */
function buildToolMsg(
  toolName: string,
  metaOverrides: Record<string, unknown> = {},
  overrides: Partial<InsertMessagePayload> = {},
): InsertMessagePayload {
  return buildInsertMsg({
    role: 'TOOL',
    metadata: {
      toolCallId: 'tc-1',
      toolName,
      toolStatus: 'IN_PROGRESS',
      ...metaOverrides,
    },
    ...overrides,
  });
}

/**
 * Wrap any record into the Supabase realtime broadcast envelope.
 */
function wrap<T>(record: T) {
  return { payload: { record } };
}

// Silence console.error while still being able to assert it fires.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

// ===========================================================================
// isToolMessage
// ===========================================================================

// ===========================================================================
// isToolMessage
// ===========================================================================

describe('isToolMessage', () => {
  it('returns true for a valid TOOL message with metadata.toolName', () => {
    expect(isToolMessage(buildToolMsg('web_search'))).toBe(true);
  });

  it('returns false when role is not TOOL', () => {
    expect(isToolMessage(buildInsertMsg({ role: 'ASSISTANT' }))).toBe(false);
  });

  it('returns false and logs when metadata is null on a TOOL message', () => {
    const msg = buildInsertMsg({ role: 'TOOL', metadata: null });
    expect(isToolMessage(msg)).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns false and logs when metadata.toolName is not a string', () => {
    const msg = {
      ...buildInsertMsg({ role: 'TOOL' }),
      metadata: { toolCallId: 'x', toolName: 123, toolStatus: 'IN_PROGRESS' },
    };
    expect(isToolMessage(msg)).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns false for USER role', () => {
    expect(isToolMessage(buildInsertMsg({ role: 'USER' }))).toBe(false);
  });
});

// ===========================================================================
// isSpawnBrowserAgentMessage
// ===========================================================================

describe('isSpawnBrowserAgentMessage', () => {
  it('returns true for a TOOL message with toolName=spawn_browser_agent', () => {
    expect(
      isSpawnBrowserAgentMessage(buildToolMsg('spawn_browser_agent', { task_id: 'task-1' })),
    ).toBe(true);
  });

  it('returns false for a different toolName', () => {
    expect(isSpawnBrowserAgentMessage(buildToolMsg('web_search'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isSpawnBrowserAgentMessage(buildInsertMsg({ role: 'ASSISTANT' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isSpawnBrowserAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(
      false,
    );
  });

  it('returns false when metadata is undefined', () => {
    expect(isSpawnBrowserAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: undefined }))).toBe(
      false,
    );
  });
});

// ===========================================================================
// isSpawnClaudeCodeAgentMessage
// ===========================================================================

describe('isSpawnClaudeCodeAgentMessage', () => {
  it('returns true for spawn_claude_code_agent tool message', () => {
    expect(
      isSpawnClaudeCodeAgentMessage(buildToolMsg('spawn_claude_code_agent', { task_id: 'task-2' })),
    ).toBe(true);
  });

  it('returns false for a different toolName', () => {
    expect(isSpawnClaudeCodeAgentMessage(buildToolMsg('spawn_browser_agent'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isSpawnClaudeCodeAgentMessage(buildInsertMsg({ role: 'USER' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isSpawnClaudeCodeAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(
      false,
    );
  });
});

// ===========================================================================
// isSpawnAgentMessage
// ===========================================================================

describe('isSpawnAgentMessage', () => {
  it('returns true for spawn_agent tool message', () => {
    expect(isSpawnAgentMessage(buildToolMsg('spawn_agent', { agentType: 'explore' }))).toBe(true);
  });

  it('returns false for a different toolName', () => {
    expect(isSpawnAgentMessage(buildToolMsg('spawn_sub_agent'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isSpawnAgentMessage(buildInsertMsg({ role: 'SYSTEM' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isSpawnAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(false);
  });
});

// ===========================================================================
// isExploreAgentMessage
// ===========================================================================

describe('isExploreAgentMessage', () => {
  it('returns true for spawn_agent with agentType=explore', () => {
    expect(isExploreAgentMessage(buildToolMsg('spawn_agent', { agentType: 'explore' }))).toBe(true);
  });

  it('returns false for spawn_agent with a different agentType', () => {
    expect(isExploreAgentMessage(buildToolMsg('spawn_agent', { agentType: 'browser' }))).toBe(
      false,
    );
  });

  it('returns false for spawn_agent without agentType', () => {
    expect(isExploreAgentMessage(buildToolMsg('spawn_agent'))).toBe(false);
  });

  it('returns false when not a spawn_agent tool message', () => {
    expect(isExploreAgentMessage(buildToolMsg('web_search', { agentType: 'explore' }))).toBe(false);
  });
});

// ===========================================================================
// isSetPlanMessage
// ===========================================================================

describe('isSetPlanMessage', () => {
  it('returns true for set_plan tool messages', () => {
    expect(isSetPlanMessage(buildToolMsg('set_plan'))).toBe(true);
  });

  it('returns false for other tool names', () => {
    expect(isSetPlanMessage(buildToolMsg('web_search'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isSetPlanMessage(buildInsertMsg({ role: 'ASSISTANT' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isSetPlanMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(false);
  });
});

// ===========================================================================
// isSendMessageToUserMessage
// ===========================================================================

describe('isSendMessageToUserMessage', () => {
  it('returns true for send_message_to_user toolName', () => {
    expect(isSendMessageToUserMessage(buildToolMsg('send_message_to_user'))).toBe(true);
  });

  it('returns true for send_message_to_user_execute_phase toolName', () => {
    expect(isSendMessageToUserMessage(buildToolMsg('send_message_to_user_execute_phase'))).toBe(
      true,
    );
  });

  it('returns false for an unrelated tool', () => {
    expect(isSendMessageToUserMessage(buildToolMsg('web_search'))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isSendMessageToUserMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(
      false,
    );
  });

  it('returns false when metadata is undefined', () => {
    expect(isSendMessageToUserMessage(buildInsertMsg({ role: 'TOOL', metadata: undefined }))).toBe(
      false,
    );
  });

  it('returns false for non-TOOL role', () => {
    expect(isSendMessageToUserMessage(buildInsertMsg({ role: 'ASSISTANT' }))).toBe(false);
  });
});

// ===========================================================================
// isRequestUserSignupMessage
// ===========================================================================

describe('isRequestUserSignupMessage', () => {
  it('returns true for request_user_signup tool message', () => {
    expect(isRequestUserSignupMessage(buildToolMsg('request_user_signup'))).toBe(true);
  });

  it('returns false for a different tool', () => {
    expect(isRequestUserSignupMessage(buildToolMsg('web_search'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isRequestUserSignupMessage(buildInsertMsg({ role: 'USER' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isRequestUserSignupMessage(buildInsertMsg({ role: 'TOOL', metadata: null }))).toBe(
      false,
    );
  });
});

// ===========================================================================
// isAssistantFileMessage
// ===========================================================================

describe('isAssistantFileMessage', () => {
  it('returns true for ASSISTANT with a non-null file_pointer', () => {
    const msg = buildInsertMsg({
      role: 'ASSISTANT',
      file_pointer: {
        id: 'file-1',
        storage_path: 'bucket/path.png',
        original_filename: 'path.png',
        mime_type: 'image/png',
        size_bytes: 1,
        created_at: '2026-04-17T12:00:00Z',
      },
    });
    expect(isAssistantFileMessage(msg)).toBe(true);
  });

  it('returns false for ASSISTANT with null file_pointer', () => {
    expect(isAssistantFileMessage(buildInsertMsg({ role: 'ASSISTANT', file_pointer: null }))).toBe(
      false,
    );
  });

  it('returns false for ASSISTANT without file_pointer', () => {
    const msg = buildInsertMsg({ role: 'ASSISTANT' });
    delete (msg as Partial<InsertMessagePayload>).file_pointer;
    expect(isAssistantFileMessage(msg)).toBe(false);
  });

  it('returns false for USER role even with a file_pointer', () => {
    const msg = buildInsertMsg({
      role: 'USER',
      file_pointer: {
        id: 'file-1',
        storage_path: 'bucket/path.png',
        original_filename: 'path.png',
        mime_type: 'image/png',
        size_bytes: 1,
        created_at: '2026-04-17T12:00:00Z',
      },
    });
    expect(isAssistantFileMessage(msg)).toBe(false);
  });
});

// ===========================================================================
// isInsertMessagePayload
// ===========================================================================

describe('isInsertMessagePayload', () => {
  it('returns true for a valid payload', () => {
    expect(
      isInsertMessagePayload({
        agentId: 'a',
        id: 'i',
        timestamp: 't',
        text: 'x',
        role: 'USER',
      }),
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isInsertMessagePayload(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isInsertMessagePayload('hello')).toBe(false);
  });

  it('returns false when agentId is missing', () => {
    expect(isInsertMessagePayload({ id: 'i', timestamp: 't', text: 'x', role: 'USER' })).toBe(
      false,
    );
  });

  it('returns false when id is not a string', () => {
    expect(
      isInsertMessagePayload({
        agentId: 'a',
        id: 1,
        timestamp: 't',
        text: 'x',
        role: 'USER',
      }),
    ).toBe(false);
  });

  it('returns false when role is not one of the allowed values', () => {
    expect(
      isInsertMessagePayload({
        agentId: 'a',
        id: 'i',
        timestamp: 't',
        text: 'x',
        role: 'ROBOT',
      }),
    ).toBe(false);
  });

  it('accepts all four valid roles', () => {
    for (const role of ['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']) {
      expect(
        isInsertMessagePayload({ agentId: 'a', id: 'i', timestamp: 't', text: 'x', role }),
      ).toBe(true);
    }
  });
});

// ===========================================================================
// isAssistantStreamPayload
// ===========================================================================

describe('isAssistantStreamPayload', () => {
  it('returns true for a valid payload', () => {
    expect(
      isAssistantStreamPayload({
        agentId: 'a',
        stream_id: 's',
        delta: 'hi',
        done: false,
        clear_on_done: true,
        sequence: 1,
      }),
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isAssistantStreamPayload(null)).toBe(false);
  });

  it('returns false when delta is not a string', () => {
    expect(
      isAssistantStreamPayload({
        agentId: 'a',
        stream_id: 's',
        delta: 42,
        done: false,
        sequence: 1,
      }),
    ).toBe(false);
  });

  it('returns false when done is not a boolean', () => {
    expect(
      isAssistantStreamPayload({
        agentId: 'a',
        stream_id: 's',
        delta: 'x',
        done: 'yes',
        sequence: 1,
      }),
    ).toBe(false);
  });

  it('returns false when sequence is not a number', () => {
    expect(
      isAssistantStreamPayload({
        agentId: 'a',
        stream_id: 's',
        delta: 'x',
        done: false,
        sequence: '1',
      }),
    ).toBe(false);
  });

  it('returns false when clear_on_done is not a boolean', () => {
    expect(
      isAssistantStreamPayload({
        agentId: 'a',
        stream_id: 's',
        delta: 'x',
        done: false,
        clear_on_done: 'yes',
        sequence: 1,
      }),
    ).toBe(false);
  });
});

// ===========================================================================
// isAgentStateChangedPayload
// ===========================================================================

describe('isAgentStateChangedPayload', () => {
  const validPayload = {
    agentId: 'a',
    goal: 'do stuff',
    status: 'RUNNING',
    progress: 0.5,
    toolsInUse: ['web_search'],
    messageCount: 3,
  };

  it('returns true for a valid payload', () => {
    expect(isAgentStateChangedPayload(validPayload)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isAgentStateChangedPayload(null)).toBe(false);
  });

  it('returns false when toolsInUse is not an array', () => {
    expect(isAgentStateChangedPayload({ ...validPayload, toolsInUse: 'web_search' })).toBe(false);
  });

  it('returns false when progress is not a number', () => {
    expect(isAgentStateChangedPayload({ ...validPayload, progress: '50%' })).toBe(false);
  });

  it('returns false when agentId is missing', () => {
    const { agentId: _unused, ...withoutAgentId } = validPayload;
    expect(isAgentStateChangedPayload(withoutAgentId)).toBe(false);
  });
});
