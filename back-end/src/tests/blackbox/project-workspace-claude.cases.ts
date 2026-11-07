/**
 * Claude Code half of the startup-report cases (the Codex half lives in
 * project-workspace-codex.cases.ts and shares its scripted runners). Registered
 * by project-workspace.blackbox.ts, which owns the fixture directory, the fake
 * `claude` CLI and the file waiter.
 *
 *   real e2b-templates/claude-code/ws-server.mjs (project mode)
 *        └─► scripted startup runner (writes the report late, never, or garbled)
 *        └─► fake `claude` records the prompt the CLI receives
 *
 * Invariants: the startup report is read after the runner's stdout has closed
 * (a report line that arrives after the runner exits is not lost); a runner
 * that wrote no report is told apart from one whose report is malformed; a
 * report that is not an object with a status never stalls the session.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  scriptedStartupRunners,
  UNREADABLE_STARTUP_REPORTS,
} from './project-workspace-codex.cases';
import { assert } from './projects-harness';

export function registerClaudeStartupReportCases(ctx: {
  fixture: string;
  wsServer: string;
  installFakeClaude: () => void;
  waitForFile: (path: string, timeoutMs: number) => Promise<string>;
}): void {
  /** Project-mode Claude ws-server with a scripted startup runner; returns the CLI prompt. */
  async function promptWithScriptedRunner(label: string, runnerSource: string): Promise<string> {
    ctx.installFakeClaude();
    const home = mkdtempSync(join(ctx.fixture, `claude-home-runner-${label}-`));
    const workdir = join(home, 'workspace');
    mkdirSync(workdir, { recursive: true });
    const runner = join(home, 'scripted-startup-runner.cjs');
    writeFileSync(runner, runnerSource);
    const capture = join(ctx.fixture, `claude-runner-${label}.json`);
    const child = spawn(process.execPath, [ctx.wsServer], {
      env: {
        ...process.env,
        HOME: home,
        PORT: '0',
        CLAUDE_CODE_GOAL: `claude scripted startup runner ${label}`,
        CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token',
        FAKE_CLAUDE_CAPTURE_PATH: capture,
        ROSE_PROJECT_WORKDIR: workdir,
        ROSE_PROJECT_STARTUP: runner,
        ROSE_PROJECT_NAME: `PJ-Claude-Runner-${label}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      return (JSON.parse(await ctx.waitForFile(capture, 60_000)) as { stdin: string }).stdin;
    } finally {
      child.kill('SIGKILL');
    }
  }

  test('claude: a startup report that reaches stdout only after the runner exits is not lost', async () => {
    const prompt = await promptWithScriptedRunner(
      'late',
      scriptedStartupRunners.lateReport({
        status: 'ok',
        exitCode: 0,
        durationMs: 1500,
        timeoutS: 60,
        outputTail: 'late',
        logPath: null,
      })
    );
    assert(
      prompt.includes('Project startup for project PJ-Claude-Runner-late finished OK in 1.5s'),
      `the late report is used: ${prompt.slice(0, 300)}`
    );
  });

  test('claude: a missing or unreadable startup report is reported as such and never stalls the session', async () => {
    const crash = await promptWithScriptedRunner('crash', scriptedStartupRunners.crash(7));
    assert(
      crash.includes('FAILED (exit ?)') &&
        crash.includes('startup runner produced no report (exit code 7)'),
      `a crash without a report says so: ${crash.slice(0, 300)}`
    );
    assert(!crash.includes('malformed'), 'a missing report is not "malformed"');
    for (const [name, payload] of UNREADABLE_STARTUP_REPORTS) {
      const prompt = await promptWithScriptedRunner(
        name,
        scriptedStartupRunners.reportLine(payload)
      );
      assert(
        prompt.includes('FAILED (exit ?)') &&
          prompt.includes('startup runner wrote a malformed report (exit code 0)') &&
          !prompt.includes('finished OK'),
        `${name}: an unreadable report is malformed, not success: ${prompt.slice(0, 300)}`
      );
    }
  });
}
