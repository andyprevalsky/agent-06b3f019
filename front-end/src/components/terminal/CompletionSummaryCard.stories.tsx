import type { Meta, StoryObj } from '@storybook/react-vite';
import { CompletionSummaryCard, CompletionSummaryData } from './CompletionSummaryCard';

const meta: Meta<typeof CompletionSummaryCard> = {
  title: 'Terminal/CompletionSummaryCard',
  component: CompletionSummaryCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[400px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Simple example with minimal data
export const Simple: Story = {
  args: {
    data: {
      summary: 'Generated random integer between 0-10 since depth was 0.',
      outputs: [
        {
          key: 'random_integer',
          label: 'Random Integer',
          value: 1,
        },
      ],
      toolUsage: [
        { name: 'query_blueprints', count: 2 },
        { name: 'set_plan', count: 2 },
      ],
      totalToolCalls: 4,
    } satisfies CompletionSummaryData,
  },
};

// Complex example with multiple outputs
export const WithMultipleOutputs: Story = {
  args: {
    data: {
      summary:
        'Successfully found contact information for John Smith and verified email deliverability.',
      outputs: [
        {
          key: 'contact_email',
          label: 'Contact Email',
          value: 'john.smith@example.com',
        },
        {
          key: 'phone_numbers',
          label: 'Phone Numbers',
          value: ['+1-555-123-4567', '+1-555-987-6543'],
        },
        {
          key: 'linkedin_url',
          label: 'LinkedIn URL',
          value: 'https://linkedin.com/in/johnsmith',
        },
      ],
      toolUsage: [
        { name: 'web_search', count: 5 },
        { name: 'spawn_browser_agent', count: 3 },
        { name: 'enrich', count: 2 },
        { name: 'deep_research', count: 1 },
      ],
      totalToolCalls: 11,
      durationSeconds: 45,
      costDollars: 0.023,
    } satisfies CompletionSummaryData,
  },
};

// Example with sub-agents and many tools
export const WithSubAgents: Story = {
  args: {
    data: {
      summary:
        'Completed market research analysis by spawning multiple sub-agents to gather data from different sources.',
      outputs: [
        {
          key: 'competitors_found',
          label: 'Competitors Found',
          value: ['Acme Corp', 'GlobalTech', 'Innovate Inc', 'TechStart'],
        },
        {
          key: 'market_size',
          label: 'Estimated Market Size',
          value: '$4.2B',
        },
      ],
      toolUsage: [
        { name: 'spawn_sub_agent', count: 4 },
        { name: 'web_search', count: 12 },
        { name: 'spawn_browser_agent', count: 6 },
        { name: 'deep_research', count: 3 },
        { name: 'enrich', count: 8 },
        { name: 'find_all', count: 2 },
      ],
      totalToolCalls: 35,
      durationSeconds: 180,
      costDollars: 0.156,
    } satisfies CompletionSummaryData,
  },
};

// Minimal - no outputs, just summary
export const MinimalNoOutputs: Story = {
  args: {
    data: {
      summary:
        'Task completed successfully. The agent performed the requested operation without returning structured data.',
      toolUsage: [{ name: 'send_message_to_user', count: 1 }],
      totalToolCalls: 1,
      durationSeconds: 3,
    } satisfies CompletionSummaryData,
  },
};

// SMS sending example
export const SMSSent: Story = {
  args: {
    data: {
      summary: 'Successfully sent SMS messages to the contact list for the meeting reminder.',
      outputs: [
        {
          key: 'messages_sent',
          label: 'Messages Sent',
          value: 5,
        },
        {
          key: 'recipients',
          label: 'Recipients',
          value: ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'],
        },
      ],
      toolUsage: [
        { name: 'search_user_network_for_people', count: 1 },
        { name: 'send_sms_as_user', count: 5 },
      ],
      totalToolCalls: 6,
      durationSeconds: 12,
      costDollars: 0.005,
    } satisfies CompletionSummaryData,
  },
};

// Long running task
export const LongRunningTask: Story = {
  args: {
    data: {
      summary:
        'Completed comprehensive competitive analysis after extensive web research and data gathering across multiple sources.',
      outputs: [
        {
          key: 'report_url',
          label: 'Report URL',
          value: 'https://docs.google.com/document/d/abc123',
        },
      ],
      toolUsage: [
        { name: 'spawn_sub_agent', count: 8 },
        { name: 'web_search', count: 45 },
        { name: 'spawn_browser_agent', count: 12 },
        { name: 'deep_research', count: 6 },
        { name: 'spawn_claude_code_agent', count: 2 },
      ],
      totalToolCalls: 73,
      durationSeconds: 542,
      costDollars: 0.892,
    } satisfies CompletionSummaryData,
  },
};
