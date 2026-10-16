"""Invoke the production worker producer against the owning local HTTP suite."""

import asyncio
import json
import sys

import httpx

from domains.gate.repo import create_gate_request_activity
from domains.gate.service import build_subscription_gate
from domains.request_user_approval.repo import create_approval_request_activity


async def main():
    operation, user_id, agent_id, workflow_id = sys.argv[1:]
    try:
        if operation == "gate":
            request_id = await create_gate_request_activity(
                user_id,
                agent_id,
                workflow_id,
                "Subscribe to continue",
                build_subscription_gate(),
                "subscription",
            )
        else:
            request_id = await create_approval_request_activity(
                user_id, agent_id, workflow_id, "Approve this action?"
            )
        print(json.dumps({"request_id": request_id, "status": 200}))
    except httpx.HTTPStatusError as error:
        print(json.dumps({"status": error.response.status_code}))


if __name__ == "__main__":
    asyncio.run(main())
