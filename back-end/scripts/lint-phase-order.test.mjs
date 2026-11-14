import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { lintInTypeOrder } from './lint-phase-order.mjs';

const calls = [];
const fixture = {
  async calculateConfigForFile(file) {
    return file.startsWith('typed') ? { languageOptions: { parserOptions: { projectService: true } } } : {};
  },
  async lintFiles(files) {
    calls.push([...files]);
    return files.map((filePath) => ({ filePath, errorCount: 1 }));
  },
};
const inputs = ['typed-one', 'plain-one', 'typed-two', 'plain-two'];
const rows = await lintInTypeOrder(fixture, inputs);
assert.deepEqual(calls, [['plain-one', 'plain-two'], ['typed-one', 'typed-two']]);
assert.deepEqual(rows.map((row) => row.filePath).sort(), [...inputs].sort());
assert.equal(rows.length, inputs.length);
assert.equal(rows.filter((row) => row.errorCount).length, inputs.length);

for (const typed of [true, false]) {
  const observed = [];
  await lintInTypeOrder({
    async calculateConfigForFile() { return typed ? {languageOptions:{parserOptions:{project:true}}} : undefined; },
    async lintFiles(files) { assert.ok(files.length > 0); observed.push(files); return []; },
  }, ['one', 'two']);
  assert.deepEqual(observed, [['one', 'two']]);
}
let emptyCalls = 0;
await lintInTypeOrder({async lintFiles() { emptyCalls++; }}, []);
assert.equal(emptyCalls, 0);
const previousSingleRun = process.env.TSESTREE_SINGLE_RUN;
process.env.TSESTREE_SINGLE_RUN = 'false';
await lintInTypeOrder({async calculateConfigForFile(){ return {}; }, async lintFiles(){ assert.equal(process.env.TSESTREE_SINGLE_RUN,'false'); return []; }}, ['one']);
assert.equal(process.env.TSESTREE_SINGLE_RUN, 'false');
if (previousSingleRun === undefined) delete process.env.TSESTREE_SINGLE_RUN;
else process.env.TSESTREE_SINGLE_RUN = previousSingleRun;

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-phase-proof-'));
try {
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(source, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'commonjs',skipLibCheck:true},include:['src/**/*.ts']}));
  fs.mkdirSync(path.join(root, 'src/domains/fixture'), {recursive:true});
  fs.mkdirSync(path.join(root, 'src/tests'), {recursive:true});
  fs.writeFileSync(path.join(root, 'src/domains/fixture/typed.ts'), 'export async function work(): Promise<void> { await Promise.resolve(); }\nwork();\n[1].forEach(async () => { await Promise.resolve(); });\nif (Promise.resolve()) { work(); }\n');
  fs.writeFileSync(path.join(root, 'src/tests/plain.ts'), 'export const unused: any = 1;\n');
  const files = ['src/domains/fixture/typed.ts', 'src/tests/plain.ts'];
  const normalize = (results) => results.map((r) => ({file:path.relative(root,r.filePath),errors:r.errorCount,warnings:r.warningCount,messages:r.messages.map((m)=>({rule:m.ruleId,severity:m.severity,messageId:m.messageId,line:m.line,column:m.column,endLine:m.endLine,endColumn:m.endColumn,message:m.message,suggestions:m.suggestions}))})).sort((a,b)=>a.file.localeCompare(b.file));
  const baseline = normalize(await new ESLint({cwd:root}).lintFiles(files));
  const ordered = normalize(await lintInTypeOrder(new ESLint({cwd:root}), files));
  assert.deepEqual(ordered, baseline);
  const rules = new Set(ordered.flatMap((r)=>r.messages.map((m)=>m.rule)));
  for (const rule of ['@typescript-eslint/no-explicit-any','@typescript-eslint/no-floating-promises','@typescript-eslint/no-misused-promises','@typescript-eslint/strict-boolean-expressions']) assert.ok(rules.has(rule), rule);
  const driver = path.join(source, 'scripts/lint-affected.mjs');
  const invoke = (args, env = process.env) => spawnSync(process.execPath, [driver, ...args], {cwd:root,env,encoding:'utf8'});
  fs.writeFileSync(path.join(root,'src/domains/fixture/typed.ts'), 'const unused = 1;\n');
  fs.writeFileSync(path.join(root,'eslint.config.mjs'), "export default [{files:['**/*.ts'],rules:{'no-unused-vars':'warn'}}];\n");
  const warning = invoke(['src/domains/fixture/typed.ts']);
  assert.equal(warning.status,0,warning.stderr);
  assert.match(warning.stdout,/no-unused-vars/);
  fs.writeFileSync(path.join(root,'eslint.config.mjs'), 'throw new Error("fixture engine failure");\n');
  const failure = invoke(['src/domains/fixture/typed.ts']);
  assert.equal(failure.status,2);
  assert.match(failure.stderr,/fixture engine failure/);
  fs.writeFileSync(path.join(root,'eslint.config.mjs'), "throw new Error('BIG_START' + 'x'.repeat(200000) + 'BIG_END');\n");
  const largeFailure = invoke(['src/domains/fixture/typed.ts']);
  assert.equal(largeFailure.status,2);
  assert.ok(largeFailure.stderr.length > 200000);
  assert.match(largeFailure.stderr,/BIG_END/);
  fs.writeFileSync(path.join(root,'eslint.config.mjs'), "export default [{files:['**/*.ts'],rules:{'no-unused-vars':'error'}}];\n");
  fs.writeFileSync(path.join(root,'src/domains/fixture/typed.ts'), Array.from({length:2000},(_,i)=>`const diagnostic_${i}=1;`).join('\n'));
  const largeOutput = invoke(['src/domains/fixture/typed.ts']);
  assert.equal(largeOutput.status,1);
  assert.equal(largeOutput.stdout.split('is assigned a value but never used').length-1,2000);
  assert.match(largeOutput.stdout,/diagnostic_1999/);

  const printed = invoke(['--print','src/domains/fixture/typed.ts']);
  assert.equal(printed.status,0,printed.stderr);
  assert.equal(printed.stdout,'src/domains/fixture/typed.ts\n');
  const bin = path.join(root,'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'npx'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root,'fix-args.json'))},JSON.stringify(process.argv.slice(2)));process.exit(7);\n`,{mode:0o700});
  const fixed = invoke(['--fix','src/domains/fixture/typed.ts'], {...process.env,PATH:bin+path.delimiter+process.env.PATH});
  assert.equal(fixed.status,7,fixed.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'fix-args.json'),'utf8')),['eslint','--fix','src/domains/fixture/typed.ts']);
  console.log(JSON.stringify({files:inputs.length,phases:calls,diagnosticsIdentical:true,typedRules:[...rules].sort(),warningExit:warning.status,engineExit:failure.status,fixExit:fixed.status,printUnchanged:true}));
} finally { fs.rmSync(root,{recursive:true,force:true}); }
