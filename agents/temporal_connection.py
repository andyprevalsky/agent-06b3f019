"""Temporal client security options shared by workers and benchmark cleanup."""

from __future__ import annotations

from typing import Any

from temporalio.client import TLSConfig


def is_local_temporal_address(address: str) -> bool:
    """Return whether an address targets a loopback Temporal dev server."""
    normalized = address.strip().lower()
    if normalized == "::1":
        return True
    host = normalized.rsplit(":", 1)[0].strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"}


def temporal_connect_options(address: str, namespace: str, api_key: str) -> dict[str, Any]:
    """Build TLS/auth options for local Temporal or Temporal Cloud."""
    if is_local_temporal_address(address):
        return {"namespace": namespace, "tls": False}
    return {
        "namespace": namespace,
        "tls": TLSConfig(client_cert=None, client_private_key=None),
        "rpc_metadata": {
            "temporal-namespace": namespace,
            "Authorization": f"Bearer {api_key}",
        },
    }
