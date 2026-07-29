/**
 * Blackbox contract for backend-emitted tool icons.
 *
 * Backend TOOL message -> metadata.toolName -> explicit Lucide/brand icon -> rendered tool row
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';
import { BACKEND_EMITTED_TOOL_NAMES, BROWSER_EMITTED_ACTION_TYPES } from '@/lib/backendToolNames';
import { CLAUDE_CODE_TOOLS, getToolIcon, TOOL_ICONS, X402_TOOLS } from '@/lib/toolIcons';

describe('backend-emitted tool icon contract', () => {
  it('assigns every indexed backend tool an explicit Lucide or brand icon', () => {
    const brandedTools = new Set([...X402_TOOLS, ...CLAUDE_CODE_TOOLS]);
    const toolsWithoutIcons = BACKEND_EMITTED_TOOL_NAMES.filter(
      (toolName) => !Object.hasOwn(TOOL_ICONS, toolName) && !brandedTools.has(toolName),
    );

    expect(toolsWithoutIcons).toEqual([]);
  });

  it('assigns every browser action_type an explicit icon instead of the Info fallback', () => {
    const actionTypesWithoutIcons = BROWSER_EMITTED_ACTION_TYPES.filter(
      (actionType) => !Object.hasOwn(TOOL_ICONS, actionType),
    );

    expect(actionTypesWithoutIcons).toEqual([]);
  });

  it('renders the network icon for a read_network_requests browser step', () => {
    const { container } = render(
      <ToolMessage
        data={{
          toolCallId: 'read-network-1',
          toolName: 'browser_agent',
          actionType: 'read_network_requests',
          title: 'Read network requests',
          status: 'FINISHED',
          message: 'Captured 12 network request(s).',
        }}
      />,
    );

    expect(container.querySelector('.lucide-network')).not.toBeNull();
  });

  it('falls back to Info only for genuinely unknown action types', () => {
    expect(getToolIcon('read_network_requests')).toBe(TOOL_ICONS.read_network_requests);
    expect(getToolIcon('totally_unknown_action')).toBe(TOOL_ICONS.default);
  });

  it('renders a messaging icon for a completed iMessage', () => {
    const { container } = render(
      <ToolMessage
        data={{
          toolCallId: 'message-person-1',
          toolName: 'message_person',
          title: 'iMessage sent to X',
          status: 'FINISHED',
          message: 'Sent',
        }}
      />,
    );

    expect(container.querySelector('.lucide-message-square')).not.toBeNull();
  });
});
