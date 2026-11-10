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
 * report that is not an object with a status never stalls the session. A slow
 * startup (a cold dependency install) does not hold the CLI past its grace
 * window: the agent starts, told where the report will appear, and a previous
 * boot's report is removed so it cannot pass for this boot's.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  async function promptWithScriptedRunner(
    label: string,
    runnerSource: string,
    opts: {
      env?: (home: string) => Record<string, string>;
      setup?: (home: string) => void;
      onPrompt?: (home: string) => void;
    } = {}
  ): Promise<string> {
    ctx.installFakeClaude();
    const home = mkdtempSync(join(ctx.fixture, `claude-home-runner-${label}-`));
    const workdir = join(home, 'workspace');
    mkdirSync(workdir, { recursive: true });
    const runner = join(home, 'scripted-startup-runner.cjs');
    writeFileSync(runner, runnerSource);
    opts.setup?.(home);
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
        ...opts.env?.(home),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const prompt = (JSON.parse(await ctx.waitForFile(capture, 60_000)) as { stdin: string })
        .stdin;
      opts.onPrompt?.(home);
      return prompt;
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

  // code-agent-rose-repo (2026-11-08): the CLI waited 469 s for a cold npm
  // install before the agent could start (ready 782 s against a 480 s budget).
  test('claude: a slow startup does not hold the CLI past the grace window; a stale report is removed', async () => {
    let reportPath = '';
    let reportExistedAtPrompt = true;
    const prompt = await promptWithScriptedRunner(
      'slow',
      `setTimeout(() => {
  require('node:fs').writeFileSync(process.env.REPORT_PATH, '{"status":"ok"}');
  process.stdout.write('\\nROSE_PROJECT_STARTUP_REPORT {"status":"ok","exitCode":0,"durationMs":8000}\\n');
}, 8000);
`,
      {
        setup: (home) => {
          reportPath = join(home, '.rose', 'project', 'startup-report.json');
          mkdirSync(join(home, '.rose', 'project'), { recursive: true });
          // A previous boot's report must not read as this boot's.
          writeFileSync(reportPath, '{"status":"ok"}');
          writeFileSync(
            join(home, '.rose', 'project', 'startup.json'),
            JSON.stringify({
              timeoutS: 480,
              reportPath,
              logPath: join(home, '.rose', 'project', 'startup.log'),
            })
          );
        },
        env: (home) => ({
          CODE_SESSION_PROJECT_STARTUP_GRACE_MS: '500',
          ROSE_PROJECT_STARTUP_CONFIG: join(home, '.rose', 'project', 'startup.json'),
          REPORT_PATH: join(home, '.rose', 'project', 'startup-report.json'),
        }),
        onPrompt: () => {
          reportExistedAtPrompt = existsSync(reportPath);
        },
      }
    );
    assert(
      prompt.includes(
        'Project startup for project PJ-Claude-Runner-slow is still running in the background'
      ),
      `the agent is told startup is still running: ${prompt.slice(0, 400)}`
    );
    assert(prompt.includes(`wait until ${reportPath} exists`), prompt.slice(0, 400));
    assert(!prompt.includes('finished OK'), prompt.slice(0, 400));
    assert(!reportExistedAtPrompt, 'the previous boot report was removed before startup');
  });
}
