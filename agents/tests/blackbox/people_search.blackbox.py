"""People search through Lantern, including legacy activity payloads."""

import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)

LANTERN_URL = "people.lantern.md/v1/operations/"


def _fake_config(token="lantern-test-token", api_url="https://people.lantern.md"):
    return SimpleNamespace(
        lantern=SimpleNamespace(api_token=token, api_url=api_url),
        backend=SimpleNamespace(api_key="rose-test-key", api_url="http://localhost:3001"),
    )


def _people(n=3):
    return [
        {
            "name": f"Jane Doe {i}",
            "linkedinUrl": f"https://www.linkedin.com/in/janedoe{i}",
            "title": "VP Engineering",
            "company": "Acme",
            "location": "Berlin",
            "summary": "Builds developer tools.",
            "sourceRecordId": f"record-{i}",
            "sourceRetrievedAt": "2026-10-13T12:00:00Z",
            "education": [{"school": "MIT", "degree": "BSc"}],
        }
        for i in range(n)
    ]


def _setup(data=None, *, status=200, error=None, operation="find_people"):
    teardown_mock()
    body = (
        {"ok": False, "error": error}
        if error
        else {"ok": True, "data": data if data is not None else {"people": _people()}}
    )
    setup_mock({LANTERN_URL + operation: {"status": status, "json": body}})


async def _run(*, query="developer tools", mode="discover", provider="lantern", config=None, **kwargs):
    from tools.people_search.handler import people_search_activity

    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.people_search.service.load_config", return_value=config or _fake_config()),
    ):
        return await people_search_activity(query=query, mode=mode, provider=provider, **kwargs)


def test_types_contracts_are_importable():
    from tools.people_search.types import ExecuteActivityCallable, PeopleSearchResult, PersonResult, PersonSource

    assert ExecuteActivityCallable is not None
    assert "provider" in PersonSource.__annotations__
    assert "source" in PersonResult.__annotations__
    assert "providers_attempted" in PeopleSearchResult.__annotations__


async def test_schema_defaults_and_pairing():
    from pydantic import ValidationError
    from utils.tool_schemas import PeopleSearchTool

    assert PeopleSearchTool(tool="people_search", query="founders", mode="discover").provider == "lantern"
    PeopleSearchTool(
        tool="people_search", query="Jane", mode="enrich", source_record_id="record-0", fields=["current_title"]
    )
    for kwargs, field in [(dict(mode="enrich", limit=5), "limit"), (dict(mode="discover", fields=["x"]), "fields")]:
        try:
            PeopleSearchTool(tool="people_search", query="query", **kwargs)
        except ValidationError as error:
            assert field in str(error)
        else:
            raise AssertionError(f"Expected validation error for {field}")


async def test_limit_clamp_discover():
    from tools.people_search.service import clamp_discover_limit

    assert [clamp_discover_limit(v) for v in (None, 0, 100, 7, "bad")] == [10, 1, 25, 7, 10]


async def test_discover_request_normalization_and_criteria():
    _setup({"people": _people(4), "nextCursor": "next-page", "warnings": ["Partial source coverage."]})
    criteria = {
        "location": "Berlin",
        "locationKind": "city",
        "countryCode": "DE",
        "titles": ["VP Engineering"],
        "companies": ["Acme"],
    }
    result = await _run(limit=2, search_options=criteria)
    call = assert_captured_call(url_contains=LANTERN_URL + "find_people", method="POST", header_present="authorization")
    assert json.loads(call["requestBody"]) == {
        "request": "developer tools",
        "limit": 2,
        "includeContacts": False,
        **criteria,
    }
    assert result["provider_used"] == "lantern"
    assert result["providers_attempted"] == ["lantern"]
    assert len(result["results"]) == 2
    person = result["results"][0]
    assert (person["name"], person["title"], person["company"], person["location"]) == (
        "Jane Doe 0",
        "VP Engineering",
        "Acme",
        "Berlin",
    )
    assert person["source"]["record_id"] == "record-0"
    assert person["source"]["retrieved_at"] == "2026-10-13T12:00:00Z"
    assert person["source"]["url"] == person["profile_url"]
    assert "attributes" not in person
    assert "Partial source coverage." in result["warnings"]
    assert result["next_cursor"] == "next-page"


async def test_enrich_by_id_preserves_fields_without_contact_reveals():
    _setup({"items": _people(1)}, operation="people_profiles_get")
    result = await _run(
        mode="enrich",
        fields=["current_title", "current_company", "linkedin_url", "education", "email"],
        search_options={"sourceRecordId": "record-0"},
    )
    call = assert_captured_call(url_contains=LANTERN_URL + "people_profiles_get", method="POST")
    assert json.loads(call["requestBody"]) == {"ids": ["record-0"]}
    assert len(result["results"]) == 1
    attrs = result["results"][0]["attributes"]
    assert attrs["current_title"] == "VP Engineering"
    assert attrs["current_company"] == "Acme"
    assert attrs["linkedin_url"] == "https://www.linkedin.com/in/janedoe0"
    assert attrs["education"] == [{"school": "MIT", "degree": "BSc"}]
    assert attrs["email"] is None
    assert any("email" in warning for warning in result["warnings"])
    assert len(get_captured_requests()) == 1
    _setup({"items": _people(1)}, operation="people_profiles_get")
    assert "attributes" not in (await _run(mode="enrich", search_options={"sourceRecordId": "record-0"}))["results"][0]


async def test_exact_enrichment_missing_record_is_typed_error():
    from temporalio.exceptions import ApplicationError

    for options in ({"sourceRecordId": "record-missing"}, {"sourceRecordId": "record-missing", "generation": "g1"}):
        _setup({"items": []}, operation="people_profiles_get")
        try:
            await _run(mode="enrich", fields=["current_title"], search_options=options)
        except ApplicationError as error:
            assert error.type == "LanternPeopleError"
            assert error.non_retryable
            assert "SOURCE_RECORD_NOT_FOUND" in str(error)
        else:
            raise AssertionError("Exact-ID enrichment must reject HTTP200 items[] instead of empty success")
        calls = get_captured_requests()
        assert len(calls) == 1, "Missing exact records must not trigger retry or discovery fallback"
        payload = json.loads(calls[0]["requestBody"])
        assert payload["ids"] == ["record-missing"]
        assert payload.get("generation") == options.get("generation")


async def test_missing_enrichment_manager_reports_error_without_query_charge():
    from temporalio.exceptions import ApplicationError
    from tools.people_search.handler import people_search

    _setup({"items": []}, operation="people_profiles_get")
    messages = []

    async def execute(activity_fn, *args, **kwargs):
        if activity_fn.__name__ == "people_search_activity":
            with (
                patch("temporalio.activity.heartbeat"),
                patch("tools.people_search.service.load_config", return_value=_fake_config()),
            ):
                return await activity_fn(*kwargs["args"])
        if activity_fn.__name__ == "post_agent_message":
            messages.append(kwargs["args"])

    try:
        await people_search(
            execute_activity=execute,
            tool_call={"query": "missing person", "mode": "enrich", "source_record_id": "record-missing"},
            tool_call_id="missing-enrich",
            agent_id="agent-missing-enrich",
            user_id="user-1",
        )
    except ApplicationError as error:
        assert "SOURCE_RECORD_NOT_FOUND" in str(error)
        assert error.non_retryable
    else:
        raise AssertionError("Missing enrichment must fail before returning billable success usage")
    assert len(get_captured_requests()) == 1
    assert len(messages) == 2
    assert messages[-1][3]["toolStatus"] == "ERROR"
    assert all(message[3]["toolStatus"] != "FINISHED" for message in messages)
    assert "SOURCE_RECORD_NOT_FOUND" in messages[-1][1]
    assert "**Cost:** $0.0000" in messages[-1][1]


async def test_enrich_does_not_pick_an_ambiguous_first_match():
    from temporalio.exceptions import ApplicationError

    _setup({"people": _people(1)})
    try:
        await _run(mode="enrich")
    except ApplicationError as error:
        assert "PERSON_RESOLUTION_REQUIRED" in str(error)
    else:
        raise AssertionError("Even a single keyword match requires exact identity for enrichment")


async def test_exact_enrichment_rejects_search_constraints():
    from temporalio.exceptions import ApplicationError

    for options in (
        {"sourceRecordId": "record-0", "companies": ["Other employer"]},
        {"sourceRecordId": "record-0", "location": "Other city"},
    ):
        _setup({"items": _people(1)}, operation="people_profiles_get")
        try:
            await _run(mode="enrich", search_options=options)
        except ApplicationError as error:
            assert "INVALID_SEARCH_OPTIONS" in str(error)
        else:
            raise AssertionError("Exact profile lookup must not silently discard constraints")
        assert get_captured_requests() == []


async def test_manager_preserves_provider_recovery_details():
    from temporalio.exceptions import ApplicationError
    from tools.people_search.handler import people_search
    from tools.people_search.repo import lantern_error
    from utils.error_utils import extract_error_message

    calls = []

    async def execute(activity_fn, *args, **kwargs):
        calls.append({"activity": activity_fn.__name__, "kwargs": kwargs})
        if activity_fn.__name__ == "people_search_activity":
            raise lantern_error("RATE_LIMITED", {"retryAfterSeconds": 30, "candidates": [{"entityId": "fiber:123"}]})

    try:
        await people_search(
            execute_activity=execute,
            tool_call={"query": "founders", "mode": "discover"},
            tool_call_id="tc",
            agent_id="agent",
        )
    except ApplicationError as error:
        model_error = extract_error_message(error)
        assert "retryAfterSeconds" in model_error and "30" in model_error
        assert "fiber:123" in model_error
    else:
        raise AssertionError("Expected provider rejection")
    event = [call for call in calls if call["activity"] == "post_agent_message"][-1]
    displayed = str(event["kwargs"]["args"])
    assert "retryAfterSeconds" in displayed and "fiber:123" in displayed


async def test_exact_profile_identity_and_nested_attributes():
    from temporalio.exceptions import ApplicationError

    row = _people(1)[0]
    education = row.pop("education")
    row["profile"] = {"education": education, "summary": "Full source summary."}
    row["employment"] = [{"company": "Acme", "title": "VP Engineering", "isCurrent": True}]
    _setup({"items": [row]}, operation="people_profiles_get")
    result = await _run(
        mode="enrich", search_options={"sourceRecordId": "record-0"}, fields=["education", "work_history"]
    )
    assert result["results"][0]["attributes"] == {"education": education, "work_history": row["employment"]}
    _setup({"items": [row]}, operation="people_profiles_get")
    try:
        await _run(mode="enrich", search_options={"sourceRecordId": "foreign-record"})
    except ApplicationError as error:
        assert "SOURCE_RECORD_MISMATCH" in str(error)
    else:
        raise AssertionError("Expected exact identity mismatch to fail")


async def test_fast_mode_never_contacts_lantern():
    _setup()
    with patch("providers.demo_cache.client.soft_complete_allowed_for_agent", return_value=True):
        result = await _run(fast_mode_cache_enabled=True, fast_mode_goal="cached goal", agent_id="agent-1")
    assert result["providers_attempted"] == []
    assert result["_fast_cache_hit"] is True
    assert get_captured_requests() == []


async def test_oauth_uses_owner_credentials_and_never_exposes_tokens():
    import httpx

    teardown_mock()

    def upstream(request: httpx.Request):
        if request.url.path == "/api/integrations/lantern-people/credentials/token":
            assert request.headers["x-user-id"] == "user-1"
            assert request.headers["x-api-key"] == "rose-test-key"
            return httpx.Response(
                200,
                json={
                    "apiUrl": "https://people.lantern.md",
                    "accessToken": "private-lantern-token",
                    "expiresAt": 9999999999999,
                    "connectionId": "grant_test",
                },
            )
        assert request.url.path == "/v1/operations/find_people"
        assert request.headers["authorization"] == "Bearer private-lantern-token"
        return httpx.Response(200, json={"ok": True, "data": {"people": _people(1)}})

    setup_mock_fn(upstream)
    result = await _run(config=_fake_config(token=""), user_id="user-1")
    calls = get_captured_requests()
    assert len(calls) == 2
    assert calls[0]["method"] == "GET"
    assert calls[1]["url"].endswith("/find_people")
    assert "private-lantern-token" not in json.dumps(calls)
    assert "private-lantern-token" not in json.dumps(result)
    assert result["provider_used"] == "lantern"


async def test_oauth_reconnect_failure_never_calls_search():
    from temporalio.exceptions import ApplicationError

    teardown_mock()
    setup_mock(
        {
            "localhost:3001/api/integrations/lantern-people/credentials/token": {
                "status": 409,
                "json": {"error": "Reconnect Lantern.", "code": "LANTERN_RECONNECT_REQUIRED"},
            }
        }
    )
    try:
        await _run(config=_fake_config(token=""), user_id="user-1")
    except ApplicationError as error:
        assert "LANTERN_RECONNECT_REQUIRED" in str(error)
    else:
        raise AssertionError("Expected revoked connection to stop")
    assert len(get_captured_requests()) == 1


async def test_oauth_refresh_in_progress_preserves_wait_details():
    from temporalio.exceptions import ApplicationError

    teardown_mock()
    setup_mock(
        {
            "localhost:3001/api/integrations/lantern-people/credentials/token": {
                "status": 503,
                "json": {
                    "error": "LANTERN_REFRESH_IN_PROGRESS",
                    "code": "LANTERN_REFRESH_IN_PROGRESS",
                    "details": {"retryAfterSeconds": 1},
                },
            }
        }
    )
    try:
        await _run(config=_fake_config(token=""), user_id="user-1")
    except ApplicationError as error:
        assert error.non_retryable
        assert error.details[0]["retryAfterSeconds"] == 1
        assert "Wait" in error.message and "reconnect" not in error.message
    else:
        raise AssertionError("Expected temporary refresh-in-progress error")
    assert len(get_captured_requests()) == 1


async def test_oauth_matches_equivalent_configured_origins():
    for configured in ("https://PEOPLE.LANTERN.MD", "https://people.lantern.md:443"):
        teardown_mock()
        setup_mock(
            {
                "localhost:3001/api/integrations/lantern-people/credentials/token": {
                    "status": 200,
                    "json": {"apiUrl": "https://people.lantern.md", "accessToken": "private-lantern-token"},
                },
                LANTERN_URL + "find_people": {"status": 200, "json": {"ok": True, "data": {"people": _people(1)}}},
            }
        )
        result = await _run(config=_fake_config(token="", api_url=configured), user_id="user-1")
        assert result["provider_used"] == "lantern"
        assert len(get_captured_requests()) == 2
        assert get_captured_requests()[1]["url"].startswith("https://people.lantern.md/")


async def test_oauth_origin_mismatch_never_sends_token_to_other_host():
    from temporalio.exceptions import ApplicationError

    teardown_mock()
    setup_mock(
        {
            "localhost:3001/api/integrations/lantern-people/credentials/token": {
                "status": 200,
                "json": {
                    "apiUrl": "https://another.example",
                    "accessToken": "private-lantern-token",
                    "expiresAt": 9999999999999,
                },
            }
        }
    )
    try:
        await _run(config=_fake_config(token=""), user_id="user-1")
    except ApplicationError as error:
        assert "CREDENTIAL_ORIGIN_MISMATCH" in str(error)
    else:
        raise AssertionError("Expected origin mismatch")
    assert len(get_captured_requests()) == 1


async def test_current_roles_and_nested_person():
    _setup(
        {
            "people": [
                {
                    "reachOut": {"person": {"name": "Alex", "linkedinUrl": "https://www.linkedin.com/in/alex"}},
                    "currentRoles": [{"title": "Founder", "company": "Acme"}],
                    "matchReason": "Developer tools founder",
                }
            ]
        }
    )
    person = (await _run())["results"][0]
    assert person["name"] == "Alex"
    assert person["title"] == "Founder"
    assert person["company"] == "Acme"
    assert person["summary"] == "Developer tools founder"


async def test_legacy_providers_use_only_lantern():
    for provider in ("exa", "parallel"):
        _setup()
        result = await _run(provider=provider)
        assert result["provider_used"] == "lantern"
        assert result["providers_attempted"] == ["lantern"]
        assert len(get_captured_requests()) == 1
        assert_captured_call(url_contains=LANTERN_URL, method="POST")


async def test_empty_results_are_successful():
    _setup({"people": []})
    result = await _run()
    assert result["results"] == []
    assert result["providers_attempted"] == ["lantern"]
    assert len(get_captured_requests()) == 1


async def test_errors_are_not_empty_success_or_retried():
    from temporalio.exceptions import ApplicationError

    for status, code, details in [
        (429, "RATE_LIMITED", {"retryAfterSeconds": 30}),
        (400, "LOCATION_RESOLUTION_REQUIRED", {"candidates": ["Georgia"]}),
        (403, "PLAN_REQUIRED", {}),
        (200, "PROVIDER_UNAVAILABLE", {}),
    ]:
        _setup(status=status, error={"code": code, "message": "Request cannot complete.", "details": details})
        try:
            await _run()
        except ApplicationError as error:
            assert code in str(error)
            assert error.non_retryable
            assert details in error.details
        else:
            raise AssertionError(f"Expected Lantern error {code}")
        assert len(get_captured_requests()) == 1


async def test_invalid_connection_stops_before_network():
    from temporalio.exceptions import ApplicationError

    for config in (
        _fake_config(token=""),
        _fake_config(api_url="http://external.example"),
        _fake_config(api_url="https://user:password@people.lantern.md"),
        _fake_config(api_url="https://people.lantern.md/skill"),
    ):
        _setup()
        try:
            await _run(config=config)
        except ApplicationError:
            pass
        else:
            raise AssertionError("Expected invalid connection to stop")
        assert get_captured_requests() == []


async def test_malformed_success_fails():
    from temporalio.exceptions import ApplicationError

    for data in ({"results": []}, {"people": None}, {"people": ["bad-profile"]}):
        _setup(data)
        try:
            await _run()
        except ApplicationError:
            pass
        else:
            raise AssertionError("Expected malformed response to fail")


def _mock_execute(calls, *, raises=False):
    async def execute(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": args, "kwargs": kwargs})
        if name == "people_search_activity":
            if raises:
                raise RuntimeError("provider offline")
            return {
                "query": "q",
                "mode_used": "discover",
                "provider_used": "lantern",
                "providers_attempted": ["lantern"],
                "results": [],
                "warnings": [],
            }

    return execute


async def test_manager_defaults_usage_criteria_and_entry_point():
    from tools.people_search.handler import people_search

    calls = []
    result = await people_search(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "founders", "mode": "discover", "titles": ["Founder"], "location": "Berlin"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    activity_call = next(call for call in calls if call["activity"] == "people_search_activity")
    assert activity_call["kwargs"]["args"][2] == "lantern"
    assert activity_call["kwargs"]["args"][10] == {"titles": ["Founder"], "location": "Berlin"}
    assert activity_call["kwargs"]["args"][11] == "user-1"
    assert activity_call["kwargs"]["retry_policy"].maximum_attempts == 1
    assert result["usage"]["service"] == [{"provider": "People Search (lantern)", "cost_cents": 0.0}]
    assert any(call["activity"] == "post_agent_message" for call in calls)


async def test_manager_reports_error():
    from tools.people_search.handler import people_search

    calls = []
    try:
        await people_search(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"query": "founders", "mode": "discover"},
            tool_call_id="tc-1",
            agent_id="agent-1",
        )
    except RuntimeError as error:
        assert "provider offline" in str(error)
    else:
        raise AssertionError("Expected error")
    assert any(call["activity"] == "post_agent_message" for call in calls)


async def test_nested_malformed_native_profiles_are_typed_nonretryable_errors():
    """Actual activity must reject malformed nested wire values without raw Python failures."""
    from temporalio.exceptions import ApplicationError

    nullable = _people(1)[0]
    for key in ("title", "company", "location"):
        nullable.pop(key)
    _setup({"people": [nullable], "generation": "fixture-nullable-generation"})
    valid = await _run()
    assert valid["results"][0]["name"] == nullable["name"]
    assert valid["results"][0]["title"] is None
    assert valid["results"][0]["company"] is None
    assert valid["results"][0]["source"]["record_id"] == nullable["sourceRecordId"]
    assert len(get_captured_requests()) == 1

    violations = []
    for field, value in (
        ("person", "not-an-object"),
        ("reachOut", "not-an-object"),
        ("profile", "not-an-object"),
        ("currentRoles", ["not-a-role-object"]),
        ("currentRoles", {"title": "not-an-array"}),
    ):
        row = {**nullable, field: value}
        _setup({"people": [row], "generation": "fixture-malformed-generation"})
        failure = None
        try:
            await _run()
        except Exception as error:
            failure = error
        if (
            not isinstance(failure, ApplicationError)
            or failure.type != "LanternPeopleError"
            or not failure.non_retryable
            or "INVALID_RESPONSE" not in str(failure)
        ):
            violations.append(f"{field}/{type(value).__name__}: {type(failure).__name__}: {failure}")
        assert len(get_captured_requests()) == 1, (
            "Malformed native payload must not trigger provider retries or fallback"
        )
    assert not violations, "Malformed nested profiles escaped the typed boundary: " + "; ".join(violations)


async def _run_with_broker_env(broker="", *, token="", **kwargs):
    """Use real config/activity; only environment, heartbeat and external IO are fixtures."""
    from tools.people_search.handler import people_search_activity

    required = (
        "TEMPORAL_API_KEY",
        "TEMPORAL_NAMESPACE",
        "TEMPORAL_ADDRESS",
        "TEMPORAL_TASK_QUEUE",
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "PERPLEXITY_API_KEY",
        "GEMINI_API_KEY",
        "BROWSERBASE_API_KEY",
        "BROWSERBASE_PROJECT_ID",
    )
    env = {key: "offline-broker-fixture" for key in required}
    env.update(
        {
            "BACKEND_API_URL": "http://localhost:3001",
            "BACKEND_API_KEY": "private-machine-key",
            "PEOPLE_API_URL": "https://people.lantern.md",
            "PEOPLE_API_TOKEN": token,
            "PEOPLE_CREDENTIAL_BROKER_URL": broker,
        }
    )
    with (
        patch.dict(os.environ, env, clear=True),
        patch("config._dotenv_loaded", True),
        patch("temporalio.activity.heartbeat"),
    ):
        return await people_search_activity(
            query="engineer", mode="discover", user_id="trusted-workflow-user", **kwargs
        )


def _install_broker_transport(*, broker_status=200, expected_token="broker-access-token"):
    import httpx

    teardown_mock()
    wire = []

    def upstream(request):
        host = request.url.host
        wire.append((host, request.url.path, request.method))
        if request.url.path == "/api/integrations/lantern-people/credentials/token":
            assert request.headers["x-user-id"] == "trusted-workflow-user"
            assert request.headers["x-api-key"] == "private-machine-key"
            if host == "localhost":
                return httpx.Response(404, json={"code": "LANTERN_NOT_CONNECTED"})
            assert host == "credential-broker.example.test"
            if broker_status != 200:
                return httpx.Response(
                    broker_status,
                    json={
                        "code": "LANTERN_REFRESH_IN_PROGRESS" if broker_status == 503 else "LANTERN_NOT_CONNECTED",
                        "details": {"retryAfterSeconds": 2},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "apiUrl": "https://people.lantern.md",
                    "accessToken": "broker-access-token",
                },
            )
        assert host == "people.lantern.md"
        assert request.url.path == "/v1/operations/find_people"
        assert request.headers["authorization"] == "Bearer " + expected_token
        assert "x-api-key" not in request.headers
        return httpx.Response(200, json={"ok": True, "data": {"people": _people(1)}})

    setup_mock_fn(upstream)
    return wire


async def test_explicit_broker_uses_central_authority_with_actual_activity_config():
    wire = _install_broker_transport()
    failure = None
    try:
        result = await _run_with_broker_env("https://credential-broker.example.test")
    except Exception as error:
        failure = error
    assert wire == [
        ("credential-broker.example.test", "/api/integrations/lantern-people/credentials/token", "GET"),
        ("people.lantern.md", "/v1/operations/find_people", "POST"),
    ], f"Local broker used instead of configured central authority: {wire}; {failure}"
    assert failure is None
    assert result["provider_used"] == "lantern"
    assert result["results"][0]["source"]["record_id"] == "record-0"
    for secret in ("broker-access-token", "private-machine-key"):
        assert secret not in json.dumps(result)
        assert secret not in json.dumps(get_captured_requests())


async def test_explicit_broker_overrides_static_bearer_without_fallback():
    wire = _install_broker_transport()
    result = await _run_with_broker_env("https://credential-broker.example.test", token="stale-direct-token")
    assert result["provider_used"] == "lantern"
    assert [host for host, _, _ in wire] == ["credential-broker.example.test", "people.lantern.md"]


async def test_blank_broker_preserves_static_and_local_default_routes():
    from temporalio.exceptions import ApplicationError

    wire = _install_broker_transport(expected_token="direct-access-token")
    result = await _run_with_broker_env("  ", token="direct-access-token")
    assert result["provider_used"] == "lantern"
    assert [host for host, _, _ in wire] == ["people.lantern.md"]
    wire = _install_broker_transport()
    try:
        await _run_with_broker_env()
    except ApplicationError as error:
        assert "LANTERN_NOT_CONNECTED" in str(error)
    else:
        raise AssertionError("Blank broker must retain local backend credential selection")
    assert [host for host, _, _ in wire] == ["localhost"]


async def test_explicit_broker_errors_never_fall_back_and_keep_wait_hint():
    from temporalio.exceptions import ApplicationError

    for status in (503, 401, 404):
        wire = _install_broker_transport(broker_status=status)
        try:
            await _run_with_broker_env("https://credential-broker.example.test", token="stale-direct-token")
        except ApplicationError as error:
            assert error.non_retryable
            if status == 503:
                assert error.details[0]["retryAfterSeconds"] == 2
                assert "Wait" in error.message and "reconnect" not in error.message
        else:
            raise AssertionError("Explicit broker errors must propagate without local/static fallback")
        assert [host for host, _, _ in wire] == ["credential-broker.example.test"]


async def test_invalid_explicit_broker_rejects_before_any_auth_http():
    from temporalio.exceptions import ApplicationError

    for broker in (
        "http://remote.example.test",
        "https://user:private-url-secret@credential-broker.example.test",
        "https://credential-broker.example.test/path",
        "https://credential-broker.example.test/?key=private-url-secret",
        "https://credential-broker.example.test/#private-url-secret",
        "https://credential-broker.example.test:bad",
        "https://credential-broker.example.test:65536",
        "http://localhost:0",
    ):
        wire = _install_broker_transport()
        try:
            await _run_with_broker_env(broker, token="stale-direct-token")
        except ApplicationError as error:
            assert error.non_retryable
            assert "private-url-secret" not in str(error)
        else:
            raise AssertionError("Invalid explicit broker must fail closed")
        assert wire == [], "Invalid broker configuration disclosed auth via HTTP"
        assert get_captured_requests() == []


async def test_configured_broker_fast_mode_still_uses_zero_http():
    wire = _install_broker_transport()
    with patch("providers.demo_cache.client.soft_complete_allowed_for_agent", return_value=True):
        result = await _run_with_broker_env(
            "https://credential-broker.example.test",
            token="stale-direct-token",
            fast_mode_cache_enabled=True,
            fast_mode_goal="cached goal",
            agent_id="agent-1",
        )
    assert result["providers_attempted"] == []
    assert result["_fast_cache_hit"] is True
    assert wire == []
    assert get_captured_requests() == []


async def run_all_tests():
    print("people-search Lantern blackbox tests:")
    result = BlackboxResult()
    result.record("types_contracts", test_types_contracts_are_importable)
    for test in (
        test_schema_defaults_and_pairing,
        test_limit_clamp_discover,
        test_discover_request_normalization_and_criteria,
        test_enrich_by_id_preserves_fields_without_contact_reveals,
        test_exact_enrichment_missing_record_is_typed_error,
        test_missing_enrichment_manager_reports_error_without_query_charge,
        test_enrich_does_not_pick_an_ambiguous_first_match,
        test_exact_enrichment_rejects_search_constraints,
        test_manager_preserves_provider_recovery_details,
        test_exact_profile_identity_and_nested_attributes,
        test_fast_mode_never_contacts_lantern,
        test_oauth_uses_owner_credentials_and_never_exposes_tokens,
        test_oauth_reconnect_failure_never_calls_search,
        test_oauth_refresh_in_progress_preserves_wait_details,
        test_oauth_matches_equivalent_configured_origins,
        test_oauth_origin_mismatch_never_sends_token_to_other_host,
        test_current_roles_and_nested_person,
        test_legacy_providers_use_only_lantern,
        test_empty_results_are_successful,
        test_errors_are_not_empty_success_or_retried,
        test_invalid_connection_stops_before_network,
        test_malformed_success_fails,
        test_nested_malformed_native_profiles_are_typed_nonretryable_errors,
        test_explicit_broker_uses_central_authority_with_actual_activity_config,
        test_explicit_broker_overrides_static_bearer_without_fallback,
        test_blank_broker_preserves_static_and_local_default_routes,
        test_explicit_broker_errors_never_fall_back_and_keep_wait_hint,
        test_invalid_explicit_broker_rejects_before_any_auth_http,
        test_configured_broker_fast_mode_still_uses_zero_http,
        test_manager_defaults_usage_criteria_and_entry_point,
        test_manager_reports_error,
    ):
        await result.record_async(test.__name__, test)
    teardown_mock()
    return result.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
