/** Shared synthetic native-phone transport fixture; no provider or credentials. */
import { vi, expect } from 'vitest';
import type { Message } from '@/features/terminal-component-group/hooks';
export const target = { kind: 'iphone', browserTaskId: 'task-a', leaseId: 'lease-a' };
export const meta = {
  requestId: 'request-a',
  target,
  criticalReason: 'password',
  handoffMode: 'manual_step',
  taskId: 'task-a',
};
export const messages = [
  {
    message_id: 'attention-a',
    timestamp: 'now',
    role: 'TOOL',
    text: '',
    metadata: {
      task_id: 'task-a',
      toolStatus: 'IN_PROGRESS',
      action_type: 'auth_assistance',
      requestUserAuthentication: meta,
    },
  },
] as Message[];
export const props = () => ({
  taskId: 'task-a',
  agentId: 'agent-a',
  browserUrl: 'https://example.com/browser',
  messages,
  outputSchema: undefined,
  browserSessionMetadata: null,
  stepProgress: null,
  isDisconnected: false,
  isWaitingForAuthAssistance: true,
  isResuming: false,
  isUserControlling: false,
  pendingWriteLockApproval: null,
  onClose: vi.fn(),
  onResume: vi.fn(),
});
export function fixture(
  overrides: Record<string, unknown> = {},
  interaction: Record<string, unknown> = {},
  leaseOverrides: Record<string, unknown> = {},
) {
  let completedAt: string | null = null;
  let pending = (interaction.pendingOperation as Record<string, unknown> | null) ?? null;
  let unknown = false;
  let completeLost = false;
  const posts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let cursor = 0;
  const request = () => ({
    id: 'request-a',
    agentId: 'agent-a',
    mode: 'manual_step',
    target,
    criticalReason: 'password',
    completedAt,
    ...overrides,
  });
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth-assistance/request-a'))
        return json({
          request: request(),
          handoff: { type: 'manual_step', target, criticalReason: 'password' },
        });
      if (path.endsWith('/auth-assistance/request-a/complete')) {
        expect(init?.body).toBeUndefined();
        completedAt = '2026-10-18T22:00:00Z';
        if (completeLost) throw new TypeError('synthetic lost response');
        return json({ success: true });
      }
      if (path.endsWith('/iphone/interactions/task-a'))
        return json({
          lease: {
            id: 'lease-a',
            agentId: 'agent-a',
            browserTaskId: 'task-a',
            status: 'ACTIVE',
            controlOwner: 'user',
            attentionRequestId: completedAt ? null : 'request-a',
            revision: 1,
            ...leaseOverrides,
          },
          cursor,
          lastOperation: null,
          pendingOperation: pending,
          ...interaction,
        });
      if (path.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (path.endsWith('/operations') && init?.method === 'POST') {
        const command = JSON.parse(String(init.body));
        posts.push(command);
        cursor++;
        expect(command.attentionRequestId).toBe(
          leaseOverrides.attentionRequestId === null ? undefined : 'request-a',
        );
        const operation = {
          id: command.operationId,
          cursor,
          operation: command.operation,
          status: 'SUCCEEDED',
          errorCode: null,
          result:
            command.operation === 'screen.bounds'
              ? { x: 0, y: 0, w: 430, h: 932 }
              : { success: true, private: true },
        };
        if (unknown && command.operation === 'input.text') {
          pending = { ...operation, status: 'UNKNOWN' };
          throw new TypeError('synthetic lost response');
        }
        return json({ operation });
      }
      if (path.includes('/operations/')) return json({ operation: pending });
      throw new Error(`Unexpected fixture route ${path}`);
    }),
  );
  return {
    posts,
    calls,
    request,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
    setCompleteLost: () => {
      completeLost = true;
    },
  };
}
