/**
 * Fake local tools for rose-import.blackbox.ts: `codex` / `claude` (one script;
 * argv, leaked env and canned plans driven by FAKE_* variables), `security`
 * (the macOS Keychain lookup, exit code only) and `gh` (auth token). Each
 * appends {bin, args[, leaked]} to $FAKE_LOG.
 */
export const AGENT_SCRIPT = `#!${process.execPath}
const fs = require('fs');
const bin = require('path').basename(process.argv[1]);
const args = process.argv.slice(2);
const leaked = ['ROSE_LOGIN_CODE', 'ELECTRON_RUN_AS_NODE'].filter((key) => key in process.env);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin, args, leaked }) + '\\n');
if (args[0] === '--version') {
  if (process.env.FAKE_VERSION_FAIL === bin) process.exit(1);
  console.log(bin + ' 9.9.9');
  process.exit(0);
}
const countFile = process.env.FAKE_LOG + '.' + bin;
let n = 0;
try { n = Number(fs.readFileSync(countFile, 'utf8')); } catch {}
fs.writeFileSync(countFile, String(n + 1));
const mode = process.env.FAKE_AGENT_MODE || 'ok';
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
const garbage = mode === 'garbage' || (mode === 'garbage-once' && n === 0);
const text = garbage ? 'I could not decide what to import.' : process.env.FAKE_PLAN;
if (bin === 'codex') {
  fs.writeFileSync(args[args.indexOf('-o') + 1], text);
  console.log('codex finished');
} else {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success',
    result: garbage ? text : 'Here is the plan:\\n\\x60\\x60\\x60json\\n' + text + '\\n\\x60\\x60\\x60' }));
}
`;
export const SECURITY_SCRIPT = `#!${process.execPath}
require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: 'security', args: process.argv.slice(2) }) + '\\n');
process.exit(process.env.FAKE_KEYCHAIN === 'present' ? 0 : 44);
`;
export const GH_SCRIPT = `#!${process.execPath}
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: 'gh', args }) + '\\n');
if (args[0] === 'auth' && args[1] === 'token' && process.env.FAKE_GH_TOKEN) {
  console.log(process.env.FAKE_GH_TOKEN);
  process.exit(0);
}
process.exit(1);
`;
