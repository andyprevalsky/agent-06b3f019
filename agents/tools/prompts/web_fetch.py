"""Prompt for web_fetch tool."""

PROMPT = """Fetch and extract content from a URL with JavaScript rendering support. Use when you need to read page content, find specific information, or analyze web pages.

Set download_files to a list of extensions (e.g. ["pdf", "csv"]) to automatically download files of those types found on the page.

WHEN NOT TO USE:
- Do NOT use for general research - use spawn_agent(type="explore") which combines search + fetch intelligently.
- Do NOT use to re-download files already in context as file_pointers.

RETURNS: Extracted content (excerpts aligned to objective, or full page content). If download_files specified, also returns file_pointer objects for downloaded files."""
