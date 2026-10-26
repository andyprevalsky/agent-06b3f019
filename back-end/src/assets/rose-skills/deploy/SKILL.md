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

Branch joining is a separate operation. If the repository lacks a branch-join
skill, create one using its Git rules and relevant validation commands; do not
run this deploy workflow as the fallback. Only the top-level publication owner
uses deploy to publish the integrated result to the shared branch.

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

## Required publication gate

Publication is allowed only through this skill and the repository workflow it
selects. Complete the required validation and approval steps before the merge
step; verify the destination afterward. Reading or creating a skill file is
not execution of the skill.

Return a completion receipt naming the skill used, source commit, target branch,
resulting commit, and check results with their evidence. Include the deployment
outcome for deploy, or the verified parent update for branch-join. Do not claim
publication until the applicable skill has completed and those facts are
verified. A failed or unrun requirement leaves publication pending. The parent
must verify the receipt against GitHub/check evidence instead of accepting a
child's success statement alone.
