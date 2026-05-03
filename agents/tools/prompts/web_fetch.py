"""Prompt for web_fetch tool."""

PROMPT = """Fetches a specific URL with JavaScript rendering and extracts content focused on an objective.

Usage:
- Use when you already know the URL and need its content (article, doc page, listing).
- Use when web_search snippets are insufficient and you need full or focused page text.
- Use download_files to auto-pull file artifacts (PDF/CSV/XLSX) discovered on the page.
- excerpts and full_content are mutually exclusive; full_content overrides excerpts when both true.
- Do not use this when you have no URL yet - use web_search first.
- Do not use this for stateful page interaction (login, forms, click flows) - use spawn_browser_agent.

CRITICAL REQUIREMENT - You MUST follow this:
  - Every claim derived from this fetch MUST cite the source URL.
  - When reporting findings to the user or to a parent agent, include a "Sources:" section
    listing the fetched URL as a markdown hyperlink: [Title](URL).
  - This is MANDATORY - never skip the source citation.
  - Quotes, numbers, and specific facts not present verbatim in the page content are
    fabrication and will cause the verifier to reject your answer.
"""
