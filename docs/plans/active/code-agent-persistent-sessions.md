# Persistent code-agent sessions

## Goal

Every code-agent spawn can restart from the **exact last state** of its previous
session: filesystem (including uncommitted/untracked files and local commits),
CLI conversation, and — when the pause survived — memory and running processes.
Everything a code agent did is greppable from the root agent tree.

Approved by product owner 2026-10-20.

## Current state

- `spawn_claude_code_agent` creates a fresh E2B sandbox per spawn
  (`back-end/src/providers/e2b.ts`, 30-minute `SANDBOX_TIMEOUT_MS`).
- `closeClaudeCodeSession` (`e2bCloseSession.ts`) uploads `OUTPUT_DIR` files and
  **kills** the sandbox. The CLI transcript and working tree are lost.
- Retry only reattaches while the sandbox is still alive (`code_session`
  heartbeat in `domains/spawn_claude_code_agent/service.py`).
- `e2b-templates/claude-code/CLAUDE.md` instructs "commit and push to main".
  Nothing verifies it.
- `grep source=agent_trajectories` indexes `message` and `llm_context` trace
  kinds only; the CLI's commands, outputs and diffs are invisible.

## Design

```
 root agent (Temporal workflow)
   │ spawn_code_agent(goal, repo?, code_session_id?)
   ▼
 CodeSession row  (id, userId, rootAgentId, repoUrl, sandboxId,
                   cliSessionId, latestCheckpoint, state)
   │
   ├─ resume path 1: Sandbox.connect(sandboxId)  ← paused (fs + memory)
   ├─ resume path 2: new sandbox + restore checkpoint
   │                  (worktree tar + git bundle + CLI log) → `claude --resume`
   └─ new session:    fresh sandbox (+ clone repo)
   │
   ▼  every turn end / failure / drain / timeout
 checkpoint → storage  user/<userId>/code-sessions/<id>/<seq>/
   │            worktree.tar.zst  repo.bundle  cli-log.jsonl  manifest.json
   ├─ index code_event rows → AgentTrajectorySearch (grep)
   └─ Sandbox.pause()   (never kill except on explicit retirement / TTL)
```

### 1. Session identity

- New `CodeSession` model (migration required): stable id scoped to
  `(userId, rootAgentId, repoUrl)`. `ClaudeCodeSession` rows reference it.
- `spawn_code_agent` gains optional `code_session_id`. Default: resume the
  root's latest session for the same repo (or the repo-less session).
- Temporal retries of a failed spawn reuse the same `code_session_id`.

### 1b. Branch model (confirmed by Andy, 2026-10-20)

| How the agent starts | Worktree | Branch | Merges into |
|---|---|---|---|
| **New agent** (New Agent, or **+** on a project) | own, isolated | new branch cut from the project's default branch (`main`) | `main` (when shared) |
| **Sub-agent** (spawned by another agent) | own, isolated | new branch cut from its **parent's** branch, e.g. `rose-ui/polish` → `rose-ui/polish/speed` | the parent's branch, not `main` |
| **Right-click "New agent in this branch"** | **shares** the parent's worktree and code session | the parent's branch | — |

Every tool result and trajectory entry for a code agent reports its branch,
and the merge target for sub-agents is the parent's branch.

### 2. Pause instead of kill

- Create sandboxes with `autoPause: true`; `closeClaudeCodeSession` calls
  `pause()` instead of `kill()` after output extraction.
- Retirement (kill + delete checkpoints) only via explicit close or retention
  TTL (configurable, default 14 days since last activity).

### 3. Platform checkpoints (does not depend on the agent committing)

Written after each CLI turn, on failure/drain/timeout, and before pause:
- `worktree.tar.zst` — working directory including untracked files
  (excluding `node_modules`, build caches, files > configurable cap).
- `repo.bundle` — `git bundle create --all` (local commits, branches, stash).
- `cli-log.jsonl` — Claude Code project JSONL / Codex rollout + CLI session id.
- `manifest.json` — seq, sha256 of each artifact, HEAD, dirty file list.

Restore = untar worktree, fetch bundle refs, restore CLI log to its home path,
start CLI with `--resume <cliSessionId>` (Codex: `codex resume`). A checkpoint is
only accepted after its manifest hashes verify.

### 4. Commit / merge guidance (prompt, not enforcement)

Replace the template's "commit and push to main" with:
- Commit locally whenever a unit of work is complete — it is your checkpoint.
- Merge into your merge target (the parent's branch for sub-agents, `main` for
  new agents; see 1b) when other agents or the user need your changes.
  Otherwise keep work on your branch.
- You decide when, based on the task.

The tool result reports facts: local commits, branch, pushed?, PR, and
`merged` **only** when the GitHub API confirms the PR is merged and main
contains the commit. The parent's verifier decides whether the goal needed a
merge.

### 5. Grep

- New trace kind `code_event` (command, exit code, output excerpt, file edited,
  diff hunk) written from each checkpoint's CLI log into
  `AgentTrajectorySearch` via `traceArchiveSearchIndex.ts`.
- Pushed/merged commits indexed as a `code_repo` document source (path,
  commit sha, line ranges) so results point at exact lines.

### 10k-agent behavior

One checkpoint write + one index batch per turn per session, keyed to that
session; no shared row or channel. Paused sandboxes cost storage, not compute;
TTL bounds storage. Grep uses existing per-user indexes.

## Verification (automated)

All registered in existing `/deploy` suites:

- **Backend blackbox** `code-sessions.blackbox.ts` (local sandbox provider):
  - checkpoint round trip restores uncommitted edit, untracked file, local
    commit on a non-main branch; corrupted artifact hash → rejected.
  - close pauses (does not kill); connect failure falls back to latest checkpoint.
  - user B cannot read or resume user A's session (404).
- **Agents blackbox** `spawn_claude_code_agent`:
  - spawn → write file without committing → activity fails → Temporal retry →
    file present, same `code_session_id`.
  - second spawn with no id resumes the root's latest session for that repo.
  - `--resume` passed with the stored CLI session id; conversation context
    present (fake CLI fixture asserts the resumed transcript).
  - tool result reports `merged=false` when GitHub mock says open, `true` only
    when merged and main contains the sha.
- **Trajectory grep blackbox**: a command run in session 1 is found by
  `grep source=agent_trajectories` from the root after session 1 pauses.
- **Benchmark** `code-agent-resume-after-failure` (`pipeline-e2e`,
  `deploy_category: claude-code`): task forces a mid-run failure; static check
  that the final repo contains work from before the failure.
- Migration-drift structural test covers the new model.
