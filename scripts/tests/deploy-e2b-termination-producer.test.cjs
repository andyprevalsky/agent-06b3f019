const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('../../back-end/node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'back-end/src/tests/blackbox/run.ts'), 'utf8');
const ast = ts.createSourceFile('run.ts', source, ts.ScriptTarget.Latest, true);
const names = ['runDomain', 'runScheduledDomain', 'domainExitLine'];
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, 3);
let resultMap;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'results' &&
      ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'results.map') {
    resultMap = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(resultMap, 'exercise actual final native JSON mapping');
const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n') +
  `\nglobalThis.native = { runDomain, runScheduledDomain, serialize: (results) => results.map(${resultMap}) };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

async function execute(scenarios, retried = false) {
  const timers = new Map();
  const budgets = [];
  let timerId = 0;
  const context = {
    resolve: path.resolve, blackboxDir: path.join(root, 'back-end/src/tests/blackbox'),
    Buffer, URL, randomUUID: () => 'fixture', caseConcurrency: 30, runId: 'fixture', timeoutMs: 900000,
    abortScheduling: false, rerunFailed: true, priorityDomainNames: new Set(),
    reportGateProgress() {}, reportVisibleGateProgress() {}, failureDetail: x => x, failureLines: () => '',
    process: { execPath: process.execPath, env: {}, stdout: { write() {} } },
    setTimeout(fn, ms) { budgets.push(ms); timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    spawn() {
      const scenario = scenarios.shift();
      assert.ok(scenario, 'no extra native attempt');
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      queueMicrotask(() => {
        // Model interruption AFTER the domain emitted its terminal output.
        child.stdout.emit('data', Buffer.from('terminal completion already serialized\n'));
        if (scenario === 'timeout') [...timers.values()][0]();
        else if (scenario === 'spawn-error') child.emit('error', new Error('spawn failed'));
        else child.emit('close', scenario === 'signal' ? null : 1, scenario === 'signal' ? 'SIGKILL' : null);
      });
      return child;
    },
  };
  vm.runInNewContext(code, context);
  const row = await (retried ? context.native.runScheduledDomain('claude-code', 0) : context.native.runDomain('claude-code', 0));
  assert.ok(budgets.every(value => value === 900000), 'original domain budget unchanged');
  return JSON.parse(JSON.stringify(context.native.serialize([row])[0]));
}
(async () => {
  for (const [scenario, expected] of [
    ['exit', { kind: 'exited', code: 1, signal: null }],
    ['signal', { kind: 'exited', code: null, signal: 'SIGKILL' }],
    ['timeout', { kind: 'timeout', code: null, signal: null }],
    ['spawn-error', { kind: 'spawn-error', code: null, signal: null }],
  ]) {
    const row = await execute([scenario]);
    assert.deepEqual(row.terminations, [expected]);
    assert.equal(row.passed, false);
  }
  const row = await execute(['exit', 'signal'], true);
  assert.equal(row.attempts, 2);
  assert.deepEqual(row.terminations, [{ kind: 'exited', code: 1, signal: null }, { kind: 'exited', code: null, signal: 'SIGKILL' }]);
  assert.equal(row.flaky, false);
  console.log('PASS native domain termination producer: exit/signal/timeout/spawn-error and both attempts retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
