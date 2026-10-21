"""Prompt for inspect_code tool."""

PROMPT = """Ask a read-only code agent about code a code agent produced.

- It restores that code session's latest checkpoint into a separate sandbox, reads files and git history, may run tests, and answers with file:line citations.
- It never changes the session: nothing it does is committed, pushed or kept.
- Each call starts a sandbox; ask one complete question rather than many small ones."""
