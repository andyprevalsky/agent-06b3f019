/**
 * Blackbox contract for backend-emitted tool icons.
 *
 * Backend TOOL message -> metadata.toolName -> explicit Lucide/brand icon -> rendered tool row
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';
import { BACKEND_EMITTED_TOOL_NAMES } from '@/lib/backendToolNames';
import { CLAUDE_CODE_TOOLS, TOOL_ICONS, X402_TOOLS } from '@/lib/toolIcons';

describe('backend-emitted tool icon contract', () => {
  it('assigns every indexed backend tool an explicit Lucide or brand icon', () => {
    const brandedTools = new Set([...X402_TOOLS, ...CLAUDE_CODE_TOOLS]);
    const toolsWithoutIcons = BACKEND_EMITTED_TOOL_NAMES.filter(
      (toolName) => !Object.hasOwn(TOOL_ICONS, toolName) && !brandedTools.has(toolName),
    );

    expect(toolsWithoutIcons).toEqual([]);
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
