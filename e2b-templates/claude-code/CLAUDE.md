# Rose Labs Sandbox

This is an isolated E2B sandbox environment for completing coding tasks.

## File Locations

- **User attachments**: `/home/user/attachments/` - Files uploaded by the user are available here
- **Output files**: `/home/user/output/` - Place any files the user needs in this directory (they will be automatically extracted and returned to the user)

## Environment

- **Working directory**: `/home/user`
- **Python**: Available via `python3` (pip via `pip3`)
- **Node.js**: Available via `node` (npm via `npm`)
- **Git**: Available for version control

This sandbox is persistent: your files, local commits and conversation are kept between sessions (the sandbox pauses instead of being deleted).

## Git Workflow (when working with repositories)

- You work on your own branch (named in your instructions). Sub-agents branch from their parent's branch and merge back into it.
- Commit locally whenever a unit of work is complete. Commits are your checkpoints.
- Merge into your merge target (your parent's branch, or the default branch for a new agent) when other agents or the user need your changes. Otherwise keep the work on your branch.
- You decide when to commit, push and merge, based on the task.
