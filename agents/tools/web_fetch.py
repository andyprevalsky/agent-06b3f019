"""Web fetch tool — re-export shim.

All business logic lives in domains/web_fetch/. This file re-exports public
symbols so that existing callers (workflow sandbox, tests, spawn_agent) continue
to resolve without import changes.
"""

from domains.web_fetch.handler import (  # noqa: F401
    WebFetchManager,
    get_manager,
    web_fetch,
    web_fetch_activity,
    web_fetch_download_activity,
)
