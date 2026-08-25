/**
 * Compaction prompt for chat-mode context summarization.
 *
 * Mirrors agents/helpers/summarize.py PARTIAL_COMPACT_PROMPT (Claude Code compact.ts).
 */

export const COMPACTION_SUMMARY_PREFIX = '[CONTEXT SUMMARY]:';

export const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received
2. Double-check for technical accuracy and completeness.

Your summary should include these sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Also include:

## Pending user asks
List active user asks that still matter after the retained recent messages.

## Exact identifiers
Preserve literal values exactly as seen when needed for continuity: IDs, URLs, file paths, ports, hashes, dates, and times.

Please provide your summary based on the RECENT messages only (after the retained earlier context).`;

export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- You already have all the context you need in the conversation below.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`;

export const NO_TOOLS_TRAILER = '\nRemember: respond with TEXT ONLY. Do NOT call tools.\n';

export function stripCompactAnalysis(summary: string): string {
  const match = summary.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match?.[1]) return match[1].trim();
  return summary.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
}
