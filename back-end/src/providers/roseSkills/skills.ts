/**
 * Rose skills: the code-agent instructions for Rose's own tools, as Agent
 * Skills folders, so they work the same in every harness.
 *
 *   src/assets/rose-skills/<name>/SKILL.md (+ files)     source of truth
 *     └─ installedRoseSkills(roseDesktop)                the flag picks the set
 *          ├─ roseSkillsTableOfContents(skills)  ──► code-agent prompt (Claude, Codex, Mac)
 *          └─ roseSkillWorkspaceFiles(skills)    ──► ~/.rose/skills/<name>/    (canonical)
 *                                                    ~/.claude/skills/<name>/  (Claude Code)
 *                                                    ~/.agents/skills/<name>/  (Codex)
 *
 * SKILL.md frontmatter carries `name` (= folder name) and `description` (one
 * line: when to use it). Lines between `<!-- rose-desktop -->` and
 * `<!-- /rose-desktop -->` are kept for Rose Desktop accounts and dropped for
 * every other account; the marker lines themselves never ship.
 *
 * Every other account gets STOCK_ROSE_SKILLS only; Rose Desktop accounts get
 * every folder under assets/rose-skills (new folders join automatically).
 * Skill text is agent-facing (prompt-scoped, CLAUDE.md rule 26): changes need
 * fresh approval.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export const ROSE_SKILLS_HOME_DIR = '.rose/skills';
/** Harness-native skill folders under the session HOME (Claude Code, Codex). */
export const ROSE_SKILL_HARNESS_DIRS = ['.claude/skills', '.agents/skills'] as const;
/** The skills every account gets; Rose Desktop accounts get all of them. */
export const STOCK_ROSE_SKILLS: readonly string[] = ['agent-graph', 'code-session', 'talk-to-user'];
export const ROSE_SKILL_FILE = 'SKILL.md';
export const ROSE_DESKTOP_BLOCK_START = '<!-- rose-desktop -->';
export const ROSE_DESKTOP_BLOCK_END = '<!-- /rose-desktop -->';
export const ROSE_SKILLS_TOC_HEADER = `Rose skills (read ~/${ROSE_SKILLS_HOME_DIR}/<name>/${ROSE_SKILL_FILE} before using one):`;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 64;

export interface RoseSkillFile {
  /** Relative to the skill folder, `/`-separated. */
  path: string;
  content: Buffer;
}

export interface RoseSkill {
  name: string;
  description: string;
  files: RoseSkillFile[];
}

export interface RoseSkillFrontmatter {
  name: string;
  description: string;
}

/** dist/assets/rose-skills when compiled, src/assets/rose-skills under tsx. */
export function roseSkillsAssetsDir(): string {
  const candidates = [
    resolve(__dirname, '../../assets/rose-skills'),
    resolve(__dirname, '../../../src/assets/rose-skills'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`rose-skills assets not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** Every skill folder that has a SKILL.md, sorted by name. */
export function roseSkillSourceNames(root: string = roseSkillsAssetsDir()): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ROSE_SKILL_FILE)))
    .map((entry) => entry.name)
    .sort();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The `name` / `description` frontmatter of a SKILL.md (a `---` block at the
 * top with one `key: value` per line). Throws on a missing block or field.
 */
export function parseRoseSkillFrontmatter(markdown: string): RoseSkillFrontmatter {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---')
    throw new Error('SKILL.md must start with a --- frontmatter block');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed with ---');
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0 || /^\s/.test(line)) {
      throw new Error(`SKILL.md frontmatter line is not "key: value": ${line}`);
    }
    fields.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1)));
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    throw new Error(`SKILL.md name must match ${NAME_RE.source} (<= ${MAX_NAME_LEN}): "${name}"`);
  }
  if (description === '') throw new Error(`SKILL.md for ${name} has no description`);
  return { name, description };
}

/** Keep (Rose Desktop) or drop (every other account) the marked blocks. */
export function renderRoseSkillMarkdown(markdown: string, roseDesktop: boolean): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of markdown.split('\n')) {
    const marker = line.trim();
    if (marker === ROSE_DESKTOP_BLOCK_START) {
      if (inBlock) throw new Error('nested rose-desktop block');
      inBlock = true;
      continue;
    }
    if (marker === ROSE_DESKTOP_BLOCK_END) {
      if (!inBlock) throw new Error('rose-desktop block end without a start');
      inBlock = false;
      continue;
    }
    if (inBlock && !roseDesktop) continue;
    out.push(line);
  }
  if (inBlock) throw new Error('unclosed rose-desktop block');
  return out.join('\n');
}

function skillFiles(dir: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) skillFiles(dir, path, out);
    else if (entry.isFile()) out.push(path);
  }
}

/** One skill folder, rendered for the account group. */
export function loadRoseSkill(
  name: string,
  roseDesktop: boolean,
  root: string = roseSkillsAssetsDir()
): RoseSkill {
  const dir = join(root, name);
  const paths: string[] = [];
  skillFiles(dir, '', paths);
  const files = paths.map((path) => {
    const raw = readFileSync(join(dir, path));
    if (path !== ROSE_SKILL_FILE) return { path, content: raw };
    return {
      path,
      content: Buffer.from(renderRoseSkillMarkdown(raw.toString('utf8'), roseDesktop), 'utf8'),
    };
  });
  const skillMd = files.find((file) => file.path === ROSE_SKILL_FILE);
  if (!skillMd) throw new Error(`rose skill ${name} has no ${ROSE_SKILL_FILE}`);
  const { name: declared, description } = parseRoseSkillFrontmatter(
    skillMd.content.toString('utf8')
  );
  if (declared !== name) {
    throw new Error(`rose skill folder ${name} declares name "${declared}"`);
  }
  return { name, description, files };
}

/** The skill names an account group gets, sorted. */
export function installedRoseSkillNames(
  roseDesktop: boolean,
  root: string = roseSkillsAssetsDir()
): string[] {
  const available = roseSkillSourceNames(root);
  if (roseDesktop) return available;
  return available.filter((name) => STOCK_ROSE_SKILLS.includes(name));
}

const cache = new Map<boolean, readonly RoseSkill[]>();

/** The rendered skills for an account group (assets are immutable per process). */
export function installedRoseSkills(roseDesktop: boolean): readonly RoseSkill[] {
  let skills = cache.get(roseDesktop);
  if (!skills) {
    skills = installedRoseSkillNames(roseDesktop).map((name) => loadRoseSkill(name, roseDesktop));
    cache.set(roseDesktop, skills);
  }
  return skills;
}

/** Prompt lines: the header plus one `- <name>: <description>` line per skill. */
export function roseSkillsTableOfContents(skills: readonly RoseSkill[]): string[] {
  if (skills.length === 0) return [];
  return [
    ROSE_SKILLS_TOC_HEADER,
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ];
}

/** Every skill under ~/.rose/skills plus the harness-native mirrors, HOME-relative. */
export function roseSkillWorkspaceFiles(
  skills: readonly RoseSkill[]
): { path: string; content: Buffer }[] {
  const roots = [ROSE_SKILLS_HOME_DIR, ...ROSE_SKILL_HARNESS_DIRS];
  return roots.flatMap((base) =>
    skills.flatMap((skill) =>
      skill.files.map((file) => ({
        path: `${base}/${skill.name}/${file.path}`,
        content: file.content,
      }))
    )
  );
}

/** True for a HOME-relative path inside a Rose skill folder (any mirror). */
export function isRoseSkillWorkspacePath(path: string): boolean {
  return [ROSE_SKILLS_HOME_DIR, ...ROSE_SKILL_HARNESS_DIRS].some((base) =>
    path.startsWith(`${base}/`)
  );
}
