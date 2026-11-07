/**
 * Terminal output (a code agent's command stdout / stderr, file reads) as a
 * fenced code block, so the shared markdown renderer shows it verbatim in a
 * <pre>: line breaks kept, nothing parsed as markdown or linkified. The fence
 * is longer than any backtick run inside the output, so it cannot close early.
 */
export function fenceTerminalOutput(output: string | undefined): string {
  if (!output) return '';
  const longestRun = Math.max(0, ...(output.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${output.replace(/\n+$/, '')}\n${fence}`;
}
