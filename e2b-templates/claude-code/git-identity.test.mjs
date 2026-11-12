// Owning test: code-agent commits carry the pushing GitHub account's identity.
//
// Runs the REAL claude-code and codex-code ws-server.mjs with REAL git. The
// backend passes the account behind GITHUB_TOKEN as GIT_AUTHOR_* /
// GIT_COMMITTER_* (back-end/src/providers/codeAgentGitIdentity.ts); the server
// must write exactly that into the repo it clones or resumes, so a commit made
// with no identity envs at all is still authored by that account.
//
// Failure this pins (2026-11-12): the servers hard-coded
// `Rose Agent <agent@roselabs.ai>`. GitHub links no account to that address,
// so Vercel blocked every such main HEAD ("GitHub couldn't verify an account
// for the commit") and production stopped updating.
//
// Contract:
//  - a fresh clone is configured with the passed identity;
//  - a resumed workspace an older server set to the unlinkable identity is
//    corrected to the passed identity;
//  - a commit made without any identity env is authored by that account.
//
// Run by `back-end/src/tests/unit/ws-server-git-identity.test.ts` in /deploy.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TOKEN = "ghp_" + "I".repeat(36);
const IDENTITY = {
  name: "andyprevalsky",
  email: "25310436+andyprevalsky@users.noreply.github.com",
};
const UNLINKED = { name: "Rose Agent", email: "agent@roselabs.ai" };

const SERVERS = [
  {
    name: "claude-code",
    path: fileURLToPath(new URL("./ws-server.mjs", import.meta.url)),
    cli: "claude",
    env: {
      CLAUDE_CODE_GOAL: "initial",
      CLAUDE_CODE_MODEL: "test-model",
      ANTHROPIC_API_KEY: "fake",
      CODE_SESSION_TURN_TOKEN: "test-token",
    },
  },
  {
    name: "codex-code",
    path: fileURLToPath(
      new URL("../codex-code/ws-server.mjs", import.meta.url),
    ),
    cli: "codex",
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

/** git with no identity from the environment or any global/system config. */
function bareEnv(home) {
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(key) || key.startsWith("GIT_CONFIG_"))
      delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

const git = (cwd, env, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** A local "GitHub" holding o/r with one commit on main. */
function remoteRepo(root, env) {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, env, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "rose\n");
  git(seed, env, "add", "-A");
  git(
    seed,
    env,
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    "commit",
    "-q",
    "-m",
    "initial",
  );
  const bare = join(root, "github", "o", "r");
  mkdirSync(bare, { recursive: true });
  git(bare, env, "init", "-q", "--bare", "-b", "main");
  git(seed, env, "push", "-q", bare, "main");
  return `${join(root, "github")}/`;
}

/** The workspace an older server left behind: cloned, configured as Rose Agent. */
function staleWorkspace(home, remote, env) {
  const workspace = join(home, "workspace");
  git(home, env, "clone", "-q", `${remote}o/r`, workspace);
  git(workspace, env, "config", "user.name", UNLINKED.name);
  git(workspace, env, "config", "user.email", UNLINKED.email);
  return workspace;
}

async function runServer(server, { root, home, remote }) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, server.cli), "#!/bin/sh\nexec sleep 60\n", {
    mode: 0o755,
  });
  const child = spawn(process.execPath, [server.path], {
    cwd: root,
    env: {
      ...bareEnv(home),
      PATH: bin + ":" + process.env.PATH,
      PORT: "0",
      GITHUB_REPO_URL: "https://github.com/o/r",
      GITHUB_TOKEN: TOKEN,
      CODE_AGENT_BRANCH: "rose/feature",
      CODE_AGENT_BASE_BRANCH: "main",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://x-access-token:${TOKEN}@github.com/`,
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
      ...server.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = new Promise((resolve) => child.once("close", resolve));
  const ready = "Code session branch prepared";
  try {
    for (let i = 0; i < 400 && !logs.includes(ready); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(logs.includes(ready), `never logged ${ready}:\n${logs}`);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  assert.ok(
    !logs.includes(TOKEN),
    `the credential leaked into the output:\n${logs}`,
  );
  return logs;
}

/** Repo config, and the author/committer of a commit made with no identity env. */
function commitWithoutIdentityEnv(workspace, env) {
  const config = {
    name: git(workspace, env, "config", "user.name"),
    email: git(workspace, env, "config", "user.email"),
  };
  writeFileSync(join(workspace, "change.txt"), "agent work\n");
  git(workspace, env, "add", "change.txt");
  git(workspace, env, "commit", "-q", "-m", "agent commit");
  const [author, committer] = git(
    workspace,
    env,
    "log",
    "-1",
    "--format=%an <%ae>%n%cn <%ce>",
  ).split("\n");
  return { config, author, committer };
}

const expected = `${IDENTITY.name} <${IDENTITY.email}>`;

for (const server of SERVERS) {
  test(`${server.name}: a fresh clone commits as the pushing account`, async () => {
    const root = mkdtempSync(
      join(tmpdir(), `rose-git-identity-${server.name}-`),
    );
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const env = bareEnv(home);
      const remote = remoteRepo(root, env);
      await runServer(server, { root, home, remote });
      const result = commitWithoutIdentityEnv(join(home, "workspace"), env);
      assert.deepEqual(result.config, IDENTITY);
      assert.equal(result.author, expected);
      assert.equal(result.committer, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${server.name}: a resumed workspace set to the unlinkable Rose Agent identity is corrected`, async () => {
    const root = mkdtempSync(
      join(tmpdir(), `rose-git-identity-${server.name}-`),
    );
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const env = bareEnv(home);
      const remote = remoteRepo(root, env);
      const workspace = staleWorkspace(home, remote, env);
      await runServer(server, { root, home, remote });
      const result = commitWithoutIdentityEnv(workspace, env);
      assert.deepEqual(result.config, IDENTITY);
      assert.equal(result.author, expected);
      assert.equal(result.committer, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
