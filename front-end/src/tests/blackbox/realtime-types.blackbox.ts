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
  type ToolMessageMetadata,
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
    } as ToolMessageMetadata,
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
    const msg = buildInsertMsg({
      role: 'TOOL',
      // @ts-expect-error intentionally invalid
      metadata: { toolCallId: 'x', toolName: 123, toolStatus: 'IN_PROGRESS' },
    });
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
      isSpawnBrowserAgentMessage(
        buildToolMsg('spawn_browser_agent', { task_id: 'task-1' }),
      ),
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
    expect(
      isSpawnBrowserAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: undefined })),
    ).toBe(false);
  });
});

// ===========================================================================
// isSpawnClaudeCodeAgentMessage
// ===========================================================================

describe('isSpawnClaudeCodeAgentMessage', () => {
  it('returns true for spawn_claude_code_agent tool message', () => {
    expect(
      isSpawnClaudeCodeAgentMessage(
        buildToolMsg('spawn_claude_code_agent', { task_id: 'task-2' }),
      ),
    ).toBe(true);
  });

  it('returns false for a different toolName', () => {
    expect(isSpawnClaudeCodeAgentMessage(buildToolMsg('spawn_browser_agent'))).toBe(false);
  });

  it('returns false for non-TOOL role', () => {
    expect(isSpawnClaudeCodeAgentMessage(buildInsertMsg({ role: 'USER' }))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(
      isSpawnClaudeCodeAgentMessage(buildInsertMsg({ role: 'TOOL', metadata: null })),
    ).toBe(false);
  });
});

// ===========================================================================
// isSpawnAgentMessage
// ===========================================================================

describe('isSpawnAgentMessage', () => {
  it('returns true for spawn_agent tool message', () => {
    expect(isSpawnAgentMessage(buildToolMsg('spawn_agent', { agentType: 'explore' }))).toBe(
      true,
    );
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
    expect(
      isExploreAgentMessage(buildToolMsg('spawn_agent', { agentType: 'explore' })),
    ).toBe(true);
  });

  it('returns false for spawn_agent with a different agentType', () => {
    expect(
      isExploreAgentMessage(buildToolMsg('spawn_agent', { agentType: 'browser' })),
    ).toBe(false);
  });

  it('returns false for spawn_agent without agentType', () => {
    expect(isExploreAgentMessage(buildToolMsg('spawn_agent'))).toBe(false);
  });

  it('returns false when not a spawn_agent tool message', () => {
    expect(
      isExploreAgentMessage(buildToolMsg('web_search', { agentType: 'explore' })),
    ).toBe(false);
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
    expect(
      isSendMessageToUserMessage(buildToolMsg('send_message_to_user_execute_phase')),
    ).toBe(true);
  });

  it('returns false for an unrelated tool', () => {
    expect(isSendMessageToUserMessage(buildToolMsg('web_search'))).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(
      isSendMessageToUserMessage(buildInsertMsg({ role: 'TOOL', metadata: null })),
    ).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    expect(
      isSendMessageToUserMessage(buildInsertMsg({ role: 'TOOL', metadata: undefined })),
    ).toBe(false);
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
    expect(
      isRequestUserSignupMessage(buildInsertMsg({ role: 'TOOL', metadata: null })),
    ).toBe(false);
  });
});

// ===========================================================================
// isAssistantFileMessage
// ===========================================================================

describe('isAssistantFileMessage', () => {
  it('returns true for ASSISTANT with a non-null file_pointer', () => {
    const msg = buildInsertMsg({
      role: 'ASSISTANT',
      // @ts-expect-error - FilePointer is a shape we do not need to replicate in full here
      file_pointer: { storage_path: 'bucket/path.png', mime_type: 'image/png' },
    });
    expect(isAssistantFileMessage(msg)).toBe(true);
  });

  it('returns false for ASSISTANT with null file_pointer', () => {
    expect(
      isAssistantFileMessage(buildInsertMsg({ role: 'ASSISTANT', file_pointer: null })),
    ).toBe(false);
  });

  it('returns false for ASSISTANT without file_pointer', () => {
    const msg = buildInsertMsg({ role: 'ASSISTANT' });
    delete (msg as Partial<InsertMessagePayload>).file_pointer;
    expect(isAssistantFileMessage(msg)).toBe(false);
  });

  it('returns false for USER role even with a file_pointer', () => {
    const msg = buildInsertMsg({
      role: 'USER',
      // @ts-expect-error - minimal shape for test
      file_pointer: { storage_path: 'bucket/path.png', mime_type: 'image/png' },
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
    expect(
      isInsertMessagePayload({ id: 'i', timestamp: 't', text: 'x', role: 'USER' }),
    ).toBe(false);
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
    expect(isAgentStateChangedPayload({ ...validPayload, toolsInUse: 'web_search' })).toBe(
      false,
    );
  });

  it('returns false when progress is not a number', () => {
    expect(isAgentStateChangedPayload({ ...validPayload, progress: '50%' })).toBe(false);
  });

  it('returns false when agentId is missing', () => {
    const { agentId: _unused, ...withoutAgentId } = validPayload;
    expect(isAgentStateChangedPayload(withoutAgentId)).toBe(false);
  });
});

// ===========================================================================
// extractInsertPayload
// ===========================================================================

describe('extractInsertPayload', () => {
  it('returns the record for a valid wrapper', () => {
    const record = {
      agentId: 'a',
      id: 'i',
      timestamp: 't',
      text: 'x',
      role: 'USER',
    };
    expect(extractInsertPayload(wrap(record))).toMatchObject(record);
  });

  it('transforms filePointer (camelCase) to file_pointer on the record', () => {
    const filePointer = { storage_path: 'b/p.png', mime_type: 'image/png' };
    const record = {
      agentId: 'a',
      id: 'i',
      timestamp: 't',
      text: 'x',
      role: 'ASSISTANT',
      filePointer,
    };
    const out = extractInsertPayload(wrap(record));
    expect(out).not.toBeNull();
    expect(out!.file_pointer).toEqual(filePointer);
  });

  it('returns null and logs when wrapper is not an object', () => {
    expect(extractInsertPayload('garbage')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when wrapper lacks a payload key', () => {
    expect(extractInsertPayload({})).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when payload lacks a record key', () => {
    expect(extractInsertPayload({ payload: {} })).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record fails validation (bad role)', () => {
    expect(
      extractInsertPayload(
        wrap({ agentId: 'a', id: 'i', timestamp: 't', text: 'x', role: 'BAD' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when TOOL message is missing metadata', () => {
    expect(
      extractInsertPayload(
        wrap({ agentId: 'a', id: 'i', timestamp: 't', text: 'x', role: 'TOOL' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when TOOL metadata missing toolCallId', () => {
    expect(
      extractInsertPayload(
        wrap({
          agentId: 'a',
          id: 'i',
          timestamp: 't',
          text: 'x',
          role: 'TOOL',
          metadata: { toolName: 'web_search', toolStatus: 'IN_PROGRESS' },
        }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when TOOL metadata has invalid toolStatus', () => {
    expect(
      extractInsertPayload(
        wrap({
          agentId: 'a',
          id: 'i',
          timestamp: 't',
          text: 'x',
          role: 'TOOL',
          metadata: {
            toolCallId: 'tc',
            toolName: 'web_search',
            toolStatus: 'WUT',
          },
        }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns a valid TOOL payload', () => {
    const record = {
      agentId: 'a',
      id: 'i',
      timestamp: 't',
      text: 'x',
      role: 'TOOL',
      metadata: { toolCallId: 'tc', toolName: 'web_search', toolStatus: 'FINISHED' },
    };
    expect(extractInsertPayload(wrap(record))).toMatchObject(record);
  });

  it('returns null when wrapper is null', () => {
    expect(extractInsertPayload(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is a primitive', () => {
    expect(extractInsertPayload(wrap(42))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractUpdatePayload
// ===========================================================================

describe('extractUpdatePayload', () => {
  it('returns a valid UPDATE payload', () => {
    const record = { progress: 0.5, status: 'RUNNING', tokenCount: 1000 };
    expect(extractUpdatePayload(wrap(record))).toMatchObject(record);
  });

  it('returns a valid empty UPDATE (all fields optional)', () => {
    expect(extractUpdatePayload(wrap({}))).toEqual({});
  });

  it('returns null when progress has wrong type', () => {
    expect(extractUpdatePayload(wrap({ progress: 'fifty' }))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when status has wrong type', () => {
    expect(extractUpdatePayload(wrap({ status: 123 }))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when tokenCount has wrong type', () => {
    expect(extractUpdatePayload(wrap({ tokenCount: '100' }))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractUpdatePayload(undefined)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is not an object', () => {
    expect(extractUpdatePayload(wrap('string-record'))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractDeletePayload
// ===========================================================================

describe('extractDeletePayload', () => {
  it('returns the record for a valid DELETE', () => {
    expect(extractDeletePayload(wrap({ id: 'msg-1' }))).toEqual({ id: 'msg-1' });
  });

  it('returns null when id is missing', () => {
    expect(extractDeletePayload(wrap({}))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when id is not a string', () => {
    expect(extractDeletePayload(wrap({ id: 42 }))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractDeletePayload(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is not an object', () => {
    expect(extractDeletePayload(wrap(null))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractAssistantStreamPayload
// ===========================================================================

describe('extractAssistantStreamPayload', () => {
  it('returns the record for a valid ASSISTANT_STREAM payload', () => {
    const record = { agentId: 'a', stream_id: 's', delta: 'hi', done: false, sequence: 1 };
    expect(extractAssistantStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when fields are missing', () => {
    expect(
      extractAssistantStreamPayload(wrap({ agentId: 'a', stream_id: 's' })),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when sequence has wrong type', () => {
    expect(
      extractAssistantStreamPayload(
        wrap({ agentId: 'a', stream_id: 's', delta: 'x', done: false, sequence: 'no' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when done is not a boolean', () => {
    expect(
      extractAssistantStreamPayload(
        wrap({ agentId: 'a', stream_id: 's', delta: 'x', done: 1, sequence: 1 }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractAssistantStreamPayload(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractPlanStreamPayload
// ===========================================================================

describe('extractPlanStreamPayload', () => {
  it('returns the record for a valid PLAN_STREAM payload', () => {
    const record = {
      agentId: 'a',
      stream_id: 's',
      tool_call_id: 'tc',
      title: 'Creating Plan',
    };
    expect(extractPlanStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when title is missing', () => {
    expect(
      extractPlanStreamPayload(
        wrap({ agentId: 'a', stream_id: 's', tool_call_id: 'tc' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when tool_call_id is missing', () => {
    expect(
      extractPlanStreamPayload(
        wrap({ agentId: 'a', stream_id: 's', title: 'x' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is not an object', () => {
    expect(extractPlanStreamPayload(wrap(null))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractPlanStreamPayload('bad')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractToolStreamPayload
// ===========================================================================

describe('extractToolStreamPayload', () => {
  it('returns the record for a valid TOOL_STREAM payload', () => {
    const record = {
      agentId: 'a',
      stream_id: 's',
      tool_call_id: 'tc',
      tool_name: 'web_search',
      title: 'Starting web_search...',
    };
    expect(extractToolStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when tool_name is missing', () => {
    expect(
      extractToolStreamPayload(
        wrap({ agentId: 'a', stream_id: 's', tool_call_id: 'tc', title: 'x' }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is not an object', () => {
    expect(extractToolStreamPayload(wrap(123))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractToolStreamPayload(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractAttentionStreamPayload
// ===========================================================================

describe('extractAttentionStreamPayload', () => {
  it('returns the record for a valid ATTENTION_STREAM payload', () => {
    const record = {
      agentId: 'a',
      stream_id: 's',
      tool_call_id: 'tc',
      message: 'hello',
      is_question: true,
      done: false,
      sequence: 1,
    };
    expect(extractAttentionStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when is_question is missing', () => {
    expect(
      extractAttentionStreamPayload(
        wrap({
          agentId: 'a',
          stream_id: 's',
          tool_call_id: 'tc',
          message: 'hi',
          done: false,
          sequence: 1,
        }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when sequence is missing', () => {
    expect(
      extractAttentionStreamPayload(
        wrap({
          agentId: 'a',
          stream_id: 's',
          tool_call_id: 'tc',
          message: 'hi',
          is_question: false,
          done: false,
        }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when done has wrong type', () => {
    expect(
      extractAttentionStreamPayload(
        wrap({
          agentId: 'a',
          stream_id: 's',
          tool_call_id: 'tc',
          message: 'hi',
          is_question: false,
          done: 'no',
          sequence: 1,
        }),
      ),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractAttentionStreamPayload(undefined)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractAgentStateChangedPayload
// ===========================================================================

describe('extractAgentStateChangedPayload', () => {
  const validRecord = {
    agentId: 'a',
    goal: 'do stuff',
    status: 'RUNNING',
    progress: 0.5,
    toolsInUse: ['web_search'],
    messageCount: 3,
  };

  it('returns the record for a valid AGENT_STATE_CHANGED payload', () => {
    expect(extractAgentStateChangedPayload(wrap(validRecord))).toMatchObject(validRecord);
  });

  it('returns null when toolsInUse is not an array', () => {
    expect(
      extractAgentStateChangedPayload(wrap({ ...validRecord, toolsInUse: 'web_search' })),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when messageCount is missing', () => {
    const { messageCount: _mc, ...rest } = validRecord;
    expect(extractAgentStateChangedPayload(wrap(rest))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when progress is not a number', () => {
    expect(
      extractAgentStateChangedPayload(wrap({ ...validRecord, progress: 'half' })),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractAgentStateChangedPayload('nope')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractAgentModeStartedPayload
// ===========================================================================

describe('extractAgentModeStartedPayload', () => {
  it('returns the record for a valid AGENT_MODE_STARTED payload', () => {
    expect(extractAgentModeStartedPayload(wrap({ agentId: 'a' }))).toEqual({ agentId: 'a' });
  });

  it('returns null when agentId is missing', () => {
    expect(extractAgentModeStartedPayload(wrap({}))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when agentId is not a string', () => {
    expect(extractAgentModeStartedPayload(wrap({ agentId: 42 }))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when record is not an object', () => {
    expect(extractAgentModeStartedPayload(wrap('record'))).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null for invalid wrapper', () => {
    expect(extractAgentModeStartedPayload(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// extractRecord (legacy)
// ===========================================================================

describe('extractRecord', () => {
  it('returns the record from a well-formed wrapper', () => {
    expect(extractRecord(wrap({ foo: 'bar' }))).toEqual({ foo: 'bar' });
  });

  it('returns the record even when record is null (no validation)', () => {
    // Note: 'record' key must exist on payload. record value itself may be any.
    expect(extractRecord({ payload: { record: null } })).toBeNull();
  });

  it('returns null and logs when wrapper is null', () => {
    expect(extractRecord(null)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null and logs when payload is missing', () => {
    expect(extractRecord({})).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null and logs when payload is not an object', () => {
    expect(extractRecord({ payload: 'bad' })).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null and logs when record key is absent on payload', () => {
    expect(extractRecord({ payload: {} })).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null and logs when wrapper is a primitive', () => {
    expect(extractRecord(42)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});
