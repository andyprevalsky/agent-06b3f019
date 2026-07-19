import asyncio

from benchmarks import phone_callee


def test_configured_phone_pool_assigns_distinct_numbers_per_task(monkeypatch):
    configured = (
        "phone-call-client-intake=number-intake,"
        "phone-call-payment=number-payment"
    )
    monkeypatch.setattr(
        phone_callee,
        "load_env_var",
        lambda name, _path: configured
        if name == "BENCHMARK_CALLEE_PHONE_NUMBER_IDS"
        else "",
    )

    assert phone_callee._configured_number_id_for_task("phone-call-client-intake") == "number-intake"
    assert phone_callee._configured_number_id_for_task("phone-call-payment") == "number-payment"


def test_configured_phone_pool_never_calls_free_number_provisioning(monkeypatch):
    monkeypatch.setattr(
        phone_callee,
        "load_env_var",
        lambda name, _path: "phone-call-payment=number-payment"
        if name == "BENCHMARK_CALLEE_PHONE_NUMBER_IDS"
        else "",
    )

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return [
                {
                    "id": "number-payment",
                    "number": "+15555550100",
                    "assistantId": None,
                }
            ]

    class Client:
        async def get(self, path):
            assert path == "/phone-number"
            return Response()

        async def post(self, *_args, **_kwargs):
            raise AssertionError("configured phone tasks must not provision scarce free numbers")

    session = phone_callee.PhoneCalleeSession(
        "phone-call-payment", {"system_prompt": "Test payment"}, api_key="test-key"
    )
    asyncio.run(session._ensure_phone_number(Client()))

    assert session.phone_number_id == "number-payment"
    assert session.phone_number == "+15555550100"
    assert session._owns_phone_number is False
