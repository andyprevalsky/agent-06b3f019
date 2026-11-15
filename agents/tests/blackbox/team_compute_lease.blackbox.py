"""Blackbox: a teammate's shared compute lease (source "team") end to end in the worker.

    GET /api/integrations/compute-code/credentials/token  ──▶ {source: "team", integrationId, ownerUserId}
        ──▶ fetch_compute_token_activity ──▶ _build_compute_auth_context
        ──▶ rotation-capable context (source "team"), never a bare token
        ──▶ a cooldown / auth report names the caller and the shared row
            (POST /api/integrations/compute-code/token/rate-limited), so the
            backend backs off exactly the owner's shared subscription.

Real activity code; only the backend HTTP is mocked.
"""

import asyncio
import json

import httpx
from _test_utils import BlackboxResult, set_mock_handler, teardown_mock


def _backend(lease: dict, posted: list):
    def handler(req):
        url = str(req.url)
        if "compute-code/credentials/token" in url:
            return httpx.Response(200, json=lease)
        if "compute-code/token/rate-limited" in url:
            posted.append(json.loads(req.content))
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(500, text="unexpected route")

    return handler


async def test_team_lease_reports_the_shared_row_for_the_caller():
    from helpers.llm import _build_compute_auth_context, credential_fingerprint, fetch_compute_token_activity
    from providers.rose.types import ClaudeAuthContext, GptAuthContext

    for token_type, context_type in (("claude", ClaudeAuthContext), ("gpt", GptAuthContext)):
        posted: list = []
        token = f"{token_type}-owner-shared-token"
        set_mock_handler(
            _backend(
                {
                    "type": token_type,
                    "accessToken": token,
                    "accountId": "acct-owner" if token_type == "gpt" else None,
                    "source": "team",
                    "integrationId": "integration-owner-shared",
                    "ownerUserId": "owner-user",
                    "teamId": "team-1",
                    "lineageKey": "lineage-team",
                },
                posted,
            )
        )
        lease = await fetch_compute_token_activity("reader-user", lineage_key="lineage-team", agent_id="agent-r")
        assert lease is not None and lease["source"] == "team", lease
        assert lease["integrationId"] == "integration-owner-shared", lease
        ctx = _build_compute_auth_context(lease, "reader-user", agent_id="agent-r")
        assert isinstance(ctx, context_type), f"{token_type}: {ctx!r}"
        assert ctx.source == "team" and ctx.user_id == "reader-user", ctx
        assert ctx.mark_rate_limited is not None, "a team lease must stay rotation-capable"
        assert ctx.pool_token_id is None, "a team lease is not a pool token"

        assert await ctx.mark_rate_limited(ctx, 60, None, "rate_limit")
        assert len(posted) == 1, posted
        body = posted[0]
        assert body["type"] == token_type and body["source"] == "team", body
        assert body["userId"] == "reader-user", body
        assert body["integrationId"] == "integration-owner-shared", body
        assert "poolTokenId" not in body, body
        assert body["credential"] == credential_fingerprint(token), body
        assert token not in json.dumps(body), "the report never carries the credential itself"


async def test_user_and_pool_reports_are_unchanged():
    from helpers.llm import _build_compute_auth_context

    for source, expected in (
        ("user", {"userId": "reader-user", "integrationId": "integration-own"}),
        ("pool", {"poolTokenId": "pool-1"}),
    ):
        posted: list = []
        set_mock_handler(_backend({}, posted))
        ctx = _build_compute_auth_context(
            {
                "type": "claude",
                "accessToken": f"{source}-token",
                "source": source,
                "poolTokenId": "pool-1" if source == "pool" else None,
                "integrationId": "integration-own" if source == "user" else "pool-1",
                "lineageKey": "lineage-x",
            },
            "reader-user",
        )
        assert ctx is not None and ctx.source == source
        assert await ctx.mark_rate_limited(ctx, 60, None, "rate_limit")
        body = posted[0]
        for key, value in expected.items():
            assert body.get(key) == value, (source, body)
        if source == "pool":
            assert "integrationId" not in body and "userId" not in body, body


async def run_all_tests():
    print("team-compute-lease blackbox tests:")
    r = BlackboxResult()
    await r.record_async("team_lease_reports_shared_row", test_team_lease_reports_the_shared_row_for_the_caller)
    await r.record_async("user_and_pool_reports_unchanged", test_user_and_pool_reports_are_unchanged)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
