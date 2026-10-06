import asyncio

from benchmarks import phone_callee


def test_configured_phone_pool_assigns_distinct_numbers_per_task(monkeypatch):
    configured = (
        "phone-call-client-intake=number-intake,"
        "phone-call-payment=number-payment,"
        "phone-call-ivr-dtmf=number-ivr,"
        "phone-call-hold-queue=number-hold"
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
    assert phone_callee._configured_number_id_for_task("phone-call-hold-queue") == "number-hold"


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


def test_phone_callee_persona_hold_success_monitor_is_attached():
    """Hold-queue callees enable live control so the real wait can inject a rep."""

    async def run() -> None:
        captured: dict = {}

        class Response:
            status_code = 201

            def json(self):
                return {"id": "assistant-hold"}

        class Client:
            async def post(self, path, json=None):
                assert path == "/assistant"
                captured["config"] = json
                return Response()

        session = phone_callee.PhoneCalleeSession(
            "phone-call-hold-queue",
            {
                "system_prompt": "Hold queue persona",
                "first_message": "Estimated wait time is 3 hours. Please stay on the line.",
                "hold_success": {
                    "hold_seconds": 20,
                    "say": "This is Riley. Your confirmation code is HOLD-3300.",
                },
            },
            api_key="test-key",
        )
        await session._create_persona_assistant(Client())

        assert captured["config"]["firstMessage"].startswith("Estimated wait time is 3 hours")
        assert captured["config"]["monitorPlan"] == {"listenEnabled": True, "controlEnabled": True}
        assert session._hold_success_config() == {
            "hold_seconds": 20.0,
            "say": "This is Riley. Your confirmation code is HOLD-3300.",
            "keepalive_seconds": 0.0,
            "keepalive_say": "",
        }

    asyncio.run(run())


def test_hold_success_accepts_three_hour_wait_and_rejects_over_cap():
    """A 2h45m hold is allowed; a day-long hold_seconds still fails closed."""
    allowed = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {
            "system_prompt": "Hold queue persona",
            "hold_success": {"hold_seconds": 9900, "say": "Rep here."},
        },
        api_key="test-key",
    )
    assert allowed._hold_success_config()["hold_seconds"] == 9900.0

    session = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {
            "system_prompt": "Hold queue persona",
            "hold_success": {"hold_seconds": 20000, "say": "Rep here."},
        },
        api_key="test-key",
    )
    try:
        session._hold_success_config()
    except ValueError as exc:
        assert "hold cap" in str(exc)
        assert "20000" in str(exc)
        return
    raise AssertionError("expected ValueError for an over-cap hold_seconds")


def test_hold_success_rejects_bool_and_empty_say():
    bool_session = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {"system_prompt": "Hold", "hold_success": {"hold_seconds": True, "say": "Rep here."}},
        api_key="test-key",
    )
    empty_session = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {"system_prompt": "Hold", "hold_success": {"hold_seconds": 20, "say": "  "}},
        api_key="test-key",
    )
    assert bool_session._hold_success_config() is None
    assert empty_session._hold_success_config() is None


def test_hold_elapsed_seconds_ignores_foreign_and_unready_calls():
    from datetime import datetime, timedelta, timezone

    session = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {"system_prompt": "Hold"},
        api_key="test-key",
    )
    started = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
    session.started_at = started
    now = started + timedelta(seconds=10)

    def fake_utcnow():
        return now

    original_utcnow = phone_callee._utcnow
    phone_callee._utcnow = fake_utcnow
    try:
        assert session._hold_elapsed_seconds({"createdAt": "not-a-timestamp"}) is None
        assert (
            session._hold_elapsed_seconds({"createdAt": (started - timedelta(minutes=5)).isoformat()})
            is None
        )
        assert session._hold_elapsed_seconds({"createdAt": started.isoformat()}) == 10.0
    finally:
        phone_callee._utcnow = original_utcnow


def test_hold_success_watcher_injects_after_hold_elapses(monkeypatch):
    from datetime import datetime, timedelta, timezone

    async def run() -> None:
        started = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
        now = {"value": started + timedelta(seconds=10)}
        injected: list[tuple[str, str, str, str]] = []
        list_calls = {"n": 0}

        monkeypatch.setattr(phone_callee, "_utcnow", lambda: now["value"])

        call = {
            "id": "call-hold-1",
            "assistantId": "asst-hold",
            "status": "in-progress",
            "createdAt": started.isoformat(),
            "monitor": {"controlUrl": "https://example.test/control"},
        }

        class ListResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return [call]

        class DetailResponse:
            status_code = 200

            def json(self):
                return call

        class Client:
            async def get(self, path, params=None):
                if path == "/call":
                    list_calls["n"] += 1
                    return ListResponse()
                return DetailResponse()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

        session = phone_callee.PhoneCalleeSession(
            "phone-call-hold-queue",
            {
                "system_prompt": "Hold queue persona",
                "hold_success": {
                    "hold_seconds": 20,
                    "say": "This is Riley. Confirmation HOLD-3300.",
                },
                "max_duration_seconds": 60,
            },
            api_key="test-key",
        )
        session.assistant_id = "asst-hold"
        session.phone_number_id = "pn-hold"
        session.started_at = started

        async def fake_inject(control_url, say, call_id, label, **kwargs):
            injected.append((control_url, say, call_id, label, kwargs.get("end_call_after_spoken", True)))
            now["value"] = started + timedelta(seconds=21)
            return True

        original_sleep = asyncio.sleep

        async def fake_sleep(_seconds):
            now["value"] = started + timedelta(seconds=21)

        monkeypatch.setattr(session, "_inject_control_say", fake_inject)
        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        monkeypatch.setattr(phone_callee.httpx, "AsyncClient", lambda **_kwargs: Client())

        await session._watch_hold_success_announcement()

        assert injected == [
            (
                "https://example.test/control",
                "This is Riley. Confirmation HOLD-3300.",
                "call-hold-1",
                "hold_success",
                False,
            )
        ]
        assert session._hold_success_announced is True
        assert list_calls["n"] >= 2
        monkeypatch.setattr(asyncio, "sleep", original_sleep)

    asyncio.run(run())


def test_hold_success_watcher_sends_keepalive_without_ending_call(monkeypatch):
    from datetime import datetime, timedelta, timezone

    async def run() -> None:
        started = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
        now = {"value": started + timedelta(seconds=21)}
        injected: list[tuple] = []

        monkeypatch.setattr(phone_callee, "_utcnow", lambda: now["value"])

        call = {
            "id": "call-hold-1",
            "assistantId": "asst-hold",
            "status": "in-progress",
            "createdAt": started.isoformat(),
            "monitor": {"controlUrl": "https://example.test/control"},
        }

        class ListResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return [call]

        class DetailResponse:
            status_code = 200

            def json(self):
                return call

        class Client:
            async def get(self, path, params=None):
                return ListResponse() if path == "/call" else DetailResponse()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

        session = phone_callee.PhoneCalleeSession(
            "phone-call-hold-queue",
            {
                "system_prompt": "Hold queue persona",
                "hold_success": {
                    "hold_seconds": 9900,
                    "keepalive_seconds": 20,
                    "keepalive_say": "Please continue to hold. A representative is expected at 2:45 PM.",
                    "say": "This is Riley. Confirmation ACFC-2458.",
                },
                "max_duration_seconds": 40,
            },
            api_key="test-key",
        )
        session.assistant_id = "asst-hold"
        session.phone_number_id = "pn-hold"
        session.started_at = started

        async def fake_inject(control_url, say, call_id, label, **kwargs):
            injected.append((label, say, kwargs.get("end_call_after_spoken", True)))
            return True

        async def fake_sleep(_seconds):
            raise asyncio.CancelledError

        monkeypatch.setattr(session, "_inject_control_say", fake_inject)
        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        monkeypatch.setattr(phone_callee.httpx, "AsyncClient", lambda **_kwargs: Client())

        try:
            await session._watch_hold_success_announcement()
        except asyncio.CancelledError:
            pass

        assert injected == [
            (
                "hold_keepalive",
                "Please continue to hold. A representative is expected at 2:45 PM.",
                False,
            )
        ]
        assert session._hold_success_announced is False

    asyncio.run(run())


def test_long_hold_uses_slower_watch_poll_and_longer_analysis_wait():
    short = phone_callee.PhoneCalleeSession(
        "phone-call-ivr-dtmf",
        {
            "system_prompt": "IVR",
            "hold_success": {"hold_seconds": 20, "say": "Thanks for holding."},
            "max_duration_seconds": 180,
        },
        api_key="test-key",
    )
    long = phone_callee.PhoneCalleeSession(
        "phone-call-hold-queue",
        {
            "system_prompt": "Hold queue",
            "hold_success": {"hold_seconds": 9900, "say": "This is Riley. How can I help you today?"},
            "max_duration_seconds": 12600,
        },
        api_key="test-key",
    )
    assert short._hold_watch_poll_seconds() == phone_callee.HOLD_WATCH_POLL_SECONDS
    assert short.analysis_timeout_seconds() == phone_callee.CALLEE_ANALYSIS_TIMEOUT_SECONDS
    assert long._hold_watch_poll_seconds() == phone_callee.HOLD_WATCH_POLL_LONG_SECONDS
    assert long.analysis_timeout_seconds() == phone_callee.CALLEE_ANALYSIS_TIMEOUT_LONG_SECONDS
