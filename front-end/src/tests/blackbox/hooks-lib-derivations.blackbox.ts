import { describe, expect, it, vi } from 'vitest';

import {
  deduplicateToolMessages,
  deriveHasActiveAttentionRequest,
  derivePendingApproval,
  getContextPercentage,
  getModelContextWindow,
  sortAgents,
} from '@/features/terminal/hooks/derivations';
import { deduplicateToolMessages as deduplicateComponentToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';
describe('derivations.ts', () => {
  describe('getModelContextWindow', () => {
    it('returns contextLength when model is found', () => {
      const models = [{ id: 'abc', contextLength: 50000 } as never];
      expect(getModelContextWindow('abc', models)).toBe(50000);
    });
    it('falls back to default when model missing', () => {
      expect(getModelContextWindow('missing', [])).toBe(100000);
    });
    it('falls back to default when model has no contextLength', () => {
      const models = [{ id: 'abc' } as never];
      expect(getModelContextWindow('abc', models)).toBe(100000);
    });
  });

  describe('getContextPercentage', () => {
    it('computes percentage relative to 80% of max window', () => {
      const agent = { model: 'm', context_size: 40000 } as never;
      const models = [{ id: 'm', contextLength: 100000 } as never];
      // 80% threshold = 80000 → 40000/80000 = 50
      expect(getContextPercentage(agent, models)).toBe(50);
    });
    it('caps at 100 when context exceeds threshold', () => {
      const agent = { model: 'm', context_size: 999999 } as never;
      const models = [{ id: 'm', contextLength: 100000 } as never];
      expect(getContextPercentage(agent, models)).toBe(100);
    });
  });

  describe('deduplicateToolMessages', () => {
    const ts = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    it('passes through non-tool messages untouched', () => {
      const msgs = [
        { message_id: '1', role: 'USER', timestamp: ts(2), text: 'hi', metadata: {} },
        { message_id: '2', role: 'ASSISTANT', timestamp: ts(1), text: 'hey', metadata: {} },
      ] as never;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(2);
      // sorted ascending by timestamp
      expect(out[0].message_id).toBe('2');
    });

    it('dedups TOOL messages sharing toolCallId, keeping most recent and preserving first timestamp', () => {
      const msgs = [
        {
          message_id: 'a',
          role: 'TOOL',
          timestamp: ts(1),
          text: 'first',
          metadata: { toolCallId: 'tc1', toolStatus: 'IN_PROGRESS' },
        },
        {
          message_id: 'b',
          role: 'TOOL',
          timestamp: ts(5),
          text: 'later',
          metadata: { toolCallId: 'tc1', toolStatus: 'FINISHED' },
        },
      ] as never;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('later');
      // firstTimestamp is kept
      expect(out[0].timestamp).toBe(ts(1));
    });

    it('attention messages preserve earlier message_id when dedup', () => {
      const msgs = [
        {
          message_id: 'original',
          role: 'TOOL',
          timestamp: ts(1),
          text: 'x',
          metadata: { toolCallId: 'tc1' },
        },
        {
          message_id: 'newer',
          role: 'TOOL',
          timestamp: ts(2),
          text: 'y',
          metadata: { toolCallId: 'tc1', isUserAttentionMessage: true },
        },
      ] as never;
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      // attention path takes newer content but keeps existing message_id
      expect(out[0].message_id).toBe('original');
    });

    it('tool message missing toolCallId is pushed through as non-tool', () => {
      const msgs = [
        { message_id: 'x', role: 'TOOL', timestamp: ts(1), text: 'no-id', metadata: {} },
      ] as never;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = deduplicateToolMessages(msgs);
      expect(out).toHaveLength(1);
      errSpy.mockRestore();
    });

    it('orders DAG reasoning assistant rows by first stream timestamp', () => {
      const msgs = [
        {
          message_id: 'code',
          role: 'TOOL',
          timestamp: ts(3),
          text: 'code done',
          metadata: {
            toolCallId: 'code-1',
            toolName: 'spawn_claude_code_agent',
            toolStatus: 'FINISHED',
          },
        },
        {
          message_id: 'thought',
          role: 'ASSISTANT',
          timestamp: ts(5),
          text: 'reasoned later',
          metadata: {
            dagTaskIndex: 5,
            plannedToolName: 'reasoning',
            firstTimestamp: ts(2),
          },
        },
      ] as never;
      const out = deduplicateToolMessages(msgs);
      expect(out.map((m) => m.message_id)).toEqual(['thought', 'code']);
    });

    it('hides internal agent init liveness tools', () => {
      const msgs = [
        {
          message_id: 'init',
          role: 'TOOL',
          timestamp: ts(1),
          text: 'Agent initializing',
          metadata: {
            toolCallId: 'tc-agent-init',
            toolName: 'agent_init',
            title: 'Initializing',
            toolStatus: 'IN_PROGRESS',
          },
        },
        { message_id: 'user', role: 'USER', timestamp: ts(2), text: 'hi', metadata: {} },
      ] as never;
      const out = deduplicateToolMessages(msgs);
      expect(out.map((m) => m.message_id)).toEqual(['user']);
    });

    it('component-group helper collapses phone call lifecycle to the finished card', () => {
      const msgs = [
        {
          message_id: 'init',
          role: 'TOOL',
          timestamp: ts(1),
          text: '**Calling:** +1 (619) 915-3156',
          metadata: {
            toolCallId: 'call-1',
            toolName: 'call_phone_number',
            title: '📞 Initiating call',
            toolStatus: 'IN_PROGRESS',
            phoneCall: { status: 'initiating', to: '+1 (619) 915-3156' },
          },
        },
        {
          message_id: 'progress',
          role: 'TOOL',
          timestamp: ts(2),
          text: '**Calling:** +1 (619) 915-3156',
          metadata: {
            toolCallId: 'call-1',
            toolName: 'call_phone_number',
            title: '📞 Call in progress',
            toolStatus: 'IN_PROGRESS',
            phoneCall: { status: 'in-progress', to: '+1 (619) 915-3156' },
          },
        },
        {
          message_id: 'done',
          role: 'TOOL',
          timestamp: ts(3),
          text: 'Call completed with transcript',
          metadata: {
            toolCallId: 'call-1',
            toolName: 'call_phone_number',
            title: '✅ Call completed',
            toolStatus: 'FINISHED',
            phoneCall: {
              status: 'ended',
              to: '+1 (619) 915-3156',
              transcript: 'Jordan Miles confirmed the address.',
            },
          },
        },
      ] as never;

      const [out] = deduplicateComponentToolMessages(msgs);

      expect(out).toHaveLength(1);
      expect(out[0].message_id).toBe('done');
      expect(out[0].metadata?.toolStatus).toBe('FINISHED');
      expect((out[0].metadata?.phoneCall as never).status).toBe('ended');
      expect(out[0].text).toContain('transcript');
    });
  });

  describe('sortAgents', () => {
    const mk = (id: string, status: string, progress = 0) =>
      ({ agent_id: id, status, progress }) as never;

    it('puts COMPLETED agents last', () => {
      const out = sortAgents([mk('done', 'COMPLETED'), mk('active', 'ACTIVE')]);
      expect(out.map((a) => a.agent_id)).toEqual(['active', 'done']);
    });
    it('puts paused statuses after active', () => {
      const out = sortAgents([mk('paused', 'PAUSED'), mk('active', 'ACTIVE')]);
      expect(out.map((a) => a.agent_id)).toEqual(['active', 'paused']);
    });
    it('within same bucket, sorts by progress descending', () => {
      const out = sortAgents([mk('low', 'ACTIVE', 0.1), mk('high', 'ACTIVE', 0.9)]);
      expect(out.map((a) => a.agent_id)).toEqual(['high', 'low']);
    });
  });

  describe('derivePendingApproval / deriveHasActiveAttentionRequest', () => {
    const base = {
      message_id: 'a',
      role: 'TOOL',
      text: 'Approve?',
      timestamp: new Date().toISOString(),
    };

    it('returns null when no attention message present', () => {
      expect(derivePendingApproval([])).toBeNull();
      expect(deriveHasActiveAttentionRequest([])).toBe(false);
    });

    it('returns approval object when toolApproval IN_PROGRESS', () => {
      const msgs = [
        {
          ...base,
          metadata: {
            isUserAttentionMessage: true,
            toolCallId: 'tc1',
            toolStatus: 'IN_PROGRESS',
            requestUserApproval: { toolApproval: true, attentionRequestId: 'req-1' },
            imageUrl: 'https://img',
          },
        },
      ] as never;
      const result = derivePendingApproval(msgs);
      expect(result).toEqual({
        attentionRequestId: 'req-1',
        question: 'Approve?',
        imageUrl: 'https://img',
      });
      expect(deriveHasActiveAttentionRequest(msgs)).toBe(true);
    });

    it('returns null when attentionRequestId is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const msgs = [
        {
          ...base,
          metadata: {
            isUserAttentionMessage: true,
            toolCallId: 'tc1',
            toolStatus: 'IN_PROGRESS',
            requestUserApproval: { toolApproval: true },
          },
        },
      ] as never;
      expect(derivePendingApproval(msgs)).toBeNull();
      warnSpy.mockRestore();
    });

    it('ignores messages lacking toolCallId on attention lookup', () => {
      const msgs = [
        {
          ...base,
          metadata: { isUserAttentionMessage: true, toolStatus: 'IN_PROGRESS' },
        },
      ] as never;
      expect(derivePendingApproval(msgs)).toBeNull();
      expect(deriveHasActiveAttentionRequest(msgs)).toBe(false);
    });
  });
});
