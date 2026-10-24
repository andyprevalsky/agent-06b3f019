/** Recorded descend-full69 r004-j0049 content shared by the offline and live modes. */

// Recorded in descend-full69 r004-j0049; every frame carrying it got a 403.
export const BLOCKED_COMMAND =
  "/bin/bash -lc \"rg --files -g 'AGENTS.md' -g 'report-display-format.md' -g 'index.css' /home/user 2>/dev/null | head -80; mkdir -p /home/user/output; curl -L --fail --silent https://raw.githubusercontent.com/Rose-Ai-Labs/rose/main/.claude/shared/report-display-format.md -o /tmp/rose-report-format.md; curl -L --fail --silent https://raw.githubusercontent.com/Rose-Ai-Labs/rose/main/front-end/src/index.css -o /tmp/rose-index.css; sed -n '1,240p' /tmp/rose-report-format.md; sed -n '1,240p' /tmp/rose-index.css\"";
export const blockedRecord = (id: string, padding = 0) => ({
  id,
  timestamp: new Date('2026-10-23T23:18:43.499Z'),
  text: `Code-agent SDK event JSON:\n${JSON.stringify({ command: BLOCKED_COMMAND })}${'.'.repeat(padding)}`,
  role: 'TOOL',
  metadata: {
    toolName: 'spawn_claude_code_agent',
    toolStatus: 'FINISHED',
    toolCallId: 'call_530ea3ca9bf640358d491ade206558b2',
    success: true,
    command: BLOCKED_COMMAND,
  },
});
export const decodeEncoded = (record: Record<string, unknown>) =>
  JSON.parse(Buffer.from(String(record.data), 'base64').toString('utf8')) as {
    text: string;
    metadata: unknown;
  };
