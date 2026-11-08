// Owning test: the sandbox's startup git steps under a GitHub rate limit (rose-builds-rose C18).
//
// Runs the REAL claude-code and codex-code ws-server.mjs with REAL git against
// a fake git endpoint that answers every request with HTTP 429. git generates
// its own error text ("The requested URL returned error: 429"); nothing here
// invents GitHub wording, and git exposes no reset time to the sandbox. The
// fake only answers; `url.<base>.insteadOf` (via GIT_CONFIG_*) points the
// credentialed github.com remote at it.
//
// Contract:
//  - a failed clone never writes the credential into the output or the log;
//  - a base branch that could not be fetched because GitHub refused is reported
//    with git's own failure, not as "not on the remote";
//  - a base branch that really is missing is still "not on the remote".
//
// Run by `back-end/src/tests/unit/ws-server-git-rate-limit.test.ts` in /deploy.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TOKEN = "ghp_" + "T".repeat(36);
const claudeServer = fileURLToPath(new URL("./ws-server.mjs", import.meta.url));
const codexServer = fileURLToPath(
  new URL("../codex-code/ws-server.mjs", import.meta.url),
);

const SERVERS = [
  {
    name: "claude-code",
    path: claudeServer,
    cli: "claude",
    cloneFailure: "[Setup] Failed to clone repo:",
    env: {
      CLAUDE_CODE_GOAL: "initial",
      CLAUDE_CODE_MODEL: "test-model",
      ANTHROPIC_API_KEY: "fake",
      CODE_SESSION_TURN_TOKEN: "test-token",
    },
  },
  {
    name: "codex-code",
    path: codexServer,
    cli: "codex",
    cloneFailure: "Failed to clone repository",
    env: {
      CODEX_AUTH_JSON: "{}",
      OPENAI_API_KEY: "",
      CODEX_GOAL: "test",
      CODEX_MODEL: "model",
      CODE_SESSION_TURN_TOKEN: "native-token",
      ROSE_PROJECT_WORKDIR: "",
    },
  },
];

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git endpoint that is rate limited for every request. */
async function rateLimitedGit() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.statusCode = 429;
    res.setHeader("retry-after", "60");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A workspace that already holds the repo, so the server resumes it. */
function resumableWorkspace(home) {
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "Test");
  git(workspace, "config", "user.email", "test@example.com");
  writeFileSync(join(workspace, "README.md"), "rose\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "initial");
  git(workspace, "remote", "add", "origin", "https://example.invalid/o/r");
}

async function runServer(server, { remote, resume, base, waitFor }) {
  const dir = mkdtempSync(join(tmpdir(), `rose-c18-git-${server.name}-`));
  const home = join(dir, "home");
  mkdirSync(join(dir, "bin"));
  mkdirSync(home);
  writeFileSync(join(dir, "bin", server.cli), "#!/bin/sh\nexec sleep 60\n", {
    mode: 0o755,
  });
  if (resume) resumableWorkspace(home);
  const child = spawn(process.execPath, [server.path], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: join(dir, "bin") + ":" + process.env.PATH,
      HOME: home,
      PORT: "0",
      GITHUB_REPO_URL: "https://github.com/o/r",
      GITHUB_TOKEN: TOKEN,
      CODE_AGENT_BRANCH: "rose/feature",
      CODE_AGENT_BASE_BRANCH: base,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://x-access-token:${TOKEN}@github.com/`,
      ...server.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = new Promise((resolve) => child.once("close", resolve));
  try {
    for (let i = 0; i < 400 && !logs.includes(waitFor); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(logs.includes(waitFor), `never logged ${waitFor}:\n${logs}`);
    // The log line is written; give the rest of startup a moment to finish
    // writing anything else that could carry the credential.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
  return logs;
}

function branchResult(logs) {
  const line = logs
    .split("\n")
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return {};
      }
    })
    .find((entry) => entry.message === "Code session branch prepared");
  assert.ok(line, `no branch result in:\n${logs}`);
  return line;
}

for (const server of SERVERS) {
  test(`${server.name}: a clone refused by GitHub (429) never writes the credential`, async () => {
    const git429 = await rateLimitedGit();
    try {
      const logs = await runServer(server, {
        remote: git429.url,
        resume: false,
        base: "main",
        waitFor: server.cloneFailure,
      });
      assert.ok(
        git429.requests.length >= 1,
        "the clone reached the fake GitHub",
      );
      assert.ok(
        logs.includes("returned error: 429") || logs.includes("exit"),
        `the failure is reported:\n${logs}`,
      );
      assert.ok(
        !logs.includes(TOKEN),
        `the credential leaked into the output:\n${logs}`,
      );
    } finally {
      await git429.close();
    }
  });

  test(`${server.name}: a base branch refused by GitHub (429) is not reported as missing`, async () => {
    const git429 = await rateLimitedGit();
    try {
      const logs = await runServer(server, {
        remote: git429.url,
        resume: true,
        base: "main",
        waitFor: "Code session branch prepared",
      });
      const { error } = branchResult(logs);
      assert.ok(
        git429.requests.length >= 1,
        "the fetch reached the fake GitHub",
      );
      assert.match(
        error,
        /returned error: 429/,
        `git's own failure is reported: ${error}`,
      );
      assert.doesNotMatch(
        error,
        /is not on the remote/,
        "a refusal is not a missing branch",
      );
      assert.ok(!logs.includes(TOKEN), "the credential leaked into the output");
    } finally {
      await git429.close();
    }
  });

  test(`${server.name}: a base branch that really is missing is still "not on the remote"`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rose-c18-remote-"));
    const bare = join(root, "o", "r");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    try {
      const logs = await runServer(server, {
        remote: `${root}/`,
        resume: true,
        base: "rose/never-pushed",
        waitFor: "Code session branch prepared",
      });
      assert.equal(
        branchResult(logs).error,
        "base branch rose/never-pushed is not on the remote",
      );
      assert.ok(!logs.includes(TOKEN), "the credential leaked into the output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
