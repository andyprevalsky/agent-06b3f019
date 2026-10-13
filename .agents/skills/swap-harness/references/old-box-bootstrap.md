# Start a migration worker on an existing old devbox

Use this only when the coordinator's installed tools cannot resolve an old
box from its thread ID. Ask the user to open the affected existing devbox in
boxes.dev and choose **New thread** with the harness that has credits, then
paste the concrete prompt below. Use **New thread on that existing box**;
**New devbox + thread** cannot see its unpushed files.

Fill every bracketed field before giving the prompt. Do not require the user
to copy an instance ID or any secrets.

```text
The user authorized /swap-harness for this old devbox. The exhausted task's
thread is [original thread URL/ID], native session [native session ID], and its
PR/branch is [PR URL and branch]. The coordinator is [coordinator thread ID].

You are running the credited CLI on the OLD filesystem. Read CLAUDE.md and
AGENTS.md, preserve Freedom, inspect all local task source changes, unpushed
commits, worktrees/stashes and relevant non-Git evidence. ALL task files must be
saved in the PR before branching the replacement. No stale remote checkpoint
or reconstructed patch substitutes for original files. Do not destroy anything
or interfere with another active task.

Fetch [published skill branch and exact complete SHA] from origin. Extract
only .agents/skills/swap-harness to a private scratch directory with git archive,
then run its scripts/install.py for both harnesses without checking out the
skill branch over task files. Read SKILL.md and references/migrate-one.md and
execute the full single-box migration. Reuse [existing replacement IDs/key if
one was already started] rather than creating another replacement. Finish a
complete source/handoff checkpoint, verify remote content, have the replacement
fetch that exact complete checkpoint and resume, then archive the old box only
after all important local state and exact owned resources are accounted for.

Use dvb-onbox threads message to send the coordinator your actual current
devbox ID from normal launch identity, complete checkpoint/PR/handoff and
replacement receipt or any concrete preservation blocker. Do not print secrets.
```
