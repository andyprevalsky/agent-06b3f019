---
name: swap-harness
description: Migrate boxes.dev tasks stopped by Claude or Codex subscription limits to fresh devboxes on the other harness, preserving changes and task context in draft PRs before archiving old boxes. Use for /swap-harness or an explicitly requested harness migration.
---

# /swap-harness

Resume every affected task on a **new devbox and thread**: Claude exhausted →
Codex; Codex exhausted → Claude. Save each task's changes and context in its PR
before branching the continuation or archival. **All task files and source
changes must be preserved in the PR; a previously pushed branch alone is not
completion.** An invocation authorizes these checkpoints, draft PRs,
replacement threads and preservation-conditioned archival. It does not
authorize merging/deploying, changing subscriptions, paid API fallbacks, or
overriding task-specific user constraints. Preserve Freedom and protected
instructions.

**Hard exclusion:** Never migrate a devbox whose main work is already being
done on Codex. Skip it even when an older Claude thread on that box shows a
limit. Establish which thread owns the main task before any checkpoint,
replacement or archive action. A Codex helper created specifically to migrate
stalled Claude work is a migration worker, not an existing Codex main task.
For this user's workflow, this hard rule takes precedence over the generic
Codex→Claude direction, including a quota-stopped Codex main task. Preserve any
additional user exclusions (for this run: Browser Mode P2).

```text
project threads → confirm quota stop + identify old box
  → opposite-harness worker on OLD box → checkpoint + handoff → draft PR
  → NEW box on opposite harness → checkout + meaningful continuation receipt
  → preserve remaining local state / retire owned resources → archive OLD box
```

## Coordinate

1. Read `CLAUDE.md`/`AGENTS.md`, `dvb-onbox --help`, and `box status --json`.
   Follow the installed boxes-read-threads and boxes-delegated-threads guidance
   when available. Never install workstation `dvb` on a managed box.
2. Run `python3 <skill-dir>/scripts/inventory.py --output
   .context/swap-harness/inventory.json`. It pages every current-project thread
   (including empty filtered pages) and privately saves ten recent turns.
   Confirm actual recent session/weekly/usage limit or subscription expiry;
   network errors, compaction, idle/completed tasks, and an earlier limit
   followed by successful work do not qualify. Notice-only or shortened
   previews require further context, not an inferred limit.
3. Obtain the old devbox routing identity using supported tools/receipts or
   authenticated boxes.dev UI. The scoped API on some runtimes omits devbox
   IDs. Do not confuse thread/session/project/provider-sandbox IDs with devbox
   IDs. `--targets-file` accepts a JSON map of public thread ID → devbox ID.
   Consume authoritative routing fields when present. An archived child's
   execution identity can point back to a Template box; use its saved start
   receipt and verify the target instead of treating that field as its old box.
   If the routing identity remains unavailable, continue preparing context and
   identify the precise platform gap; do not destroy a box or claim its local
   changes were preserved from a read-only thread preview.
   If a working opposite-harness thread already shares that old box, an
   authorized peer message can ask it to checkpoint locally and initiate the
   replacement without routing through an old-box ID. Verify actual box/session
   ownership, since inherited transcripts alone do not prove co-location.
   When neither route is available, use the limited recovery mode below.
4. Group by old devbox, with one worker/replacement per affected box. Include
   all relevant threads on it. Skip the coordinator and already-migrated boxes.
   Also skip every box with an existing Codex main task, regardless of other
   threads' quota status. Record the exclusion before dispatch; if a worker
   discovers an active Codex main task later, stop that box's migration and
   report the exclusion without touching its task files or lifecycle.
   Save evidence, IDs, phases and stable keys under `.context/swap-harness/`.
   Put nonsecret checkpoint/replacement receipts in the PR handoff as well.
5. Read `threads options --agent <opposite> --json`, using saved defaults unless
   the user selected a supported model. Start a muted worker using
   `threads start --target devbox:<old-id> --agent <opposite>` and a regular
   prompt file (≤32 KiB). Supply this skill, original thread/native session IDs,
   quota evidence and user constraints. The worker follows
   [references/migrate-one.md](references/migrate-one.md) on the old filesystem.
   A native subagent on the coordinator can coordinate one migration but has
   no access to another devbox's uncommitted files.
6. Observe exact worker turns with `threads wait --turn <id> --timeout 45s`.
   Retry observation timeouts on the same turn; review complete `output.text`
   or `threads result --turn <id>`, since reads are bounded previews. Keep the
   coordinator active until all migration workers finish. Verify every PR,
   replacement's meaningful continuation receipt, and old-box archive state.
   Do not wait for replacements to finish their original tasks; they should
   continue independently. Report actual outcomes and concrete blockers.

Use boxes-agent-permissions for an operation's typed disabled-access error;
request only its named permission once, retaining stable keys on retries.
Do not bypass platform denials. If the opposite harness also hits its limit,
keep the checkpoint and old box; do not recursively swap back and forth.

## Recovery without old-box routing

When the user asks to continue without supplying IDs and no supported route
reaches the old filesystem, preserve the latest **pushed** task branch and
thread context in its PR as preparation. Do not start source-changing or paid
continuation from an incomplete checkpoint. A fresh box may investigate safe
read-only recovery, but it cannot substitute for an old-filesystem worker.
Check for a newer pushed branch named in the transcript;
an older open PR may lag it. Fast-forward an existing PR only with proven
ancestry; otherwise create a new draft PR for the latest pushed task branch.
Use an isolated worktree when writing its handoff from the coordinator.

Mark preservation `partial`: local unpushed source, runtime/evidence and old
box resource state remain unknown. A referenced local commit missing from the
remote is evidence of work still requiring recovery. Tell the replacement to
reconcile durable evidence/resources before launching another paid run and to
preserve the old machine. Verify checkout, handoff reading and meaningful
continuation as usual. Report that archival and complete local preservation
remain unfinished; never convert a partial recovery into a completed migration
or delete the old box on the strength of a GitHub checkpoint alone.

The workflow must run autonomously; missing routing identity is a platform
capability blocker, not a normal request for manual IDs or user-started threads.
Keep the original boxes intact and the task explicitly unfinished. Ask for the
supported discovery capability to expose same-project execution/devbox IDs
under existing read access, or a supported thread-target start operation. Contact
platform staff only when the user explicitly authorizes that communication.
When the user independently provides old-box Codex threads, coordinate with
them through managed peer messaging and follow the full single-box workflow.
The operator bootstrap reference is only for an explicit user request for
interim manual instructions; it does not satisfy autonomous-skill acceptance.

## Install and iterate

The repo's canonical skill lives in `.agents/skills/swap-harness`, with Claude
discovery through `.claude/skills/swap-harness`. Run
`python3 <skill-dir>/scripts/install.py` for standalone home installs on both
harnesses. This touches only this skill. New boxes inherit the project's saved
reusable source, not the old live filesystem. The installer uses the canonical
Codex `.agents/skills` path plus a `.codex/skills` alias for managed catalogs,
and Claude's `.claude/skills` path. Push the skill commit; fetch and
extract only its folder where task branches predate it, then install before
starting workers. Specify the exact skill revision in replacement prompts.
A current-box installation does not update siblings or the Template snapshot.

Correct guidance/helpers narrowly when live migrations reveal issues, validate,
publish the updated commit, and use it for remaining migrations. Run the bundled
creator's `quick_validate.py` when available, and the registered swap-harness
structural gate for helpers. Keep raw transcripts and private inventory out of
Git.
