"""Prompt for spawn_code_agent (planner alias)."""

PROMPT = (
    "Coding agent in ephemeral E2B sandbox. Optional github_repo_link."
    " Each agent = ONE focused task under 10 minutes. Sandboxes are ephemeral and can die"
    " on long-running sessions. Use type='file_pointer' in output_schema for generated files."
)
