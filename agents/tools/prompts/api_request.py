"""Prompt for api_request tool."""

PROMPT = """Use this tool to call HTTP APIs and receive structured JSON or text responses.

Usage notes:
  - Pass the full absolute URL (https://...) and the HTTP method.
  - Include Authorization or API-key headers when the endpoint requires them.
  - Use grep first when credentials or tokens are stored in the user's local data.
  - For HTML pages, prefer web_fetch. For REST/JSON APIs, prefer api_request.
  - Paginate by calling api_request multiple times when an API returns partial results.
"""
