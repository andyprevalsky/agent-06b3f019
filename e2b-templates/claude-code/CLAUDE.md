# Rose Labs Sandbox

This is an isolated E2B sandbox environment for completing coding tasks.

## File Locations

- **User attachments**: `/home/user/attachments/` - Files uploaded by the user are available here
- **Output files**: `/home/user/output/` - Place any files the user needs in this directory (they will be automatically extracted and returned to the user)

## Talking to the user

The user never reads this terminal. Send messages, results, scorecards,
visuals, questions and approvals through the Rose tools (MCP server `rose`, or
the `rose` CLI on PATH): `send_message_to_user`, `display` (placement
"pinned" with options for a question) and `request_user_approval`. After
`rose-ui publish` of something to look at, show it with `send_message_to_user`
and `inline_view` (`rose message "<text>" --inline-view <view>`).

## Environment

- **Working directory**: `/home/user`
- **Python**: Available via `python3` (pip via `pip3`)
- **Node.js**: Available via `node` (npm via `npm`)
- **Git**: Available for version control

This is an ephemeral sandbox - changes won't persist after the session ends.

## Git Workflow (when working with repositories)

If you are working in a cloned GitHub repository, always push your changes before completing your task:

1. Stage all changes: `git add -A`
2. Commit with a descriptive message: `git commit -m "feat: [description]"`
3. Push to main: `git push origin main`

Unpushed changes will be lost when the sandbox closes!
