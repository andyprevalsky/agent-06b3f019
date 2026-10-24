"""Prompt for the display tool.

``PROMPT`` is the stock prompt. ``PROMPT_ROSE_DESKTOP`` (Rose Desktop accounts,
``utils.rose_desktop``) adds the Agent Display panel note. Both are inline media
only: display never asks the user a question.
"""

_INTRO_AND_USAGE = """Use this tool to show the user images, videos or HTML pages (screenshots, recordings, charts, previews) inline in this conversation.

Usage:
- `paths` are files already in this agent's tree; `urls` are public links; `html` is a page you write yourself, such as a chart or scorecard. Showing the same content again does nothing."""

PROMPT = _INTRO_AND_USAGE

PROMPT_ROSE_DESKTOP = (
    _INTRO_AND_USAGE
    + """
- The tool is named display; Agent Display is the panel where the user views interactive outputs. Do not look for a separate agent_display tool."""
)
