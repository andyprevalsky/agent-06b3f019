import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  extractInsertPayload,
  extractUpdatePayload,
  extractDeletePayload,
  extractAssistantStreamPayload,
  extractPlanStreamPayload,
  extractToolStreamPayload,
  extractAttentionStreamPayload,
  extractAgentStateChangedPayload,
  extractAgentModeStartedPayload,
  extractUserUiActiveChangedPayload,
  extractRecord,
} from '@/lib/realtime-types';

function wrap<T>(record: T) {
  return { payload: { record } };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

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
      extractInsertPayload(wrap({ agentId: 'a', id: 'i', timestamp: 't', text: 'x', role: 'BAD' })),
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
    const record = {
      agentId: 'a',
      stream_id: 's',
      delta: 'hi',
      done: false,
      sequence: 1,
      is_gpt: true,
      llm_started_at_ms: 1700000000000,
      char_count: 120,
    };
    expect(extractAssistantStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when fields are missing', () => {
    expect(extractAssistantStreamPayload(wrap({ agentId: 'a', stream_id: 's' }))).toBeNull();
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
      char_count: 120,
      llm_started_at_ms: 1700000000000,
    };
    expect(extractPlanStreamPayload(wrap(record))).toEqual(record);
  });

  it('returns null when title is missing', () => {
    expect(
      extractPlanStreamPayload(wrap({ agentId: 'a', stream_id: 's', tool_call_id: 'tc' })),
    ).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null when tool_call_id is missing', () => {
    expect(extractPlanStreamPayload(wrap({ agentId: 'a', stream_id: 's', title: 'x' }))).toBeNull();
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
      status: 'IN_PROGRESS',
      char_count: 180,
      llm_started_at_ms: 1700000000000,
      is_claude: true,
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
    expect(extractAgentStateChangedPayload(wrap({ ...validRecord, progress: 'half' }))).toBeNull();
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
});

// ===========================================================================
// extractUserUiActiveChangedPayload (backend broadcastUserUiActiveChanged)
// ===========================================================================

describe('extractUserUiActiveChangedPayload', () => {
  it('returns {versionId, agentId} from the wrapped record', () => {
    expect(
      extractUserUiActiveChangedPayload(wrap({ versionId: 'ver-2', agentId: 'code-1' })),
    ).toEqual({ versionId: 'ver-2', agentId: 'code-1' });
  });

  it('returns null when versionId or agentId is missing', () => {
    expect(extractUserUiActiveChangedPayload(wrap({ agentId: 'code-1' }))).toBeNull();
    expect(extractUserUiActiveChangedPayload(wrap({ versionId: 'ver-2' }))).toBeNull();
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

describe('database broadcast timestamps use the same UTC contract as the API', () => {
  it.each([
    ['2026-11-07T20:20:51.226', '2026-11-07T20:20:51.226Z'],
    ['2026-11-07T20:20:51.226Z', '2026-11-07T20:20:51.226Z'],
    ['2026-11-07T12:20:51.226-08:00', '2026-11-07T20:20:51.226Z'],
  ])('normalizes the native Agent row %s without mutating the frame', (updatedAt, expected) => {
    const record = { id: 'agent-a', updatedAt, status: 'PAUSED' };
    const out = extractUpdatePayload({ payload: { schema: 'public', table: 'Agent', record } });
    expect(out).toMatchObject({ agentId: 'agent-a', updatedAt: expected, status: 'PAUSED' });
    expect(record.updatedAt).toBe(updatedAt);
    expect(record).not.toHaveProperty('agentId');
  });
  it('normalizes raw Message starts before they can win INSERT deduplication', () => {
    const record = {
      id: 'message-a',
      agentId: 'agent-a',
      role: 'USER',
      text: 'Start',
      timestamp: '2026-11-07T18:58:57.979',
    };
    expect(
      extractInsertPayload({ payload: { schema: 'public', table: 'Message', record } }),
    ).toMatchObject({ timestamp: '2026-11-07T18:58:57.979Z' });
    expect(record.timestamp).toBe('2026-11-07T18:58:57.979');
  });
});
