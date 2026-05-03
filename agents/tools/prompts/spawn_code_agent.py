"""Prompt for spawn_code_agent (planner alias)."""

PROMPT = """Spawns a coding sub-agent in an ephemeral E2B sandbox for code execution, data processing, or file generation.

Usage:
- Use for one focused task that completes under 10 minutes; sandboxes are ephemeral and may die.
- goal must be self-contained and at least 50 characters (validator-enforced).
- Set output_schema fields to type='file_pointer' or 'list[file_pointer]' for generated files; type='str' will not transfer files out.
- Pass github_repo_link to clone an existing repo into the sandbox.
- Do not use for long-running sessions; decompose into smaller agents instead.
- Do not use when research (spawn_explore_agent) or browser automation (spawn_browser_agent) fits better."""
