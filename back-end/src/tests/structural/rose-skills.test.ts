/**
 * Structural test: every Rose skill (src/assets/rose-skills/<name>/, C17) is a
 * valid Agent Skill whose commands exist, for both account groups.
 *
 *   for roseDesktop in [false, true]:
 *     installedRoseSkills(roseDesktop)
 *       ├─ SKILL.md frontmatter: name = folder, one-line description < 160 chars ("Use ...")
 *       ├─ rose-desktop marker blocks balanced; stock text has no Rose Desktop terms
 *       ├─ every `rose|rose-ui|rose-agents|rose-preview <command> --flag` in any .md
 *       │    exists in that CLI's real --help output for the group
 *       └─ every "<name> skill" reference names a skill installed in the same group
 *   stock set = STOCK_ROSE_SKILLS; Rose Desktop set = every folder
 *   e2b-templates/claude-code/CLAUDE.md carries exactly the stock table of contents
 *
 * New skill folders (e.g. L-ENVSIZE's change-environment-size) are checked
 * automatically. Run: npx tsx src/tests/structural/rose-skills.test.ts
 */
import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { AGENT_GRAPH_CLI_SCRIPT } from '../../providers/agentGraph/cli';
import {
  ROSE_DESKTOP_BLOCK_END,
  ROSE_DESKTOP_BLOCK_START,
  ROSE_SKILL_FILE,
  STOCK_ROSE_SKILLS,
  installedRoseSkills,
  parseRoseSkillFrontmatter,
  roseSkillSourceNames,
  roseSkillsAssetsDir,
  roseSkillsTableOfContents,
  type RoseSkill,
} from '../../providers/roseSkills/skills';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(srcDir, '../..');
const MAX_DESCRIPTION = 160;
/** Terms of the Rose Desktop UI that a stock account's skills must not mention. */
const ROSE_DESKTOP_TERMS = [
  '--pinned',
  '--inline-view',
  'inline_view',
  'pinned question',
  'rose-ui',
  'rose-preview',
  'rose_user_ui',
];
const CLIS = ['rose', 'rose-ui', 'rose-agents', 'rose-preview'] as const;
type Cli = (typeof CLIS)[number];

let failures = 0;
let checks = 0;
function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), 'rose-skills-structural-'));

function run(file: string, args: string[], env: Record<string, string>): string {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: scratch,
      ROSE_TOOLS_CONFIG: path.join(scratch, 'none.json'),
      ...env,
    },
    timeout: 30_000,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** The real usage text of each CLI, as a session of the group sees it. */
function cliHelp(roseDesktop: boolean): Record<Cli, string> {
  const agentsCli = path.join(scratch, 'rose-agents.cjs');
  writeFileSync(agentsCli, AGENT_GRAPH_CLI_SCRIPT);
  return {
    rose: run(path.join(srcDir, 'assets/rose-tools/rose.mjs'), ['--help'], {
      ROSE_TOOLS_ROSE_DESKTOP: roseDesktop ? '1' : '0',
    }),
    'rose-ui': run(path.join(srcDir, 'assets/user-ui/bin/rose-ui.cjs'), ['--help'], {}),
    'rose-agents': run(agentsCli, [], {}),
    'rose-preview': run(
      path.join(srcDir, 'assets/code-preview/bin/rose-preview.cjs'),
      ['--help'],
      {}
    ),
  };
}

/** Command snippets: inline `code` spans and indented code-block lines. */
function commandSnippets(markdown: string): string[] {
  const snippets = [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string);
  for (const line of markdown.split('\n')) {
    if (/^ {4}\S/.test(line)) snippets.push(line.trim());
  }
  return snippets;
}

/** `cli subcommand` pairs and the --flags that follow in the same snippet. */
function commandsIn(snippet: string): { cli: Cli; sub: string; flags: string[] }[] {
  const found: { cli: Cli; sub: string; flags: string[] }[] = [];
  const re = /(?:^|[\s(])(rose-ui|rose-agents|rose-preview|rose)\s+([a-z][a-z-]*)([^|;]*)/g;
  for (const match of snippet.matchAll(re)) {
    const cli = match[1] as Cli;
    const sub = match[2] as string;
    const flags = [...(match[3] ?? '').matchAll(/(?:^|[\s[])(--[a-z][a-z-]*)/g)].map(
      (flag) => flag[1] as string
    );
    found.push({ cli, sub, flags });
  }
  return found;
}

function markdownFiles(skill: RoseSkill): { path: string; text: string }[] {
  return skill.files
    .filter((file) => file.path.endsWith('.md'))
    .map((file) => ({ path: file.path, text: file.content.toString('utf8') }));
}

const allNames = roseSkillSourceNames();
check('the stock skills exist as folders', () => {
  for (const name of STOCK_ROSE_SKILLS) {
    assert.ok(allNames.includes(name), `missing stock skill folder ${name}`);
  }
});

for (const name of allNames) {
  check(`${name}: source markers are balanced and frontmatter is valid`, () => {
    const raw = readFileSync(path.join(roseSkillsAssetsDir(), name, ROSE_SKILL_FILE), 'utf8');
    const starts = raw.split('\n').filter((line) => line.trim() === ROSE_DESKTOP_BLOCK_START);
    const ends = raw.split('\n').filter((line) => line.trim() === ROSE_DESKTOP_BLOCK_END);
    assert.equal(starts.length, ends.length, 'unbalanced rose-desktop markers');
    const head = raw.split('\n---')[0] ?? '';
    assert.ok(!head.includes(ROSE_DESKTOP_BLOCK_START), 'markers inside the frontmatter');
    const { name: declared } = parseRoseSkillFrontmatter(raw);
    assert.equal(declared, name, 'frontmatter name must equal the folder name');
  });
}

for (const roseDesktop of [false, true]) {
  const group = roseDesktop ? 'Rose Desktop' : 'stock';
  const skills = installedRoseSkills(roseDesktop);
  const names = skills.map((skill) => skill.name);
  const help = cliHelp(roseDesktop);

  check(`${group}: installed set`, () => {
    const expected = roseDesktop
      ? allNames
      : allNames.filter((name) => STOCK_ROSE_SKILLS.includes(name));
    assert.deepEqual(names, expected);
    assert.deepEqual([...names].sort(), names, 'installed skills are sorted');
  });

  check(`${group}: table of contents lists exactly the installed skills`, () => {
    const toc = roseSkillsTableOfContents(skills);
    assert.equal(toc.length, skills.length + 1);
    assert.match(toc[0] ?? '', /^Rose skills \(read ~\/\.rose\/skills\/<name>\/SKILL\.md/);
    assert.deepEqual(
      toc.slice(1).map((line) => /^- ([a-z0-9-]+): /.exec(line)?.[1]),
      names
    );
  });

  for (const skill of skills) {
    check(`${group} ${skill.name}: description`, () => {
      const { description } = skill;
      assert.ok(description.length < MAX_DESCRIPTION, `${description.length} chars`);
      assert.ok(!description.includes('\n'), 'one line');
      assert.match(description, /^Use /, 'says when to use it');
    });

    check(`${group} ${skill.name}: rendered text has no markers`, () => {
      for (const file of markdownFiles(skill)) {
        assert.ok(!file.text.includes('<!-- rose-desktop'), `${file.path} still has a marker`);
        assert.ok(!file.text.includes('<!-- /rose-desktop'), `${file.path} still has a marker`);
      }
    });

    if (!roseDesktop) {
      check(`stock ${skill.name}: no Rose Desktop terms`, () => {
        for (const file of markdownFiles(skill)) {
          for (const term of ROSE_DESKTOP_TERMS) {
            assert.ok(!file.text.includes(term), `${file.path} mentions ${term}`);
          }
        }
      });
    }

    check(`${group} ${skill.name}: every named command exists in the CLI help`, () => {
      for (const file of markdownFiles(skill)) {
        for (const snippet of commandSnippets(file.text)) {
          for (const { cli, sub, flags } of commandsIn(snippet)) {
            const usage = help[cli];
            assert.ok(
              new RegExp(`(^|\\s)(${cli}\\s+)?${sub}(\\s|$|\\[)`, 'm').test(usage),
              `${file.path}: "${cli} ${sub}" is not in \`${cli}\` help:\n${usage}`
            );
            for (const flag of flags) {
              assert.ok(
                usage.includes(flag),
                `${file.path}: ${cli} ${sub} ${flag} is not in \`${cli}\` help`
              );
            }
          }
        }
      }
    });

    check(`${group} ${skill.name}: referenced skills are installed`, () => {
      for (const file of markdownFiles(skill)) {
        for (const match of file.text.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)+) skill\b/g)) {
          const ref = match[1] as string;
          if (!allNames.includes(ref)) continue;
          assert.ok(names.includes(ref), `${file.path} refers to the ${ref} skill (not installed)`);
        }
        for (const match of file.text.matchAll(/~\/\.rose\/skills\/([a-z0-9-]+)\/([^\s`),;]+)/g)) {
          const [ref, rel] = [match[1] as string, (match[2] as string).replace(/[.:]$/, '')];
          if (ref === '<name>') continue;
          assert.ok(
            names.includes(ref),
            `${file.path} points into the ${ref} skill (not installed)`
          );
          const target = installedRoseSkills(roseDesktop).find((s) => s.name === ref);
          const exists = target?.files.some(
            (f) => f.path === rel || f.path.startsWith(`${rel.replace(/\/$/, '')}/`)
          );
          assert.ok(
            exists,
            `${file.path} points at ~/.rose/skills/${ref}/${rel}, which is not shipped`
          );
        }
      }
    });
  }
}

check('template CLAUDE.md carries exactly the stock table of contents', () => {
  const template = readFileSync(path.join(repoRoot, 'e2b-templates/claude-code/CLAUDE.md'), 'utf8');
  const stockToc = roseSkillsTableOfContents(installedRoseSkills(false)).join('\n');
  assert.ok(
    template.includes(`\n${stockToc}\n`),
    'template is missing the stock table of contents'
  );
  const listed = [...template.matchAll(/^- ([a-z0-9-]+): Use /gm)].map((match) => match[1]);
  assert.deepEqual(
    listed,
    installedRoseSkills(false).map((skill) => skill.name)
  );
});

check('the CLI help probes ran', () => {
  const help = cliHelp(false);
  for (const cli of CLIS) assert.match(help[cli], /usage/i, `${cli} printed no usage`);
  assert.ok(execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).startsWith('v'));
});

rmSync(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.error(`rose-skills: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
process.stdout.write(
  `rose-skills: ${checks} checks passed (${allNames.length} skills: ${allNames.join(', ')})\n`
);
