"""Native benchmark admission against an isolated HTTP provider; no financial calls."""

from unittest.mock import AsyncMock, patch

import httpx

from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock


class AllocationBoundary(BaseException):
    """Stop at the first attempted write without allocating a root or payment."""


LIVE_V2_READY = {
    "apiVersion": 2,
    "connected": True,
    "status": "approved",
    "livemode": True,
    "fundsSource": "company_flow",
}


async def admission(billing, *, status=200, task_name="agent-payment-production-abandonment", readiness=None):
    from benchmarks import run_benchmark as bench

    requests = []

    def provider(request):
        requests.append(request)
        if task_name == "agent-payment-abandonment" and request.url.path == "/api/test-payment/lifecycle/agentcard-setup":
            return httpx.Response(200, json={"success": True})
        if request.method != "GET":
            raise AllocationBoundary()
        if request.url.path == "/api/agentcard/status":
            assert request.headers["x-user-id"] == bench.AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID
            return httpx.Response(200, json=LIVE_V2_READY if readiness is None else readiness)
        # The owner probe's dedicated live billing customer must be configured on the backend.
        assert request.url.path == "/api/test-payment/lifecycle/owner-billing", request.url
        return httpx.Response(status, json=billing)

    setup_mock_fn(provider)
    try:
        with patch.object(bench, "_api_headers", AsyncMock(return_value={"X-API-Key": "fixture-only"})):
            try:
                await bench.run_single_task("https://payment-admission.fixture.invalid", bench.get_task_by_name(task_name))
            except AllocationBoundary:
                return "allocated", requests
            except RuntimeError as error:
                return str(error), requests
        raise AssertionError("native runner returned without an admission decision")
    finally:
        teardown_mock()


async def test_unconfigured_owner_billing_refused_before_any_write():
    outcome, requests = await admission({"configured": False})
    assert "BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID is not configured" in outcome, outcome
    assert {r.method for r in requests} == {"GET"}, "unconfigured owner billing reached an allocation"


async def test_unknown_owner_billing_refused_before_any_write():
    for billing in ({}, {"configured": None}, {"configured": "true"}, {"configured": 1}):
        outcome, requests = await admission(billing)
        assert "not configured" in outcome, (billing, outcome)
        assert {r.method for r in requests} == {"GET"}
    outcome, requests = await admission({"error": "unavailable"}, status=503)
    assert "503" in outcome and outcome != "allocated", outcome
    assert {r.method for r in requests} == {"GET"}


async def test_live_identity_remains_admissible():
    outcome, requests = await admission({"configured": True})
    assert outcome == "allocated", outcome
    assert requests[0].url.path == "/api/test-payment/lifecycle/owner-billing"
    assert requests[-1].method == "POST" and requests[-1].url.path == "/api/agents"


async def test_live_identity_requires_scoped_v2_readiness_before_allocation():
    for readiness in (
        {"connected": True, "status": "approved"},
        {**LIVE_V2_READY, "connected": False},
        {**LIVE_V2_READY, "status": "pending"},
        {**LIVE_V2_READY, "livemode": False},
        {**LIVE_V2_READY, "fundsSource": "onramp"},
    ):
        outcome, requests = await admission({"configured": True}, readiness=readiness)
        assert "scoped live v2" in outcome, outcome
        assert [r.method for r in requests] == ["GET", "GET"], "unready identity reached a write"


async def test_generic_sandbox_task_does_not_require_live_billing():
    outcome, requests = await admission({"configured": False}, task_name="chat-mode")
    assert outcome == "allocated", outcome
    assert all(r.url.path != "/api/test-payment/lifecycle/owner-billing" for r in requests)
    assert requests[-1].method == "POST" and requests[-1].url.path == "/api/agents"


async def test_sandbox_payment_retains_test_mode_setup():
    outcome, requests = await admission({"configured": False}, task_name="agent-payment-abandonment")
    assert outcome == "allocated", outcome
    assert all(r.url.path != "/api/test-payment/lifecycle/owner-billing" for r in requests)
    assert any(r.url.path == "/api/test-payment/lifecycle/agentcard-setup" for r in requests)
    assert requests[-1].method == "POST" and requests[-1].url.path == "/api/agents"


async def run_all_tests():
    result = BlackboxResult()
    for test in (
        test_unconfigured_owner_billing_refused_before_any_write,
        test_unknown_owner_billing_refused_before_any_write,
        test_live_identity_remains_admissible,
        test_live_identity_requires_scoped_v2_readiness_before_allocation,
        test_generic_sandbox_task_does_not_require_live_billing,
        test_sandbox_payment_retains_test_mode_setup,
    ):
        await result.record_async(test.__name__, test)
    return result.summary()
