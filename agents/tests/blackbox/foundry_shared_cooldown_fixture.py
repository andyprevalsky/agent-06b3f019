"""One agent worker process for compute-token-authority.blackbox.ts (Foundry part).

Runs the real ``foundry_complete`` once against a fake Azure Foundry region
whose two deployments are served in-process, while every backend call (the
shared cooldown read and the rate-limit mark) goes over real HTTP to the guest
backend in ``BACKEND_API_URL``.

    python foundry_shared_cooldown_fixture.py reject   # first deployment -> in-stream 429
    python foundry_shared_cooldown_fixture.py observe  # every deployment would serve

Run with ``PYTHONPATH=agents``. Prints one JSON line: ``{"hits": [deployment, ...], "served": deployment}``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types
from unittest.mock import patch

import httpx

from providers.rose import foundry
from providers.rose.pools import foundry_model, get_pool

ROUTE_KEY = "foundry-shared-cooldown-route"
FOUNDRY_HOST = "foundry-cta.example.test"

_COMPLETED = (
    "event: response.output_text.delta\n"
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    "event: response.completed\n"
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n'
    "data: [DONE]\n\n"
)
# Azure's in-stream token-rate rejection carries no retry advice.
_RATE_LIMITED = (
    "event: response.failed\n"
    'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded",'
    '"message":"Requests to the Responses API have exceeded token rate limit."}}}\n\n'
)


async def main(phase: str) -> None:
    model = foundry_model(get_pool("rose-1-ultra"))
    deployments = [f"{model}-a", f"{model}-b"]
    env = {
        "AZURE_FOUNDRY_ENDPOINT": f"https://{FOUNDRY_HOST}",
        "AZURE_FOUNDRY_API_KEY": "fixture-key",
        "AZURE_FOUNDRY_DEPLOYMENTS": ",".join(deployments),
        "BACKEND_API_URL": os.environ["BACKEND_API_URL"],
        "BACKEND_API_KEY": os.environ["BACKEND_API_KEY"],
    }
    hits: list[str] = []
    real_transport = httpx.AsyncHTTPTransport()
    # The deployment this route key tries first is the one that rejects.
    with patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))):
        first = foundry._route_plan(foundry.foundry_regions(), (model,), ROUTE_KEY)[0][1]

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host != FOUNDRY_HOST:
            return await real_transport.handle_async_request(request)
        deployment = json.loads(request.content)["model"]
        hits.append(deployment)
        body = _RATE_LIMITED if phase == "reject" and deployment == first else _COMPLETED
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())

    real_client = httpx.AsyncClient
    module_httpx = types.SimpleNamespace(
        AsyncClient=lambda **kw: real_client(**kw, transport=httpx.MockTransport(handler), trust_env=False),
        Timeout=httpx.Timeout,
        Headers=httpx.Headers,
        TransportError=httpx.TransportError,
    )
    served = None
    with (
        patch.object(foundry, "httpx", module_httpx),
        patch.object(foundry, "os", types.SimpleNamespace(environ=env, getenv=lambda k, v=None: env.get(k, v))),
    ):
        async def invoke() -> None:
            nonlocal served
            async for chunk in foundry.foundry_complete(
                pool_spec=get_pool("rose-1-ultra"),
                messages=[{"role": "user", "content": "hi"}],
                response_format=None,
                tools=None,
                context_tools=None,
                tool_choice=None,
                temperature=None,
                effort=None,
                speed="fast",
                request_id=f"foundry-shared-cooldown-{phase}",
                route_key=ROUTE_KEY,
                agent_id=None,
                call_site="test",
                cache_namespace="foundry-shared-cooldown",
                ttft_timeout_s=30,
                idle_timeout_s=30,
            ):
                if chunk.kind == "metadata" and served is None:
                    served = hits[-1] if hits else None
        if phase == "warm":
            await invoke()
            hits.clear()
            served = None
            print(json.dumps({"ready": True}), flush=True)
            await asyncio.to_thread(sys.stdin.readline)
        await invoke()
    await real_transport.aclose()
    print(json.dumps({"first": first, "hits": hits, "served": served or (hits[-1] if hits else None)}))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
