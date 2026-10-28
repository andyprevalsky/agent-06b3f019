# Rose Labs Sandbox

This is an isolated E2B sandbox environment for completing coding tasks.

## File Locations

- **User attachments**: `/home/user/attachments/` - Files uploaded by the user are available here
- **Output files**: `/home/user/output/` - Place any files the user needs in this directory (they will be automatically extracted and returned to the user)

## Rose skills

The user never reads this terminal. How to reach them, the other agents and
your branch rules are Rose skills in `~/.rose/skills`. Your instructions
list the skills this session has.

Rose skills (read ~/.rose/skills/<name>/SKILL.md before using one):
- agent-graph: Use to list, message or search the other agents in your tree (the agent that started you, the root agent, siblings, children).
- branch-join: Use when an independent nested agent must integrate its work into its immediate parent's assigned branch.
- change-environment-size: Use when real work needs more or less CPU or memory (repeated OOM kills, heavy swap, slow CPU-bound builds or tests). Not for runaway processes.
- code-session: Use when you work in a repository (branches, commits, merges) and to know what survives a pause, a retry or a usage limit.
- deploy: Use to publish changes through a repository's deploy workflow, or create a missing repo-local deploy skill.
- talk-to-user: Use when the user should see something (updates, results, files, visuals, video). They never read your terminal.

## Environment

- **Working directory**: `/home/user`
- **Python**: Available via `python3` (pip via `pip3`)
- **Node.js**: Available via `node` (npm via `npm`)
- **Git**: Available for version control

This sandbox is persistent: your files, local commits and conversation are kept between sessions (the sandbox pauses instead of being deleted).

## Git Workflow (when working with repositories)

- You work on your own branch, named in your instructions with its merge target.
- Commit, merge and branch rules are in the code-session skill: read it before you commit or merge.
