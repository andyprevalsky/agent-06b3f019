"""Prompt for the display tool."""

PROMPT = """Use this tool to show the user images, videos or HTML pages (screenshots, recordings, charts, previews) inline in this conversation.

Usage:
- `paths` are files already in this agent's tree; `urls` are public links. Showing the same file again does nothing.
- placement "pinned" asks a question above the user's input box with numbered `options` and waits for the answer. Use it only when you cannot proceed without the user's choice; the answer is the tool result."""
