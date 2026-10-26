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

## Parent merge-down contract (specified 2026-10-21; implementation pending)

The user model is **one agent = one conversation thread**. A thread owns a
logical workspace and an append-only event history; it need not allocate an
E2B VM or browser until work needs one. The physical worker, provider session,
and sandbox may change without changing thread identity. This section defines
the requested next contract; it does not claim the current runtime enforces it.

### Fork and ownership

- Each child records its direct parent, root, user, project/repo identity, fork
  base revision, and its own thread/workspace identity. A browser fork also
  records origin and authenticated account; a code fork records repo base SHA.
- Normal child work is isolated. The parent continues working while children
  run. Normal child collaboration submits results to the **direct parent**,
  not a grandparent or sibling. Top-level network publication is a separate
  coordinated deploy operation below. Verified browser credentials use the
  account-wide distribution plane rather than parent integration.
- Existing “New agent in this branch” is an explicit collaborative mode, not
  the default: threads stay separate and one writer lease serializes shared
  workspace mutation. It must not silently give concurrent agents the same
  writable checkout or browser page.
- A logical fork is cheap: allocate a physical sandbox/context lazily. Use a
  verified checkpoint or supported provider fork as an optimization, with a
  restore fallback. Do not assume native snapshot/fork is enabled for an E2B
  account or compatible with the installed SDK.

### Stacked Git branches (clarified 2026-10-21)

Each independent agent has one branch in its own worktree, based on the exact
parent commit captured at fork. Its PR targets the parent's branch; top-level
work targets the shared default branch. Branch names use a suffix such as
`rose/feature--child-abc123` so a ref is not both a file and a directory.
Record child branch, parent branch, and fork SHA. Parent changes are integrated
into the child with conflict resolution and affected validation before join.
If the parent lands on the shared branch first, retarget/rebase the remaining
stack through the repository's workflow. Internal helpers sharing an owning
code agent's worktree share its branch; give them separate worktrees if they
need independent branches. Sharing a filesystem is not a branch-merge strategy.

### Submit, validate, merge, acknowledge

A child checkpoints completed units of work and submits an immutable proposal:
thread/parent identity, base revision, child revision, artifact hashes, changed
resources, validation evidence, and external-action receipts. A proposal is
keyed by child thread plus revision; retries cannot apply it twice.

The parent is the sole integration authority for its workspace. Stage the
proposal against the **current** parent head, validate the combined result,
then compare-and-swap that head. If another proposal or the parent changed it,
re-evaluate/retest rather than overwrite it. Serialize the final publish step;
independent child execution can remain parallel. A stale/conflicting proposal
returns actionable conflict details to the child and leaves the parent intact.

Track separate outcomes: work completed, submitted, validating, conflicted,
merged, or rejected. “Child completed” does not imply “merged.” The acknowledgment
records proposal ID, parent revision before/after, applied resources, checks,
and exclusions. Parent timeline shows a concise result with links to the child
and receipt, not a concatenation of the child's entire native conversation.

### Mandatory publication gate

Publishing work is permitted only within the applicable repository skill:
branch-join for a parent branch, deploy for top-level shared-branch publication.
The skill's pre-publication validation and approvals precede the merge; its
post-merge verification completes the operation. Require a receipt recording
skill, source commit, target branch, resulting commit, checks/evidence, and
applicable deployment outcome. The parent verifies these facts before marking
publication complete. Reading or creating the skill is not running it. Failed
or missing gates remain pending. This is the required agent contract; hard
provider-side enforcement still needs the repository publication/CI boundary
to enforce it, and is not established merely by these instructions.

### Code and E2B snapshots

Independent sub-agents of sub-agents join their immediate parent's branch via
the repo-defined branch-join skill. If absent, create a repo-local branch-join
skill from the repo's Git rules and validation commands. Relevant deploy checks
may be reused, but do not run the deployment workflow as a fallback. Internal
coding workers share their owning code agent's worktree by default, with file
ownership and serialized Git operations; there is no branch merge between them.

Network publication is a distinct top-level operation: when changes must be available to
all agents, the code agent follows the repository's own deploy skill to merge
the validated result into GitHub `main` (or its configured shared branch).
If no repo-local deploy skill exists, it creates one from that repository's
actual checks and release configuration. For Rose, use the existing `/deploy`
coordinator and required gates. Parent-branch integration alone is not network
publication; a shared-branch merge alone is not proof every running agent has
adopted it. Return the verified commit and synchronize consumers at safe points.

- Versioned code uses a three-way Git merge from the recorded fork SHA into
  the direct parent's branch. Verify repo/user identity and declared changes;
  never push to the default branch merely because a child finished. Root
  publication follows the existing user/deploy authorization separately.
- Non-Git outputs use a content-hashed manifest and explicit deletes. Apply a
  path only if its parent value still equals the fork base, or both sides made
  the same change; otherwise surface a conflict. Binary files, deletion/edit
  conflicts, and incompatible generated outputs require an explicit decision.
- Never overlay a child's whole filesystem/snapshot onto a live parent. E2B
  snapshots/checkpoints are for fork, pause, recovery, and evidence; **the
  merge unit is code/data changes**, not RAM, processes, sockets, PID files,
  credentials, dependency caches, or provider identity. Recreate necessary
  services in the parent from its resulting code and validated startup recipe.
- Before publish, preserve a recoverable parent checkpoint. Validate in a
  staging worktree/environment, publish the revision atomically, then refresh
  the parent's stable preview. Do not swap the parent preview to a child URL
  and call that a merge. A runtime activation failure retains the old serving
  revision and reports the candidate as not activated.
- Checkpoint and failure recovery preserve dirty/untracked work, but a merge
  proposal explicitly names what it integrates. A missing or hash-invalid
  artifact fails closed. Excluded large files must be reported, not silently
  treated as successfully transferred.

### Browsers: persistent sessions plus account-wide credential distribution

Updated user direction, 2026-10-21: every general-purpose thread gets a stable
logical browser session branched from Home/main. This does not require keeping
an idle browser process running for every thread. Initialize its baseline and
ownership at thread creation; materialize its isolated context when first used.
The logical session survives worker shutdown and provider-session replacement.

**Lifecycle:** active -> checkpointing -> paused -> resuming -> active. Every
normal shutdown, cancellation, completion, and idle release requests pause,
not deletion. Persist resumable profile/state, tabs/URLs, action cursor, and
confirmed action receipts before acknowledging a successful pause. Never label
a failed save as a durable pause. If the provider cannot suspend a process,
release compute only after a verified state checkpoint and later reconstruct
it under the same logical session ID; report reconstruction separately from
native resume. Actual crash/hard-kill cannot run a shutdown handler: periodic
and action-boundary checkpoints plus recovery reconciliation bound that loss.

The next authorized browser command automatically resumes the existing logical
session and waits for readiness, rather than making a fresh unrelated browser
or asking the user to resume manually. Concurrent resume requests coalesce.
Before the next action, refresh its credential versions and reconcile any
previous action whose outcome is unknown. Incoming credentials alone must not
wake every paused browser or incur compute across the network. Explicit user
retirement/deletion remains separate from ordinary shutdown.

**Credentials:** successful logins propagate across the user's whole browser
network, including Home/main, parents, children, siblings, and future sessions.
This supersedes hierarchical credential merge-down. Use one encrypted credential
registry keyed by user + auth realm + actual account identity, with monotonic
versions and revocations. A verified login writes a coherent credential bundle
and publishes its version immediately. No plaintext credentials appear in bus
events, model messages, logs, or ordinary merge receipts.

Each matching session receives the version, then fetches it through an
authorized channel. Idle active contexts apply at once; an in-flight action
finishes under its lease before applying at a safe boundary. Paused sessions
retain the pending version and apply it on resume. Do not navigate, reload,
replace tabs, or change another account merely to distribute a login. A thread
intentionally using another account stays on that account until explicitly
switched. Home receives matching updates even when it is not an ancestor.

A login must prove the expected account with an authenticated site response;
page text or new cookies alone are not sufficient. Broadcast only the minimum
allowed cookies/storage for that realm, preserving domain/path/partition scope.
Treat refresh-token rotation as a serialized credential operation: use a broker
or single refresh owner where tokens are one-use or a new login revokes others.
Device-bound/session-bound credentials may not be transferable; record that
limitation and obtain a supported login rather than claiming every context is
signed in. A stale child cannot overwrite a newer version. Explicit user logout
revokes the applicable account bundle; an accidental child logout or expired
cookie must not sign the entire network out.

Current close-time keep-best harvesting is useful groundwork, but it does not
implement immediate verified fan-out, session subscriptions, coherent storage
updates, or rotation ownership. These remain required runtime work.

Other browser outputs have their own treatment:

| Child result | Parent/network treatment |
|---|---|
| Findings, URLs, screenshots, downloaded files | Attach immutable evidence/artifacts to the parent with provenance; open a result page when requested without replacing existing tabs. |
| Verified reusable authentication | Publish once to the account-wide credential registry; matching sessions consume the new version without a hierarchy merge. |
| Purchases, sends, edits, submissions, other remote mutations | Already affected the service: keep confirmed remote IDs/status; never replay as a merge. Use service idempotency keys or reconcile before retrying an uncertain outcome. |
| DOM, JS heap, sockets, in-flight requests, cursor/focus | Keep local to the owning browser. Restore/reconnect when supported; never merge across concurrent sessions. |

Acquire a scoped lease before conflicting external mutations (account/site/
resource); read-only research can run concurrently. Preserve user-owned tabs,
manual activity, and Freedom. Browser snapshots do not contain or undo external
server state. Hierarchical integration remains necessary for code/files and
parent decisions, but not for propagating verified reusable logins.

### Evidence, lifecycle, and required acceptance

A merged child can pause after its artifacts and receipt are durable. Preserve
its checkpoint through the retention policy; conflicts/failures remain
resumable. Stop only its owned idle compute after confirming no active lease
or parent consumer depends on it. Parent crash recovery reconciles an accepted
proposal by ID instead of repeating remote actions or applying files twice.

Required proofs before calling this implemented:

1. Two children change disjoint files; both integrate into the current parent,
   and its preview serves the combined revision. Overlapping edits/deletes
   return a conflict without losing parent or sibling work.
2. Duplicate delivery, stale base, parent crash between apply and ACK, corrupted
   checkpoint, and failed combined validation never produce a false merged
   receipt or repeat an external action.
3. A verified child login reaches matching Home, parent, sibling, active and
   paused sessions exactly once; future sessions start with the latest version.
   Foreign users/accounts are excluded, stale versions cannot replace fresh
   ones, rotation is serialized, and nontransferable credentials are explicit.
   Tabs and Freedom remain intact; distribution does not wake paused compute.
4. Child send/submit succeeds but ACK is lost: reconciliation finds the remote
   action once, without sending/submitting again. Unknown outcomes stay unknown.
5. Browser normal shutdown durably pauses; next action auto-resumes the same
   logical session, with concurrent resumes coalesced and pending credentials
   applied. Hard-kill recovery reports the last checkpoint and reconciles
   unknown actions. Provider reconstruction is not reported as native resume.
6. E2B pause/resume failure restores verified files and conversation identity,
   recreates services explicitly, and never merges a child's live process
   memory into the parent. Large omitted files are visible in the receipt.
7. Grandchild merges into child, then child into parent; parent code, browser
   artifacts, receipt history, and root preview retain the correct identities.

Provider references (capabilities must be checked against our pinned versions):
[E2B snapshot/fork architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
and [Playwright browser storage state](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state).

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
