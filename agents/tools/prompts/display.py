"""Prompt for the display tool."""

PROMPT = """Use this tool to show the user images, videos or HTML pages (screenshots, recordings, charts, previews) inline in this conversation.

Usage:
- `paths` are files already in this agent's tree; `urls` are public links. Showing the same file again does nothing.
- placement "pinned" asks a question with numbered `options`. Use it only when you cannot proceed without the choice. If you are the root agent or the root started you, it is pinned above the user's input box and the answer is the tool result; otherwise the agent that started you gets the question and answers by message."""
