/**
 * CLI for the C6 benchmark check (src/features/terminal-component-group/benchmark/
 * thinkingRowsCheck.ts), loaded through Vite's SSR loader so the production modules
 * get the app's aliases and import.meta.env. Usage, from front-end/:
 *
 *   node scripts/check-thinking-rows.mjs <messages.json> <root-agent-id>
 *
 * <messages.json>: the GET /api/agents/<root-agent-id> response (or its `.messages`
 * array). Prints the JSON report; exits 0 when ok, 1 on check failures, 2 on bad input,
 * 3 on an unexpected error (so a crash is never mistaken for a failed check).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const [path, rootAgentId] = process.argv.slice(2);
if (!path || !rootAgentId) {
  console.error('usage: check-thinking-rows.mjs <messages.json> <root-agent-id>');
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(path, 'utf8'));
const messages = Array.isArray(parsed) ? parsed : parsed?.messages;
if (!Array.isArray(messages)) {
  console.error(`${path}: expected an agent-detail response or a messages array`);
  process.exit(2);
}
let report;
try {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { checkThinkingRows } = await server.ssrLoadModule(
      '/src/features/terminal-component-group/benchmark/thinkingRowsCheck.ts',
    );
    report = checkThinkingRows(messages, rootAgentId);
  } finally {
    await server.close();
  }
} catch (error) {
  console.error(`check-thinking-rows: unexpected error: ${error?.stack ?? error}`);
  process.exit(3);
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
