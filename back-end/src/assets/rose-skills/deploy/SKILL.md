---
name: deploy
description: Use to publish changes through a repository's deploy workflow, or create a missing repo-local deploy skill.
---

# Publish repository changes to the agent network

Use the repository's own deploy skill. This installed skill is a discovery
and fallback guide, not a replacement for repo-specific release instructions.

## Discover the repository workflow

Read the repository's AGENTS.md/CLAUDE.md and look for its deploy skill or
command in `.agents/skills/deploy/SKILL.md`, `.claude/skills/deploy/SKILL.md`,
`.claude/commands/deploy.md`, or the location its instructions identify.
Resolve the actual GitHub remote and configured default branch; use `main`
when that is the shared branch. Join an existing deploy coordinator instead
of creating a competing release. Rose already has `/deploy`; use it.

When the branch-join skill falls back here, run the repository workflow in
parent-branch join mode: use the explicitly assigned parent branch, reuse its
checks, and omit main publication and production rollout. If the repo's deploy
workflow cannot target a parent branch, create a branch-join adapter around
its checks rather than running a main-only deployment.

Intermediate work can merge into a parent's branch. Network-wide publication
means the validated changes reach the shared GitHub branch through that
repository workflow. Do not treat an open PR or private-branch push as done.

## If the repository has no deploy skill

Create a repo-local `.agents/skills/deploy/SKILL.md` based on its actual package
scripts, CI, branch protections, and hosting configuration. Give it `name: deploy` and a concise discovery description. Include the real validation
commands, shared branch, review/merge process, deployment command or automatic
trigger, post-deploy checks, and recovery procedure supported by that repo.
Reference existing scripts instead of duplicating them. If there is no runtime
deployment, state that publication is the verified GitHub merge; do not invent
hosting, credentials, or a successful release. Commit this skill with the work.

## Execute and verify

Integrate the intended changes, preserve concurrent work, run the repository's
required checks, and follow its PR/merge and deployment process. Never force-push
the shared branch or bypass checks, protections, required approvals, or an
existing release owner. A request to publish does not waive those requirements.

Return the verified merged commit and shared branch, PR URL, checks and deploy
result. Keep `merged`, `deployed`, and `adopted by running agents` separate.
Tell the parent which revision is available. Running agents synchronize at safe
boundaries, preserving local changes; do not reset their active worktrees or
restart unrelated sessions. Failed checks or missing credentials are explicit
blockers, not a successful publication.
