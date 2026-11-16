/**
 * rose-cli — import service (pure logic; process, fs and IPC injected)
 *
 *   renderer request ─► validateImportRequest (folder is a dir, http(s) API,
 *                       rlc_ login code) ─► buildImportInvocation (main-built argv)
 *     ─► ensure launcher ─► spawn ~/.rose/bin/rose import <action> … --json
 *          cwd = folder, login-shell PATH, apply plan on stdin (`--plan -`),
 *          scan login code in ROSE_LOGIN_CODE (never argv: `ps` shows argv to everyone)
 *     stdout ─► JsonLineParser ─► { ...object, runId } per line (malformed dropped)
 *     close  ─► [generic error if non-zero and no CLI error] ─► { runId, event: 'exit', code }
 *   One run at a time. cancel: SIGTERM the process group, SIGKILL after a grace period.
 */
import path from 'path';
import { getErrorMessage } from '../../../shared/utils/error';
import {
  IMPORT_AGENTS,
  IMPORT_BUSY_ERROR,
  IMPORT_CANCELED_MESSAGE,
  IMPORT_CANCEL_GRACE_MS,
  IMPORT_FAILED_MESSAGE,
  IMPORT_MAX_JSON_CHARS,
  IMPORT_MAX_PROJECT_CHARS,
  IMPORT_MAX_URL_CHARS,
  LOGIN_CODE_ENV,
  LOGIN_CODE_PATTERN,
} from './config';
import type {
  ImportChild,
  ImportInvocation,
  ImportSpawnSpec,
  RoseCliFolderPickResult,
  RoseCliImportEvent,
  RoseCliImportStartResult,
  RoseCliInstallResult,
  ValidImportRequest,
} from './types';

class ImportRequestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function checkFolder(
  raw: unknown,
  isDirectory: (p: string) => Promise<boolean>
): Promise<string> {
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0')) {
    throw new ImportRequestError('Choose a project folder on this Mac.');
  }
  const folder = path.resolve(raw);
  if (!(await isDirectory(folder))) {
    throw new ImportRequestError('That project folder does not exist on this Mac.');
  }
  return folder;
}

function checkApiUrl(raw: unknown): string {
  const invalid = new ImportRequestError('The Rose API address must be an http(s) URL.');
  if (typeof raw !== 'string' || raw.length > IMPORT_MAX_URL_CHARS) throw invalid;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid;
  return raw;
}

function checkLoginCode(raw: unknown): string {
  if (typeof raw !== 'string' || !LOGIN_CODE_PATTERN.test(raw)) {
    throw new ImportRequestError('The Rose sign-in code is invalid. Start the import again.');
  }
  return raw;
}

function optionalProject(raw: unknown): { project?: string } {
  if (raw === undefined || raw === null) return {};
  if (
    typeof raw !== 'string' ||
    raw.trim() === '' ||
    raw.length > IMPORT_MAX_PROJECT_CHARS ||
    hasControlCharacters(raw)
  ) {
    throw new ImportRequestError('The Rose project name is invalid.');
  }
  return { project: raw };
}

function optionalAgent(raw: unknown): { agent?: (typeof IMPORT_AGENTS)[number] } {
  if (raw === undefined || raw === null) return {};
  const agent = IMPORT_AGENTS.find((candidate) => candidate === raw);
  if (agent === undefined) throw new ImportRequestError('Choose Claude Code or Codex.');
  return { agent };
}

function checkPlan(raw: unknown): string {
  const invalid = new ImportRequestError('The import plan is invalid. Scan the folder again.');
  if (typeof raw !== 'object' || raw === null) throw invalid;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    throw invalid;
  }
  if (json.length > IMPORT_MAX_JSON_CHARS) {
    throw new ImportRequestError('The import plan is too large.');
  }
  return json;
}

async function parseRequest(
  raw: unknown,
  isDirectory: (p: string) => Promise<boolean>
): Promise<ValidImportRequest> {
  if (!isRecord(raw)) throw new ImportRequestError('Unsupported import request.');
  if (raw.action === 'detect') return { action: 'detect' };
  if (raw.action === 'scan') {
    return {
      action: 'scan',
      folder: await checkFolder(raw.folder, isDirectory),
      loginCode: checkLoginCode(raw.loginCode),
      apiUrl: checkApiUrl(raw.apiUrl),
      ...optionalProject(raw.project),
      ...optionalAgent(raw.agent),
    };
  }
  if (raw.action === 'apply') {
    if (typeof raw.githubImport !== 'boolean') {
      throw new ImportRequestError('Unsupported import request.');
    }
    return {
      action: 'apply',
      folder: await checkFolder(raw.folder, isDirectory),
      planJson: checkPlan(raw.plan),
      githubImport: raw.githubImport,
      apiUrl: checkApiUrl(raw.apiUrl),
    };
  }
  throw new ImportRequestError('Unsupported import action.');
}

/** A renderer request → a validated request (only known fields survive), or a readable error. */
export async function validateImportRequest(
  raw: unknown,
  isDirectory: (p: string) => Promise<boolean>
): Promise<{ request: ValidImportRequest } | { error: string }> {
  try {
    return { request: await parseRequest(raw, isDirectory) };
  } catch (error) {
    if (error instanceof ImportRequestError) return { error: error.message };
    throw error;
  }
}

/** The exact `rose` argv and run env for a validated request (never renderer-supplied). */
export function buildImportInvocation(request: ValidImportRequest): ImportInvocation {
  if (request.action === 'detect') {
    return { args: ['import', 'detect', '--json'], env: {}, folder: null, stdin: null };
  }
  if (request.action === 'scan') {
    return {
      args: [
        'import',
        'scan',
        '--dir',
        request.folder,
        ...(request.agent === undefined ? [] : ['--agent', request.agent]),
        ...(request.project === undefined ? [] : ['--project', request.project]),
        '--api',
        request.apiUrl,
        '--json',
      ],
      env: { [LOGIN_CODE_ENV]: request.loginCode },
      folder: request.folder,
      stdin: null,
    };
  }
  return {
    args: [
      'import',
      'apply',
      '--dir',
      request.folder,
      '--plan',
      '-',
      ...(request.githubImport ? ['--github-import'] : []),
      '--api',
      request.apiUrl,
      '--json',
    ],
    env: {},
    folder: request.folder,
    stdin: request.planJson,
  };
}

/** The app's env (login-shell PATH) minus any inherited login code, plus this run's env. */
export function importRunEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env[LOGIN_CODE_ENV];
  return { ...env, ...extra };
}

/** Native folder picker result → the renderer shape. */
export function folderPickResult(picked: {
  canceled: boolean;
  filePaths: string[];
}): RoseCliFolderPickResult {
  const [folder] = picked.filePaths;
  if (picked.canceled || folder === undefined || folder === '') return { canceled: true };
  return { canceled: false, path: folder };
}

/** Splits stdout into lines and hands every JSON object line on; anything else is dropped. */
export class JsonLineParser {
  private buffer = '';
  private skipping = false;
  malformed = 0;

  constructor(
    private readonly onObject: (value: Record<string, unknown>) => void,
    private readonly maxLineChars = IMPORT_MAX_JSON_CHARS
  ) {}

  push(chunk: string): void {
    let text = chunk;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer + text.slice(0, newline);
      this.buffer = '';
      if (this.skipping) this.skipping = false;
      else this.handle(line);
      text = text.slice(newline + 1);
      newline = text.indexOf('\n');
    }
    if (this.skipping) return;
    this.buffer += text;
    if (this.buffer.length > this.maxLineChars) {
      // An unbounded line would grow forever: drop it and resume at the next newline.
      this.buffer = '';
      this.skipping = true;
      this.malformed += 1;
    }
  }

  /** The process closed: a last line without a trailing newline still counts. */
  end(): void {
    if (!this.skipping && this.buffer !== '') this.handle(this.buffer);
    this.buffer = '';
    this.skipping = false;
  }

  private handle(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (trimmed.length > this.maxLineChars) {
      this.malformed += 1;
      return;
    }
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) this.onObject(value);
      else this.malformed += 1;
    } catch {
      this.malformed += 1;
    }
  }
}

export interface ImportRunDeps {
  isDirectory: (p: string) => Promise<boolean>;
  ensureLauncher: () => Promise<RoseCliInstallResult>;
  /** The user's login-shell PATH (claude, codex, git, python3 resolve like in Terminal). */
  env: () => NodeJS.ProcessEnv;
  home: () => string;
  spawn: (spec: ImportSpawnSpec) => ImportChild;
  emit: (event: RoseCliImportEvent) => void;
  newRunId: () => string;
  /** Schedule `fn` after `ms`; returns a canceller. */
  setTimer: (fn: () => void, ms: number) => () => void;
}

interface ActiveRun {
  runId: string;
  child: ImportChild;
  sawError: boolean;
  canceled: boolean;
  cancelKillTimer: (() => void) | null;
}

/** At most one `rose import` process at a time; its stdout becomes renderer events. */
export class ImportRunManager {
  private active: ActiveRun | null = null;
  private starting = false;

  constructor(private readonly deps: ImportRunDeps) {}

  async start(raw: unknown): Promise<RoseCliImportStartResult> {
    if (this.active !== null || this.starting) return { error: IMPORT_BUSY_ERROR };
    this.starting = true;
    try {
      const checked = await validateImportRequest(raw, this.deps.isDirectory);
      if ('error' in checked) return checked;
      const launcher = await this.deps.ensureLauncher();
      if (!launcher.success || launcher.path === undefined) {
        return { error: launcher.error ?? 'Could not install the rose CLI.' };
      }
      const invocation = buildImportInvocation(checked.request);
      const runId = this.deps.newRunId();
      const child = this.deps.spawn({
        command: launcher.path,
        args: invocation.args,
        cwd: invocation.folder ?? this.deps.home(),
        env: importRunEnv(this.deps.env(), invocation.env),
        stdin: invocation.stdin,
      });
      this.attach(runId, child);
      return { runId };
    } catch (error) {
      return { error: `Could not start the import: ${getErrorMessage(error)}` };
    } finally {
      this.starting = false;
    }
  }

  cancel(runId: unknown): void {
    const run = this.active;
    if (run === null || run.runId !== runId || run.canceled) return;
    run.canceled = true;
    run.child.kill('SIGTERM');
    run.cancelKillTimer = this.deps.setTimer(
      () => run.child.kill('SIGKILL'),
      IMPORT_CANCEL_GRACE_MS
    );
  }

  /** App quit: stop whatever is running. */
  cancelAll(): void {
    if (this.active !== null) this.cancel(this.active.runId);
  }

  private attach(runId: string, child: ImportChild): void {
    const run: ActiveRun = {
      runId,
      child,
      sawError: false,
      canceled: false,
      cancelKillTimer: null,
    };
    this.active = run;
    const lines = new JsonLineParser((value) => this.forward(run, value));
    child.onStdout((chunk) => lines.push(chunk));
    child.onClose((code) => {
      lines.end();
      this.finish(run, code);
    });
  }

  private forward(run: ActiveRun, value: Record<string, unknown>): void {
    // `exit` is the main process's own final event; the CLI cannot end a run early.
    if (value.event === 'exit') return;
    if (value.event === 'error') run.sawError = true;
    this.deps.emit({ ...value, runId: run.runId });
  }

  private finish(run: ActiveRun, code: number | null): void {
    run.cancelKillTimer?.();
    run.cancelKillTimer = null;
    if (this.active === run) this.active = null;
    if (code !== 0 && !run.sawError) {
      this.deps.emit({
        runId: run.runId,
        event: 'error',
        message: run.canceled ? IMPORT_CANCELED_MESSAGE : IMPORT_FAILED_MESSAGE,
        ...(run.canceled ? { canceled: true } : {}),
      });
    }
    this.deps.emit({ runId: run.runId, event: 'exit', code });
  }
}
