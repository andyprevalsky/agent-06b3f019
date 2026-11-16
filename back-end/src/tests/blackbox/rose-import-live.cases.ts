/**
 * Opt-in live cases for `rose import scan`: ROSE_IMPORT_LIVE_AGENTS=codex,claude
 * runs the REAL local CLIs (signed in on this computer: $CODEX_HOME / ~/.codex,
 * $CLAUDE_CONFIG_DIR / ~/.claude) on the fixture checkout, proving the scan
 * flags, the read-only sandbox and the plan parsing against the actual agents,
 * and that the agent never opened .env (no secret value in its transcripts).
 * Skipped by default: it spends the user's own agent usage.
 *
 * Usage: ROSE_IMPORT_LIVE_AGENTS=codex,claude bash scripts/run-blackbox-tests.sh rose-import
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASE_URL, anonymousSession, assert } from './projects-harness';
import { checkout, loginCode, noSecrets, rose, world } from './rose-import-harness';

const LIVE_AGENTS = (process.env.ROSE_IMPORT_LIVE_AGENTS ?? '')
  .split(',')
  .map((agent) => agent.trim())
  .filter(Boolean);

/** Session transcripts the agent wrote during this case (newer than `since`). */
function transcriptsSince(root: string, since: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl') && statSync(path).mtimeMs >= since) out.push(path);
    }
  };
  walk(root);
  return out;
}

for (const agent of ['codex', 'claude'] as const) {
  test(
    `live import scan (${agent}): the real agent plans the fixture read-only and never reads .env`,
    { skip: !LIVE_AGENTS.includes(agent), timeout: 600_000 },
    async () => {
      const s = await anonymousSession();
      const w = world(`live-${agent}`, {});
      const repo = checkout(w.dir, 'app');
      // The user's real home, as the Mac app runs the CLI (agent CLIs and their wrappers
      // read their own state from it); the runner may point HOME elsewhere.
      const realHome = userInfo().homedir;
      const configDir =
        agent === 'codex'
          ? (process.env.CODEX_HOME ?? join(realHome, '.codex'))
          : (process.env.CLAUDE_CONFIG_DIR ?? join(realHome, '.claude'));
      const transcripts = join(configDir, agent === 'codex' ? 'sessions' : 'projects');
      const since = Date.now();
      const code = await loginCode(s);
      const result = await rose(
        {
          ...w.env,
          // The real binaries and their own sign-in.
          PATH: process.env.PATH,
          HOME: realHome,
          ...(agent === 'codex' ? { CODEX_HOME: configDir } : { CLAUDE_CONFIG_DIR: configDir }),
          ROSE_LOGIN_CODE: code,
        },
        ['import', 'scan', '--dir', repo, '--agent', agent, '--api', BASE_URL, '--json']
      );
      assert(result.code === 0, `live scan failed: ${result.stdout}${result.stderr}`);
      const planEvent = result.events.at(-1)!;
      assert(planEvent.event === 'plan' && planEvent.agent === agent, result.stdout);
      const plan = planEvent.plan!;
      assert(plan.branch === 'develop', `branch from the remote default: ${plan.branch}`);
      assert(
        JSON.stringify(plan.envFiles) ===
          JSON.stringify([{ path: '.env', variables: ['APP_SECRET', 'DATABASE_URL'] }]),
        `env files by name only: ${JSON.stringify(plan.envFiles)}`
      );
      assert(plan.setupCommands.includes('npm ci'), JSON.stringify(plan.setupCommands));
      noSecrets(`live ${agent}`, result.stdout, result.stderr);
      // The agent never opened .env: no secret value in anything it recorded.
      const written = transcriptsSince(transcripts, since);
      for (const file of written)
        noSecrets(`live ${agent} transcript ${file}`, readFileSync(file, 'utf8'));
    }
  );
}
