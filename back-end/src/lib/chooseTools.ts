/**
 * LLM-based tool selection for agent initialization
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';

interface Tool {
  id: string;
  name: string;
  description: string | null;
}

const ToolSelectionSchema = z.object({
  reasoning: z.string().describe("Your thinking about which tools would be most useful for this goal"),
  selected_tool_ids: z.array(z.string()).max(10).describe("List of 0-10 tool IDs to attach to the agent. Only include tools that are DIRECTLY relevant to the goal.")
});

type ToolSelection = z.infer<typeof ToolSelectionSchema>;

/**
 * Use LLM to intelligently select which tools to attach to an agent based on its goal.
 * 
 * This function analyzes the goal and available tools to pick 0-10 most relevant tools,
 * avoiding over-attachment of unnecessary tools and improving agent focus.
 * 
 * @param goal - The agent's goal/task
 * @param availableTools - List of tools with id, name, and description
 * @param model - LLM model to use for selection (defaults to fast/cheap model)
 * @returns Object containing tool IDs and token usage
 */
export async function chooseTools(
  goal: string,
  availableTools: Tool[],
  model: string = 'google/gemini-2.5-flash'
): Promise<{ toolIds: string[]; tokensIn: number; tokensOut: number }> {
  try {
    console.log(`🤖 Selecting tools for goal: ${goal.substring(0, 50)}...`);

    // Build tool catalog for LLM
    const toolsCatalog = availableTools.map(tool => 
      `- Tool ID: ${tool.id}\n` +
      `  Name: ${tool.name}\n` +
      `  Description: ${tool.description || 'No description'}\n`
    ).join('\n');

    const systemPrompt = `You are an expert at analyzing agent goals and selecting the most relevant tools.

Your task: Given a goal and available tools, select 0-10 tools that would be DIRECTLY useful for accomplishing the goal.

GUIDELINES:
- Be selective - only choose tools that are CLEARLY relevant to the goal
- Quality over quantity - it's better to select 2-3 perfect tools than 10 marginally relevant ones
- Consider the goal's domain: research, shopping, coordination, time-based tasks, etc.
- Don't over-attach tools "just in case" - this dilutes the agent's focus
- It's OK to select 0 tools if the goal is purely conversational or doesn't need external tools

AVAILABLE TOOLS:
${toolsCatalog}

Return your analysis and the list of selected tool IDs.`;

    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });

    // @ts-expect-error - OpenAI SDK's zodResponseFormat has deep type inference issues
    const responseFormat = zodResponseFormat(ToolSelectionSchema, 'tool_selection');

    const response = await client.beta.chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Goal: ${goal}\n\nWhich tools should I attach to accomplish this goal?` }
      ],
      temperature: 0.3, // Lower temperature for more consistent selection
      max_tokens: 2000,
      response_format: responseFormat,
    });

    const result = response.choices[0].message.parsed as ToolSelection;

    if (!result) {
      console.error('❌ LLM returned no parsed result');
      return { toolIds: [], tokensIn: 0, tokensOut: 0 };
    }

    // Validate that selected IDs exist in available tools
    const availableIds = new Set(availableTools.map(t => t.id));
    const validToolIds = result.selected_tool_ids.filter(id => availableIds.has(id));

    if (validToolIds.length !== result.selected_tool_ids.length) {
      const invalidIds = result.selected_tool_ids.filter(id => !availableIds.has(id));
      console.warn(`⚠️  LLM selected invalid tool IDs: ${invalidIds.join(', ')}`);
    }

    const selectedTools = availableTools.filter(t => validToolIds.includes(t.id));
    
    const tokensIn = response.usage?.prompt_tokens || 0;
    const tokensOut = response.usage?.completion_tokens || 0;
    
    console.log('✅ Tools selected by LLM', {
      reasoning: result.reasoning,
      selectedCount: validToolIds.length,
      selectedTools: selectedTools.map(t => t.name),
      tokensIn,
      tokensOut
    });

    return { toolIds: validToolIds, tokensIn, tokensOut };

  } catch (error) {
    console.error('❌ Failed to select tools with LLM', error);
    // On error, return empty list (safer than randomly selecting tools)
    return { toolIds: [], tokensIn: 0, tokensOut: 0 };
  }
}

