import asyncio

from benchmarks import phone_callee


def test_configured_phone_pool_assigns_distinct_numbers_per_task(monkeypatch):
    configured = (
        "phone-call-client-intake=number-intake,"
        "phone-call-payment=number-payment,"
        "phone-call-ivr-dtmf=number-ivr"
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
    assert phone_callee._configured_number_id_for_task("phone-call-ivr-dtmf") == "number-ivr"


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


def test_phone_callee_persona_keypad_input_plan_is_attached():
    """IVR callees can collect caller DTMF via Vapi keypadInputPlan."""

    async def run() -> None:
        captured: dict = {}

        class Response:
            status_code = 201

            def json(self):
                return {"id": "assistant-ivr"}

        class Client:
            async def post(self, path, json=None):
                assert path == "/assistant"
                captured["config"] = json
                return Response()

        session = phone_callee.PhoneCalleeSession(
            "phone-call-ivr-dtmf",
            {
                "system_prompt": "IVR persona",
                "first_message": "Press 2 to track a package.",
                "keypad_input_plan": {
                    "enabled": True,
                    "delimiters": ["#"],
                    "timeoutSeconds": 5,
                },
            },
            api_key="test-key",
        )
        await session._create_persona_assistant(Client())

        assert captured["config"]["firstMessage"] == "Press 2 to track a package."
        assert captured["config"]["keypadInputPlan"] == {
            "enabled": True,
            "delimiters": ["#"],
            "timeoutSeconds": 5,
        }
        assert captured["config"]["model"]["temperature"] == 0

    asyncio.run(run())


def test_phone_callee_persona_end_call_message_and_keypad_success_monitor_are_attached():
    """IVR callees can force a status announcement via endCallMessage + live control."""

    async def run() -> None:
        captured: dict = {}

        class Response:
            status_code = 201

            def json(self):
                return {"id": "assistant-ivr"}

        class Client:
            async def post(self, path, json=None):
                assert path == "/assistant"
                captured["config"] = json
                return Response()

        session = phone_callee.PhoneCalleeSession(
            "phone-call-ivr-dtmf",
            {
                "system_prompt": "IVR persona",
                "end_call_message": (
                    "Your package is scheduled for delivery tomorrow. "
                    "Your reference code is DELIV-9012. Goodbye."
                ),
                "keypad_success": {
                    "tracking_number": "2451338820",
                    "say": (
                        "Your package is scheduled for delivery tomorrow. "
                        "Your reference code is DELIV-9012. Goodbye."
                    ),
                },
            },
            api_key="test-key",
        )
        await session._create_persona_assistant(Client())

        assert captured["config"]["endCallMessage"].startswith("Your package is scheduled")
        assert "DELIV-9012" in captured["config"]["endCallMessage"]
        assert captured["config"]["monitorPlan"] == {"listenEnabled": True, "controlEnabled": True}
        assert session._keypad_success_config() == {
            "tracking_number": "2451338820",
            "say": (
                "Your package is scheduled for delivery tomorrow. "
                "Your reference code is DELIV-9012. Goodbye."
            ),
        }

    asyncio.run(run())


def test_phone_callee_persona_timeout_overrides_are_attached():
    async def run() -> None:
        captured: dict = {}

        class Response:
            status_code = 201

            def json(self):
                return {"id": "assistant-ivr"}

        class Client:
            async def post(self, path, json=None):
                assert path == "/assistant"
                captured["config"] = json
                return Response()

        session = phone_callee.PhoneCalleeSession(
            "phone-call-ivr-dtmf",
            {
                "system_prompt": "IVR persona",
                "silence_timeout_seconds": 60,
                "max_duration_seconds": 180,
            },
            api_key="test-key",
        )
        await session._create_persona_assistant(Client())
        assert captured["config"]["silenceTimeoutSeconds"] == 60
        assert captured["config"]["maxDurationSeconds"] == 180

    asyncio.run(run())
