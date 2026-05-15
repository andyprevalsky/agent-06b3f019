"""Prompt for web_fetch tool."""

PROMPT = """Use this tool to fetch a URL with JavaScript rendering, then have a small fast model produce an objective-focused summary of the page and pick which of the page's links should be downloaded as file attachments.

Usage notes:
  - The URL must be a fully-formed valid URL.
  - The objective should describe what information you want from the page.
  - If you need files (PDFs, CSVs, spec sheets, etc.), state it explicitly in the objective, e.g. 'extract the membership PDFs', 'download the spec sheet'. The small model only downloads what the objective justifies; it will NOT grab arbitrary files just because they exist on the page.
  - Downloaded files are returned as attachments referenceable by original_filename when you spawn a sub-agent.
  - Results may be truncated if the page is very large; the truncation is marked in the summary.
  - For GitHub repository work, prefer spawn_code_agent (the sandbox already has gh installed).
"""
