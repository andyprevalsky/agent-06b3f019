"""Team context is current, account-scoped metadata across root/explore starts."""

import json

import httpx
from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock


async def test_root_context_drops_revoked_map_on_cache_hit():
    from helpers.get_user_context import fetch_user_context, _user_context_cache

    current = True

    def handler(request):
        if request.url.path == "/api/data/team-context":
            return httpx.Response(
                200,
                json={
                    "you": {"userId": "reader", "email": "SECRET"},
                    "teams": [{"id": "team-1", "name": "Atlas", "role": "MEMBER"}] if current else [],
                    "accounts": [
                        {
                            "teamId": "team-1",
                            "ownerUserId": "owner-2",
                            "accountId": "work@example.test",
                            "provider": "gmail",
                            "password": "SECRET",
                        }
                    ],
                    "projects": [
                        {
                            "projectId": "project-1",
                            "teamId": "team-1",
                            "ownerUserId": "owner-2",
                            "name": "Launch",
                            "env": "SECRET",
                        }
                    ],
                    "projectAgents": [
                        {"id": "agent-shared", "title": "Review", "goal": "SECRET", "status": "COMPLETED"}
                    ],
                },
            )
        if request.url.path == "/api/integrations":
            return httpx.Response(200, json={"integrations": []})
        if request.url.path == "/api/user-settings":
            return httpx.Response(200, json={"name": "Reader"})
        if request.url.path == "/api/data/snapshot":
            return httpx.Response(200, json={"snapshot": {}})
        return httpx.Response(200, json={"people": [], "messages": []})

    _user_context_cache.clear()
    setup_mock_fn(handler)
    first = await fetch_user_context("reader")
    assert "Atlas" in first and "work@example.test" in first and "project-1" in first
    assert '"you": {"userId": "reader"}' in first
    # list_agents covers project agents; the context carries no agent preview.
    assert "agent-shared" not in first and "projectAgents" not in first
    assert "SECRET" not in first
    assert (
        "grep and list_agents cover this shared data; filter by owner_user_id, team_id, account_id or project_id. "
        "Shared bank transactions need an explicit owner_user_id or team_id. "
        "Use exact ids; never guess identities."
    ) in first
    assert "scope" not in first and "shared_project_agents" not in first
    current = False
    second = await fetch_user_context("reader")
    assert "Atlas" not in second and "work@example.test" not in second and "Reader" in second
    _user_context_cache.clear()


async def test_explore_inventory_refreshes_revoked_grant():
    from domains.grep.repo import fetch_local_data_summary

    current = True

    def handler(request):
        assert json.loads(request.content)["sources"] == ["summary"]
        return httpx.Response(
            200, json={"message": "Atlas work@example.test" if current else "No local data available."}
        )

    setup_mock_fn(handler)
    assert "Atlas" in await fetch_local_data_summary("reader")
    current = False
    assert "Atlas" not in await fetch_local_data_summary("reader")


async def test_owner_self_grep_still_gates_own_connector():
    from domains.grep.service import execute_grep

    probed = []

    async def execute(activity, *args, **kwargs):
        from domains.grep.service import source_status_activity

        if activity is source_status_activity:
            probed.append(kwargs["args"][1])
            return [{"source": "email", "connected": True}]
        return {"matches": [], "total_matches": 0, "truncated": False}

    await execute_grep(
        execute_activity=execute,
        tool_call={"tool": "grep", "sources": ["email"], "pattern": "investor", "owner_user_id": "reader"},
        tool_call_id="call",
        agent_id="agent",
        user_id="reader",
    )
    assert probed == [["email"]]


async def test_shared_grep_preserves_filters_and_does_not_gate_personal_connector():
    from domains.grep.service import execute_grep, source_status_activity

    calls = []

    async def execute(activity, *args, **kwargs):
        calls.append((activity, kwargs["args"]))
        if activity is source_status_activity:
            return [{"source": "email", "connected": False}]
        return {"matches": [], "total_matches": 0, "truncated": False}

    await execute_grep(
        execute_activity=execute,
        tool_call={
            "tool": "grep",
            "sources": ["email"],
            "pattern": "investor",
            "team_id": "team-1",
            "owner_user_id": "owner-2",
            "account_id": "work@example.test",
        },
        tool_call_id="call",
        agent_id="agent",
        user_id="reader",
    )
    from domains.grep.repo import grep_activity

    assert source_status_activity not in [activity for activity, _ in calls], "shared account must not gate"
    payload = next(args[0] for activity, args in calls if activity is grep_activity)
    assert payload["account_id"] == "work@example.test"
    assert payload["team_id"] == "team-1" and payload["owner_user_id"] == "owner-2"


async def test_shared_integration_sources_do_not_gate_personal_connectors():
    """Shared WhatsApp, LinkedIn, meeting notes and bank logins reach the backend without a connector probe."""
    from domains.grep.repo import grep_activity
    from domains.grep.service import execute_grep, source_status_activity

    cases = [
        ({"sources": ["whatsapp"], "account_id": "whatsapp"}, "whatsapp"),
        ({"sources": ["messages"], "account_id": "linkedin"}, "linkedin"),
        (
            {
                "sources": ["documents"],
                "document_source": "granola",
                "account_id": "granola",
                "require_source_access": True,
            },
            "granola",
        ),
        (
            {
                "sources": ["documents"],
                "document_source": "fireflies",
                "account_id": "fireflies",
                "require_source_access": True,
            },
            "fireflies",
        ),
        ({"sources": ["transactions"], "account_id": "item-chase"}, "item-chase"),
    ]
    for extra, account in cases:
        calls = []

        async def execute(activity, *args, **kwargs):
            calls.append((activity, kwargs["args"]))
            if activity is source_status_activity:
                return [{"source": account, "connected": False}]
            return {"matches": [], "total_matches": 0, "truncated": False}

        await execute_grep(
            execute_activity=execute,
            tool_call={"tool": "grep", "pattern": "launch", "owner_user_id": "owner-2", **extra},
            tool_call_id="call",
            agent_id="agent",
            user_id="reader",
        )
        activities = [activity for activity, _ in calls]
        assert source_status_activity not in activities, f"shared {account} must not probe the reader's connector"
        payload = next(args[0] for activity, args in calls if activity is grep_activity)
        assert payload["owner_user_id"] == "owner-2" and payload["account_id"] == account


async def test_team_map_keeps_account_labels_and_drops_secrets():
    from helpers.team_context import format_team_context

    text = format_team_context(
        {
            "you": {"userId": "reader"},
            "teams": [{"id": "team-1", "name": "Atlas", "role": "MEMBER"}],
            "accounts": [
                {
                    "teamId": "team-1",
                    "ownerUserId": "owner-2",
                    "provider": "plaid",
                    "accountId": "item-chase",
                    "label": "Chase",
                    "accessToken": "SECRET",
                },
                {
                    "teamId": "team-1",
                    "ownerUserId": "owner-2",
                    "provider": "github_repo",
                    "accountId": "gh:acme/app",
                    "label": "gh:acme/app",
                },
            ],
            "projects": [],
        }
    )
    assert '"label": "Chase"' in text and '"accountId": "item-chase"' in text and "gh:acme/app" in text
    assert "SECRET" not in text and "accessToken" not in text


async def run_all_tests():
    result = BlackboxResult()
    for name, fn in [
        ("root_revocation_on_cached_base", test_root_context_drops_revoked_map_on_cache_hit),
        ("explore_revocation", test_explore_inventory_refreshes_revoked_grant),
        ("shared_filter_transport", test_shared_grep_preserves_filters_and_does_not_gate_personal_connector),
        ("owner_self_gates_own_connector", test_owner_self_grep_still_gates_own_connector),
        ("shared_integration_sources_ungated", test_shared_integration_sources_do_not_gate_personal_connectors),
        ("team_map_labels_no_secrets", test_team_map_keeps_account_labels_and_drops_secrets),
    ]:
        await result.record_async(name, fn)
        teardown_mock()
    return result.all_passed
