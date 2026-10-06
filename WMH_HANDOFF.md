# WMH continuation branch

Remote branch: `codex/wmh-handoff-20261006`.

If your supplied checkout is on another branch, create a separate local worktree:

```bash
git fetch origin codex/wmh-handoff-20261006
git worktree add -b wmh-continue ../rose-wmh-continue origin/codex/wmh-handoff-20261006
cd ../rose-wmh-continue
```

Read `CLAUDE.md`, then
`docs/plans/active/wmh-local-continuation-20261006.md`. Exact benchmark runs,
corpus reports, and build metadata are in
`docs/plans/active/wmh-evidence-20261006/README.md` and the adjacent files.
This branch is WIP; its WMH changes have not been deployed.
