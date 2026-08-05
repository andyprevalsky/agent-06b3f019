"""Shared source_connect gate raising.

Lives in utils because both spawn_agent and wait_for raise these gates; a
direct cross-domain import of the private helper violated the layering rule
and the structural guard that enforces it.
"""

from typing import Dict, List

from temporalio import workflow

from tools.gate import GateRejectedError, build_source_connect_gate, raise_gate_direct


async def raise_source_connect_gates(workflow_instance, unavailable_sources: List[Dict]) -> None:
    """Raise a blocking source_connect gate for each unavailable data source.

    Runs in workflow context (has ``_handle_tool_event``/``_signal_responses``),
    mirroring the subscription gate in spawn_browser_agent_v3. A declined gate
    is swallowed — the explore already failed, so the main agent reports the gap.
    """
    # Gates are keyed by connector, and several sources can share one (email +
    # gmail -> one Gmail gate). The backend only dedups requests that are still
    # unanswered, so once the first gate resolves a repeated connector would
    # raise a second gate and park the workflow on another OAuth callback that
    # is never coming. Dedup here, where the whole batch is visible.
    seen_connectors: set[str] = set()
    for status in unavailable_sources:
        if not isinstance(status, dict):
            continue
        source = str(status.get("source") or "")
        if not source:
            continue
        connector = str(status.get("connector") or source)
        if connector in seen_connectors:
            continue
        seen_connectors.add(connector)
        connect_url = str(status.get("connectUrl") or "")
        pretty = connector.replace("_", " ").title()
        # Key the gate by the CONNECTOR, not the raw grep source. The OAuth
        # callback resolves `source_connect:<providerKey>` (e.g. "gmail"), so a
        # gate keyed on the source alias ("email") would never auto-resolve and
        # the workflow would park forever. Connector-keying also dedups sources
        # that share one connector (email + gmail → one Gmail gate).
        gate = build_source_connect_gate(
            connector,
            f"Connect {pretty} so Rose can use your {source}",
            f"This task needs your {source} data, but {pretty} isn't connected yet — "
            "tap to connect and I'll pick right back up.",
            connect_url,
        )
        try:
            await raise_gate_direct(workflow_instance, gate, gate_key=f"source_connect:{connector}")
        except GateRejectedError:
            workflow.logger.info(f"[source_connect] gate declined for {connector}")
