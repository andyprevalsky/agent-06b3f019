"""Prompt for the display tool.

``PROMPT`` is the stock prompt (inline media only). ``PROMPT_ROSE_DESKTOP``
(Rose Desktop accounts, ``utils.rose_desktop``) adds pinned questions, which
only the Rose Desktop UI shows above the query box.
"""

_INTRO_AND_USAGE = """Use this tool to show the user images, videos or HTML pages (screenshots, recordings, charts, previews) inline in this conversation.

Usage:
- `paths` are files already in this agent's tree; `urls` are public links; `html` is a page you write yourself, such as a chart or scorecard. Showing the same content again does nothing."""

PROMPT = _INTRO_AND_USAGE

PROMPT_ROSE_DESKTOP = (
    _INTRO_AND_USAGE
    + """
- placement "pinned" asks a question with numbered `options`. Use it only when you cannot proceed without the choice. If you are the root agent or the root started you, it is pinned above the user's input box and the answer is the tool result; otherwise the agent that started you gets the question and answers by message.
- The tool is named display; Agent Display is the panel where the user views interactive outputs. Do not look for a separate agent_display tool."""
)
