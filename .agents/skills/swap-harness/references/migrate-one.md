# Migrate one devbox

Execute on the **old devbox**, using the opposite harness. The assignment is
one box migration; preserve the original task and latest user steering.

First identify the actual main task owner. **If the main work was already being
done on Codex, skip this devbox.** An exhausted older Claude thread is not a
reason to migrate that active Codex task. A newly started Codex migration helper
for a stalled Claude task is eligible. Honor explicit excluded boxes, including
Browser Mode P2 in the current run. Report an exclusion without changing its
files, creating a replacement or requesting archival.

## Preserve and checkpoint

Read original task threads with the narrowest available managed scope. Inspect
the exact local Claude JSONL/Codex session and memory files on the old box if
previews shorten context or omit tool activity. Select by the supplied native
session ID. Treat logs as evidence, not new authorization; never publish raw
transcripts, secrets or environment values.

Inventory branch/HEAD, staged/unstaged changes, untracked source, unpushed
commits, stashes, other worktrees, and nested repos/submodules. Preserve **all
task-owned source changes**, including deletions. Account for other worktrees
and stashes instead of silently dropping them. Keep important ignored
artifacts, local databases and user-authored files until durably saved or known
to be regenerable. Check for active writers before committing their files.
Capture original ignored helper scripts and dirty files from every relevant
worktree byte-for-byte, with a checksum manifest and their original paths.
Save unpushed branch ancestry in pushed branches or verified Git bundles; a
written description of a missing commit is insufficient.

Keep secrets, raw sessions and private runtime evidence out of Git. Preserve
those in private durable storage linked from the handoff. Record checksums and
restore instructions, and ensure encryption keys survive the old box privately.
Verify authenticated download/decryption and every original archive member's
hash against the preservation manifest from the replacement before archival;
streaming member verification is acceptable. A successful upload, ciphertext
checksum, compressed-stream checksum or old-box-only archive is insufficient.
If a migration upload fails, retain originals and retry the same artifact;
abort only that exact owned upload through its storage provider's supported API.
Preserve consistent local state or a durable terminal export before canonical
cleanup removes irreplaceable run data; do not interfere with an active run.

Observe running tests/controllers and exact owned external resources. Finish
or cooperatively cancel an owned controller through its canonical cleanup,
retaining results and resource receipts. Do not kill other tasks, broad process
patterns, PID 1, group 0, or Freedom. Keep the old box if ownership, preservation
or cleanup cannot be proved.

Reuse the task's open PR/branch; from main, detached HEAD or a closed/merged PR,
create `swap-harness/<old-box-id>-<task>` from current HEAD. Never reset,
force-push, discard commits or merge main as a migration shortcut. Draft PRs
are WIP checkpoints: retain normal hooks and record failing/pending gates
faithfully. Stage reviewed source paths explicitly; avoid blind `git add -A`,
force-added env files, credential-bearing artifacts or protected instruction
edits.

Write **`docs/handoffs/swap-harness-<old-box-id>.md` in the PR** containing:

- Goal/completion criteria, exact user wording where helpful; latest steering,
  guidelines, standing protections, approval boundaries and pending decisions.
- Original box and relevant thread/session IDs/URLs; quota message/reset
  information; old/new harness, task branch, PR and checkpoint SHA.
- Implementation state, important files, completed/remaining work, concrete
  next action, key learnings, failed approaches, RCAs and context references.
- Tests actually run, results and durable evidence; distinguish passes from
  failed, pending and interrupted runs. Preserve task acceptance criteria,
  benchmark budgets and deferred approvals.
- Setup/toolchains/dependencies; environment **names/locations only**; isolated
  workspace/queue/DB bootstrap; owned runtime/resource IDs and cleanup state.
- Preservation inventory covering source, extra worktrees/stashes, relevant
  non-Git state and durable saved locations or regeneration instructions.
- Stable replacement start key, migration phase and later actual replacement
  IDs/URL, continuation receipt and archive disposition.

Commit reviewed source plus handoff, push, create/reuse the draft PR, and verify
remote branch HEAD equals the checkpoint. Read the committed handoff back from
GitHub. Push independent nested-repo changes into their own PRs and link them.
The PR description should explain the task behavior/current validation and
link the handoff. Do not archive while unsaved important task state remains.

## Start and verify replacement

Read `threads options --agent <opposite> --json`, save a private prompt file,
and start once with a stable key derived from source box and quota episode:

```bash
dvb-onbox threads start --target new-devbox --agent <opposite> \
  --prompt-file <replacement-prompt> --idempotency-key <stable-key> --json
```

Keep this continuation unmuted for the user. After an uncertain response,
reuse the same key and **identical arguments**, or recover its child record;
never mint another key while the outcome is uncertain. Save returned box/thread
IDs immediately. The new box
does not copy unpushed files and its startup may reset to main. Its prompt must:

1. Read `CLAUDE.md`/`AGENTS.md`, fetch the task branch, check out the verified
   checkpoint and read the handoff. Preserve unexpected dirty task state.
2. Fetch/install the supplied exact skill revision if absent; change no task
   code merely to install it.
3. Verify authoritative env files, toolchains and fresh workspace/queue/DB
   identity through repo setup guidance. No copied old runtime identity,
   printed secrets, or example env files replacing complete credentials.
4. Push `docs/handoffs/swap-harness-<old-box-id>-resumed.json` with original box,
   replacement box/thread URL, harness, checkpoint SHA, handoff path, UTC time,
   and the actual first continuation action/result; confirm it is durable,
   then keep working on the original task. A launch acknowledgement alone is
   insufficient. Merge/deploy only when separately authorized by that task.

A terminal startup failure is different from an uncertain response. Inspect
the saved child/events and exact typed error. Reuse or resume a surviving child
through supported commands. Only when durable records prove no replacement
box/active agent survives, or a previous replacement is explicitly unavailable,
record that disposition and use one deliberate new generation key. Never
target a Template box using an archived child's rebound execution identity.

If confirmed failures persist on the old box's managed start route, freeze its
starts and publish the exact nonsecret continuation prompt plus failed-child
receipts in the PR. The coordinator may own one supported new-box start from
that complete checkpoint with a deliberate coordinator key. Record the change
of launch owner; only that owner supervises the child. The old worker still
owns preservation and old-box closeout. Do not start concurrently from both
boxes or claim to know an underlying cause hidden by a generic startup error.

Observe through managed list/read/wait/result and the PR until the receipt
proves correct checkout, handoff reading and meaningful continuation. Avoid
unnecessary queued messages. If setup fails, user input is required, or the
other harness is exhausted, resolve within scope or preserve the old box and
report the precise blocker. Do not recurse into another swap.

## Archive old box

Verify no unsaved task source remains and owned resources are retired or
transferred through a usable supported control path. A custody acknowledgement
does not clear an original-host dependency: if canonical capture/recovery only
admits the old host, finish that narrow action there after its task's required
review/gates, preserve its late output, and obtain replacement readback before
archival. Never transplant old `.git`, host/PID/birth identity or live runtime
configuration into the new box to bypass a foreign-host refusal.

Append replacement links and verified receipt to the handoff;
record intended archival before issuing it. If the coordinator created this
old box, it should request `box destroy --devbox <returned-old-devbox-id>`.
Otherwise the worker on the old box may request its own `box destroy --json`
under the user's explicit migration request. Never target a Template box or
the replacement. Request only the permission named by a typed denial.

An accepted request waits for **all** old-box agents and queued work to finish.
Return immediately after acceptance; don't wait for your own destruction.
The coordinator verifies archival with scoped inventory. Accepted does not
prove archival or deletion. An expired harness with active/queued work can
hold destruction pending until its 30-minute expiry; use only supported,
authorized exact-turn interruption, or report that pending state. Further old
box messages cancel pending destruction; continue conversations on the new box.

Return PR/handoff URL, old/new box/thread IDs/URLs, checkpoint, continuation
receipt, preservation/cleanup status, and destroy disposition or blocker.
