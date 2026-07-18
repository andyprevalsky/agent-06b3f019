import { describe, expect, it, vi } from 'vitest';

import {
  deriveHasActiveAttentionRequest,
  derivePendingApproval,
  getContextPercentage,
  getModelContextWindow,
  sortAgents,
} from '@/features/terminal/hooks/derivations';

describe('lightweight terminal derivations', () => {
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
      expect(getContextPercentage(agent, models)).toBe(50);
    });
    it('caps at 100 when context exceeds threshold', () => {
      const agent = { model: 'm', context_size: 999999 } as never;
      const models = [{ id: 'm', contextLength: 100000 } as never];
      expect(getContextPercentage(agent, models)).toBe(100);
    });
  });

  describe('sortAgents', () => {
    const makeAgent = (id: string, status: string, progress = 0) =>
      ({ agent_id: id, status, progress }) as never;

    it('puts COMPLETED agents last', () => {
      const out = sortAgents([makeAgent('done', 'COMPLETED'), makeAgent('active', 'ACTIVE')]);
      expect(out.map((agent) => agent.agent_id)).toEqual(['active', 'done']);
    });
    it('puts paused statuses after active', () => {
      const out = sortAgents([makeAgent('paused', 'PAUSED'), makeAgent('active', 'ACTIVE')]);
      expect(out.map((agent) => agent.agent_id)).toEqual(['active', 'paused']);
    });
    it('within same bucket, sorts by progress descending', () => {
      const out = sortAgents([makeAgent('low', 'ACTIVE', 0.1), makeAgent('high', 'ACTIVE', 0.9)]);
      expect(out.map((agent) => agent.agent_id)).toEqual(['high', 'low']);
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
      const messages = [
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
      expect(derivePendingApproval(messages)).toEqual({
        attentionRequestId: 'req-1',
        question: 'Approve?',
        imageUrl: 'https://img',
      });
      expect(deriveHasActiveAttentionRequest(messages)).toBe(true);
    });

    it('returns null when attentionRequestId is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const messages = [
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
      expect(derivePendingApproval(messages)).toBeNull();
      warnSpy.mockRestore();
    });

    it('ignores messages lacking toolCallId on attention lookup', () => {
      const messages = [
        {
          ...base,
          metadata: { isUserAttentionMessage: true, toolStatus: 'IN_PROGRESS' },
        },
      ] as never;
      expect(derivePendingApproval(messages)).toBeNull();
      expect(deriveHasActiveAttentionRequest(messages)).toBe(false);
    });
  });
});
