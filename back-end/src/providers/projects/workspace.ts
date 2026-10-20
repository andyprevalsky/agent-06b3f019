/**
 * Materialize a Project into a code session and run its startup script.
 *
 *   createClaudeCodeSession / W5 resume
 *     ├─ prepareProjectWorkspace(userId, projectId)   decrypt (memory only)
 *     ├─ registerWorkspaceExecutor(sessionId, local | e2b executor)
 *     ├─ restoreWorkspace(sessionId, workspace)
 *     │    ~/workspace            clone repoUrl (or the synced bundle), checkout defaultBranch
 *     │    rose-sync/<branch>     unpushed local commits from the synced bundle
 *     │    git stash              uncommitted work from the synced patch (+ patch file)
 *     │    env/config files       0600; external links → ~/.rose/project/files/<path> + symlink
 *     │    ~/.rose/bin/rose-project-startup + ~/.rose/project/startup.{json,sh}
 *     └─ runProjectStartup(sessionId)   (ws-server.mjs runs the same runner on every boot)
 *
 * Secrets: decrypted content is written only into the session (0600) and is
 * redacted from every report; nothing here logs file content or clone URLs.
 *
 * 10k-agent behaviour: all work is per session (its own directory/sandbox);
 * the executor registry holds one entry per live session in this process.
 */
import { createLogger } from '../logger';
import { normalizeProjectPath } from './paths';
import { STARTUP_RUNNER_SCRIPT } from './startupRunner';
import { findSessionProject, prepareProjectWorkspace } from './store';
import type { ProjectRestoreReport, ProjectStartupReport, ProjectWorkspace } from './types';
import {
  localWorkspaceExecutor,
  registerWorkspaceExecutor,
  shq,
  workspaceExecutorFor,
  type WorkspaceExecutor,
} from './workspaceExecutor';

export {
  e2bWorkspaceExecutor,
  localWorkspaceExecutor,
  registerWorkspaceExecutor,
  unregisterWorkspaceExecutor,
  workspaceExecutorFor,
  type WorkspaceExecutor,
} from './workspaceExecutor';

const log = createLogger('ProjectWorkspace');

export const PROJECT_REPO_DIRNAME = 'workspace';
const ROSE_DIR = '.rose';
const PROJECT_DIR = `${ROSE_DIR}/project`;
export const STARTUP_RUNNER_REL = `${ROSE_DIR}/bin/rose-project-startup`;
const GIT_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const GIT_IDENTITY = '-c user.name="Rose Agent" -c user.email=agent@roselabs.ai';

export interface ProjectSessionPaths {
  homeDir: string;
  repoDir: string;
  projectDir: string;
  runnerPath: string;
  configPath: string;
  reportPath: string;
  logPath: string;
}

export function projectSessionPaths(homeDir: string): ProjectSessionPaths {
  const home = homeDir.replace(/\/+$/, '');
  return {
    homeDir: home,
    repoDir: `${home}/${PROJECT_REPO_DIRNAME}`,
    projectDir: `${home}/${PROJECT_DIR}`,
    runnerPath: `${home}/${STARTUP_RUNNER_REL}`,
    configPath: `${home}/${PROJECT_DIR}/startup.json`,
    reportPath: `${home}/${PROJECT_DIR}/startup-report.json`,
    logPath: `${home}/${PROJECT_DIR}/startup.log`,
  };
}

/** Env for ws-server.mjs: use the restored repo and run startup before the CLI. */
export function projectSessionEnv(paths: ProjectSessionPaths, projectName: string) {
  return {
    ROSE_PROJECT_WORKDIR: paths.repoDir,
    ROSE_PROJECT_STARTUP: paths.runnerPath,
    ROSE_PROJECT_STARTUP_CONFIG: paths.configPath,
    ROSE_PROJECT_NAME: projectName,
  };
}

function redactor(values: string[]): (text: string) => string {
  const sorted = [...new Set(values.filter((v) => v.length >= 6))].sort(
    (a, b) => b.length - a.length
  );
  return (text) => sorted.reduce((out, value) => out.split(value).join('[REDACTED]'), text);
}

function tokenOf(url: string | null | undefined): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    return [parsed.password, parsed.username].filter((v) => v.length >= 6);
  } catch {
    return [];
  }
}

interface RestoreContext {
  ex: WorkspaceExecutor;
  ws: ProjectWorkspace;
  paths: ProjectSessionPaths;
  report: ProjectRestoreReport;
  redact: (text: string) => string;
}

async function git(ctx: RestoreContext, args: string, timeoutMs = SHORT_TIMEOUT_MS) {
  const out = await ctx.ex.run(`git ${GIT_IDENTITY} ${args}`, {
    cwd: ctx.paths.repoDir,
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  return { ...out, stderr: ctx.redact(out.stderr).slice(-2000) };
}

async function writePrivate(ctx: RestoreContext, rel: string, content: Buffer, mode = 0o600) {
  return ctx.ex.writeFileInside(ctx.paths.homeDir, rel, content, mode);
}

async function repoExists(ctx: RestoreContext): Promise<boolean> {
  const out = await ctx.ex.run(`test -d ${shq(`${ctx.paths.repoDir}/.git`)}`, {
    timeoutMs: SHORT_TIMEOUT_MS,
  });
  return out.exitCode === 0;
}

async function cloneInto(ctx: RestoreContext, source: string, label: 'remote' | 'bundle') {
  const out = await ctx.ex.run(`git clone --quiet ${shq(source)} ${shq(ctx.paths.repoDir)}`, {
    cwd: ctx.paths.homeDir,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (out.exitCode !== 0) {
    ctx.report.checkout.error = `git clone (${label}) failed: ${ctx.redact(out.stderr).slice(-1000)}`;
    return false;
  }
  ctx.report.checkout.cloned = true;
  ctx.report.checkout.source = label;
  return true;
}

async function checkoutBranch(ctx: RestoreContext, branch: string): Promise<boolean> {
  const local = await git(ctx, `checkout --quiet ${shq(branch)}`);
  if (local.exitCode === 0) return true;
  const tracking = await git(ctx, `checkout --quiet -B ${shq(branch)} ${shq(`origin/${branch}`)}`);
  return tracking.exitCode === 0;
}

async function writeBundle(ctx: RestoreContext): Promise<string | null> {
  if (!ctx.ws.gitBundle) return null;
  return writePrivate(ctx, `${PROJECT_DIR}/repo-r${ctx.ws.revision}.bundle`, ctx.ws.gitBundle);
}

async function restoreCheckout(ctx: RestoreContext, bundlePath: string | null): Promise<void> {
  const { ws, report } = ctx;
  if (await repoExists(ctx)) {
    report.warnings.push('Workspace already present; kept the existing checkout');
  } else if (ws.cloneUrl || ws.project.repoUrl) {
    await cloneInto(ctx, ws.cloneUrl ?? ws.project.repoUrl!, 'remote');
  }
  if (!report.checkout.cloned && !(await repoExists(ctx))) {
    const fullBundle = bundlePath !== null && ws.manifest?.git?.bundleKind === 'full';
    if (!(fullBundle && (await cloneInto(ctx, bundlePath, 'bundle')))) {
      const init = await ctx.ex.run(
        `git init --quiet -b ${shq(ws.project.defaultBranch)} ${shq(ctx.paths.repoDir)}`,
        { cwd: ctx.paths.homeDir, timeoutMs: SHORT_TIMEOUT_MS }
      );
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.slice(-500)}`);
      report.checkout.source = 'empty';
    }
  }
  const branch = ws.project.defaultBranch;
  if (report.checkout.source !== 'empty' && !(await checkoutBranch(ctx, branch))) {
    report.warnings.push(`Default branch ${branch} not found; kept the cloned HEAD`);
  }
  const head = await git(ctx, 'rev-parse HEAD');
  const current = await git(ctx, 'symbolic-ref --short -q HEAD');
  report.checkout.headSha = head.exitCode === 0 ? head.stdout.trim() : null;
  report.checkout.branch = current.exitCode === 0 ? current.stdout.trim() : null;
}

async function restoreLocalCommits(ctx: RestoreContext, bundlePath: string | null): Promise<void> {
  if (bundlePath === null || ctx.report.checkout.source === 'empty') return;
  const fetch = await git(
    ctx,
    `fetch --quiet ${shq(bundlePath)} ${shq('+refs/heads/*:refs/heads/rose-sync/*')}`,
    GIT_TIMEOUT_MS
  );
  if (fetch.exitCode !== 0) {
    ctx.report.warnings.push(`Synced local commits could not be restored: ${fetch.stderr}`);
    return;
  }
  const refs = await git(ctx, "for-each-ref --format='%(refname:short)' refs/heads/rose-sync/");
  ctx.report.localWork.branches = refs.stdout.split('\n').filter(Boolean);
}

async function restoreUncommitted(ctx: RestoreContext): Promise<void> {
  const { ws, report } = ctx;
  if (!ws.uncommittedPatch || ws.uncommittedPatch.length === 0) return;
  const patchRel = `${PROJECT_DIR}/uncommitted-r${ws.revision}.patch`;
  report.localWork.patchPath = await writePrivate(ctx, patchRel, ws.uncommittedPatch);
  const base = ws.manifest?.git?.headSha;
  if (!base || report.checkout.source === 'empty') {
    report.warnings.push('Uncommitted work saved as a patch file only (no base commit)');
    return;
  }
  const tmp = `${ctx.paths.projectDir}/stash-worktree`;
  const message = `rose-sync uncommitted (r${ws.revision}, ${ws.manifest?.git?.branch ?? 'detached'})`;
  const steps = [
    `worktree add --quiet --detach ${shq(tmp)} ${shq(base)}`,
    `-C ${shq(tmp)} apply --index --binary ${shq(report.localWork.patchPath)}`,
    `-C ${shq(tmp)} stash push --quiet --include-untracked -m ${shq(message)}`,
  ];
  let failed: string | null = null;
  for (const step of steps) {
    const out = await git(ctx, step);
    if (out.exitCode !== 0) {
      failed = out.stderr;
      break;
    }
  }
  await git(ctx, `worktree remove --force ${shq(tmp)}`);
  if (failed !== null) {
    report.warnings.push(`Uncommitted work kept as a patch file only: ${failed.slice(-500)}`);
    return;
  }
  const stash = await git(ctx, "stash list --format='%gd %gs' -n 1");
  report.localWork.stash = stash.stdout.trim() || null;
}

async function writeProjectFiles(ctx: RestoreContext): Promise<string[]> {
  const written: string[] = [];
  for (const file of ctx.ws.files) {
    const rel = normalizeProjectPath(file.path);
    if (rel === null) {
      ctx.report.warnings.push(`Skipped unsafe file path ${file.path.slice(0, 200)}`);
      continue;
    }
    if (file.linkTarget) {
      const stored = await writePrivate(ctx, `${PROJECT_DIR}/files/${rel}`, file.content);
      const link = `${ctx.paths.repoDir}/${rel}`;
      const out = await ctx.ex.run(
        `mkdir -p "$(dirname ${shq(link)})" && ln -sfn ${shq(stored)} ${shq(link)}`,
        { timeoutMs: SHORT_TIMEOUT_MS }
      );
      if (out.exitCode !== 0) {
        ctx.report.warnings.push(`Could not link ${rel}: ${out.stderr.slice(-300)}`);
        continue;
      }
      ctx.report.symlinks.push({ path: rel, target: stored });
      written.push(stored);
    } else {
      written.push(await ctx.ex.writeFileInside(ctx.paths.repoDir, rel, file.content, 0o600));
    }
    ctx.report.filesWritten.push(rel);
  }
  return written;
}

async function restoreInternalLinks(ctx: RestoreContext): Promise<void> {
  for (const link of ctx.ws.manifest?.symlinks ?? []) {
    if (link.kind !== 'internal') continue;
    const rel = normalizeProjectPath(link.path);
    if (rel === null || link.target.startsWith('/')) continue;
    const dest = `${ctx.paths.repoDir}/${rel}`;
    const out = await ctx.ex.run(
      `[ -e ${shq(dest)} ] || [ -L ${shq(dest)} ] || { mkdir -p "$(dirname ${shq(dest)})" && ln -s ${shq(link.target)} ${shq(dest)}; }`,
      { timeoutMs: SHORT_TIMEOUT_MS }
    );
    if (out.exitCode === 0) ctx.report.symlinks.push({ path: rel, target: link.target });
  }
}

async function toolchainWarnings(ctx: RestoreContext): Promise<void> {
  const want = ctx.ws.manifest?.toolchain?.node;
  if (!want) return;
  const have = await ctx.ex.run('node --version', { timeoutMs: SHORT_TIMEOUT_MS });
  const major = (v: string) => v.replace(/^v/, '').split('.')[0];
  if (have.exitCode !== 0 || major(have.stdout.trim()) !== major(want)) {
    ctx.report.warnings.push(
      `Project expects Node ${want}; session has ${have.stdout.trim() || 'no node'}`
    );
  }
}

function startupScriptOf(ws: ProjectWorkspace): string | null {
  const script = ws.project.startupScript?.trim();
  if (script) return ws.project.startupScript!;
  const commands = ws.manifest?.setup?.commands ?? [];
  return commands.length > 0 ? `set -e\n${commands.join('\n')}\n` : null;
}

async function writeStartup(ctx: RestoreContext, envPaths: string[]): Promise<void> {
  const script = startupScriptOf(ctx.ws);
  const scriptPath = script
    ? await writePrivate(ctx, `${PROJECT_DIR}/startup.sh`, Buffer.from(script, 'utf8'), 0o700)
    : null;
  await writePrivate(ctx, STARTUP_RUNNER_REL, Buffer.from(STARTUP_RUNNER_SCRIPT, 'utf8'), 0o755);
  const config = {
    projectId: ctx.ws.project.id,
    projectName: ctx.ws.project.name,
    repoDir: ctx.paths.repoDir,
    timeoutS: ctx.ws.project.startupTimeoutS,
    scriptPath,
    logPath: ctx.paths.logPath,
    reportPath: ctx.paths.reportPath,
    envFiles: envPaths,
    extraRedactions: tokenOf(ctx.ws.cloneUrl),
  };
  await writePrivate(
    ctx,
    `${PROJECT_DIR}/startup.json`,
    Buffer.from(JSON.stringify(config), 'utf8')
  );
}

/**
 * Materialize `workspace` into the session registered as `sessionId`.
 * Idempotent: an existing checkout is kept, files are rewritten.
 */
export async function restoreWorkspace(
  sessionId: string,
  workspace: ProjectWorkspace
): Promise<ProjectRestoreReport> {
  const ex = workspaceExecutorFor(sessionId);
  if (!ex) throw new Error(`No workspace executor registered for session ${sessionId}`);
  const paths = projectSessionPaths(ex.homeDir);
  const report: ProjectRestoreReport = {
    projectId: workspace.project.id,
    projectName: workspace.project.name,
    revision: workspace.revision,
    repoDir: paths.repoDir,
    checkout: { branch: null, headSha: null, cloned: false, source: 'remote' },
    localWork: { stash: null, branches: [], patchPath: null },
    filesWritten: [],
    symlinks: [],
    warnings: [...(workspace.manifest?.warnings ?? [])],
  };
  const ctx: RestoreContext = {
    ex,
    ws: workspace,
    paths,
    report,
    redact: redactor([...workspace.redactions, ...tokenOf(workspace.cloneUrl)]),
  };
  const mk = await ex.run(
    `mkdir -p ${shq(`${paths.projectDir}/files`)} && chmod 700 ${shq(paths.projectDir)}`,
    {
      timeoutMs: SHORT_TIMEOUT_MS,
    }
  );
  if (mk.exitCode !== 0) throw new Error(`Could not prepare ${paths.projectDir}`);
  const bundlePath = await writeBundle(ctx);
  await restoreCheckout(ctx, bundlePath);
  await restoreLocalCommits(ctx, bundlePath);
  await restoreUncommitted(ctx);
  const written = await writeProjectFiles(ctx);
  await restoreInternalLinks(ctx);
  await toolchainWarnings(ctx);
  await writeStartup(ctx, written);
  log.info('Restored project workspace', {
    sessionId,
    projectId: workspace.project.id,
    revision: workspace.revision,
    source: report.checkout.source,
    files: report.filesWritten.length,
    warnings: report.warnings.length,
  });
  return report;
}

function parseReport(text: string): ProjectStartupReport | null {
  try {
    const parsed = JSON.parse(text) as ProjectStartupReport;
    return typeof parsed.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run the restored project's startup script in the session and return its
 * report. Never hangs: the runner enforces the project timeout, and this call
 * adds a 30 s grace on top of it.
 */
export async function runProjectStartup(sessionId: string): Promise<ProjectStartupReport> {
  const ex = workspaceExecutorFor(sessionId);
  if (!ex) throw new Error(`No workspace executor registered for session ${sessionId}`);
  const paths = projectSessionPaths(ex.homeDir);
  const config = await ex.run(`cat ${shq(paths.configPath)}`, { timeoutMs: SHORT_TIMEOUT_MS });
  let timeoutS = Number.NaN;
  try {
    timeoutS = Number((JSON.parse(config.stdout) as { timeoutS?: unknown }).timeoutS);
  } catch {
    // missing config → default budget; the runner reports the failure itself
  }
  const budgetMs = ((Number.isFinite(timeoutS) ? timeoutS : 120) + 30) * 1000;
  const run = await ex.run(`node ${shq(paths.runnerPath)} ${shq(paths.configPath)}`, {
    cwd: paths.repoDir,
    timeoutMs: budgetMs,
  });
  const reportText = await ex.run(`cat ${shq(paths.reportPath)}`, { timeoutMs: SHORT_TIMEOUT_MS });
  const report = parseReport(reportText.stdout);
  if (report && !run.timedOut) return report;
  const now = new Date().toISOString();
  return {
    status: run.timedOut ? 'timeout' : 'failed',
    exitCode: run.timedOut ? null : run.exitCode,
    durationMs: budgetMs,
    timeoutS: Number.isFinite(timeoutS) ? timeoutS : 120,
    outputTail: 'startup runner produced no report',
    logPath: paths.logPath,
    startedAt: now,
    finishedAt: now,
  };
}

/** Route helper: re-run startup only for the session's owning project. */
export async function runProjectStartupForOwner(
  sessionId: string,
  userId: string,
  projectId: string
): Promise<ProjectStartupReport | null> {
  const owner = await findSessionProject(sessionId);
  if (!owner || owner.userId !== userId || owner.projectId !== projectId) return null;
  if (!workspaceExecutorFor(sessionId)) return null;
  return runProjectStartup(sessionId);
}

/**
 * Local Claude Code fallback: restore `workspace` into the session HOME and
 * return the ws-server env (no-op without a project).
 */
export async function restoreLocalProject(
  sessionId: string,
  homeDir: string,
  baseEnv: NodeJS.ProcessEnv,
  workspace: ProjectWorkspace | null | undefined
): Promise<{ envs: Record<string, string>; report: ProjectRestoreReport | null }> {
  if (!workspace) return { envs: {}, report: null };
  registerWorkspaceExecutor(sessionId, localWorkspaceExecutor(homeDir, baseEnv));
  const report = await restoreWorkspace(sessionId, workspace);
  return { envs: projectSessionEnv(projectSessionPaths(homeDir), workspace.project.name), report };
}

export { prepareProjectWorkspace };
