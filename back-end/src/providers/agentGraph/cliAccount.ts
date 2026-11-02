/** Generated CLI extension. Authorization comes from applicable instructions, not tool discovery. */
export const AGENT_ACCOUNT_CLI_SCRIPT = String.raw`
function accountFlags(args, allowed) {
  const out = {}, words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.includes(name)) fail('unknown option ' + arg, 2);
    if (out[name] !== undefined) fail('duplicate option ' + arg, 2);
    if (name === 'json') { out[name] = true; continue; }
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(arg + ' needs a value', 2);
    out[name] = args[++i];
  }
  return { flags: out, words };
}
function smallFile(file, maximum) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) fail('Expected a regular file', 2);
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > maximum) fail('File exceeds ' + maximum + ' bytes', 2);
    return bytes.subarray(0, used).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function accountPrint(data, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
  for (const a of data.agents || []) process.stdout.write(a.agent_id + '  ' + a.status + '  ' + (a.title || a.goal_preview) + '\n  ' + a.read_command + '\n');
  for (const m of data.messages || []) process.stdout.write(m.message_id + '  ' + m.role + '  ' + m.timestamp + '\n' + m.text + '\n' + (m.more_command ? 'MORE MESSAGE: ' + m.more_command + '\n' : ''));
  if (data.agent_id && !data.messages) process.stdout.write(data.agent_id + '  ' + data.url + '\n');
  if (data.next_command) process.stdout.write('MORE: ' + data.next_command + '\n');
}
async function accountCommand(command, args) {
  const accountList = command === 'list' && args.includes('--scope');
  const accountSend = command === 'send' && args.includes('--scope');
  if (!accountList && !accountSend && command !== 'read' && command !== 'spawn') return false;
  if (process.env.ROSE_ACCOUNT_AGENTS_ENABLED !== 'true') fail('Rose account commands are disabled. Deploy repairs currently use boxes.dev; enable ROSE_ACCOUNT_AGENTS_ENABLED=true only for an authorized migration or test.', 2);
  const allowed = command === 'spawn' ? ['project','folder','title','goal-file','instruction-file','id','json']
    : command === 'read' ? ['limit','cursor','message','offset','json']
    : command === 'send' ? ['scope','id','json'] : ['scope','project','folder','limit','cursor','json'];
  const parsed = accountFlags(args, allowed), f = parsed.flags, words = parsed.words;
  if (accountList) {
    if (f.scope !== 'account' || words.length) fail('Use list --scope account', 2);
    const query = new URLSearchParams();
    for (const k of ['project','folder','limit','cursor']) if (f[k] !== undefined) query.set(k, f[k]);
    accountPrint(await call('GET', '/account/agents?' + query), f.json);
  } else if (command === 'read') {
    if (words.length !== 1) fail('Use read <agent-id>', 2);
    const query = new URLSearchParams();
    for (const k of ['limit','cursor','message','offset']) if (f[k] !== undefined) query.set(k, f[k]);
    accountPrint(await call('GET', '/account/agents/' + encodeURIComponent(words[0]) + '?' + query), f.json);
  } else if (accountSend) {
    if (f.scope !== 'account' || words.length < 2) fail('Use send <id> <message|-> --scope account', 2);
    const text = words.length === 2 && words[1] === '-' ? await readStdin() : words.slice(1).join(' ');
    const data = await call('POST', '/account/messages', { to: words[0], text, message_id: f.id || crypto.randomUUID() });
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    for (const k of ['project','folder','title','goal-file','instruction-file','id']) if (!f[k]) fail('--' + k + ' is required', 2);
    if (words.length) fail('Unexpected spawn arguments', 2);
    // An explicit opt-in in an existing instruction file is required. The general
    // agent-graph skill deliberately has no such declaration. This is a workflow
    // use guard, not a replacement for server-side account authentication.
    const instructionPath = fs.realpathSync(f['instruction-file']);
    if (!['deploy.md','SKILL.md','CLAUDE.md','AGENTS.md'].includes(path.basename(instructionPath))) fail('Use an applicable instruction file', 2);
    const instruction = smallFile(instructionPath, 1024 * 1024);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(instruction);
    if (!frontmatter || !/^rose-agent-spawn:\s*true\s*$/m.test(frontmatter[1])) fail('Spawn requires an applicable existing instruction declaring rose-agent-spawn: true', 2);
    const goal = smallFile(f['goal-file'], 100000);
    accountPrint(await call('POST', '/account/spawn', { project: f.project, folder: f.folder, title: f.title, goal, id: f.id,
      instruction: { path: instructionPath, sha256: crypto.createHash('sha256').update(instruction).digest('hex'), explicitly_authorized: true } }), f.json);
  }
  return true;
}
`;
