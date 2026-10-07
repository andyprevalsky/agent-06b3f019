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


def test_configured_phone_pool_rejects_one_number_shared_by_two_tasks(monkeypatch):
    configured = (
        "phone-call-client-intake=number-shared,"
        "phone-call-payment=number-payment,"
        "phone-call-hold-queue=number-shared"
    )
    monkeypatch.setattr(
        phone_callee,
        "load_env_var",
        lambda name, _path: configured
        if name == "BENCHMARK_CALLEE_PHONE_NUMBER_IDS"
        else "",
    )

    for task_name in ("phone-call-client-intake", "phone-call-hold-queue"):
        try:
            phone_callee._configured_number_id_for_task(task_name)
        except RuntimeError as exc:
            message = str(exc)
            assert "phone-call-client-intake" in message and "phone-call-hold-queue" in message
        else:
            raise AssertionError(f"{task_name} resolved a callee number another task also attaches to")
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


class _FakeHoldLine:
    """Stands in for HoldLineSession at the PhoneCalleeSession boundary."""

    def __init__(self, transferred: bool = False, stayed: bool = False, events: list | None = None, **kwargs):
        self.kwargs = kwargs
        self.number = "+18555550100"
        self.transferred_at = "2026-10-06T16:30:46+00:00" if transferred else None
        self._stayed = stayed
        self.events = events if events is not None else []

    async def acquire(self):
        self.events.append("acquire")
        return self.number

    async def run(self):
        self.events.append("run")
        await asyncio.Event().wait()

    def stayed_on_hold(self):
        return self._stayed

    def evidence(self):
        return {"hold_line_number": self.number, "transferred_at": self.transferred_at or ""}

    async def release(self):
        self.events.append("release")


HOLD_PERSONA = {
    "system_prompt": "Representative persona",
    "hold_line": {"hold_seconds": 9000, "audio": "air-canada-2026-10-06"},
    "max_duration_seconds": 900,
}


def test_hold_line_persona_dials_the_line_and_transfers_to_the_persona_number(monkeypatch):
    created: list[dict] = []

    def factory(**kwargs):
        created.append(kwargs)
        return _FakeHoldLine(**kwargs)

    monkeypatch.setattr(phone_callee, "HoldLineSession", factory)
    session = phone_callee.PhoneCalleeSession("phone-call-hold-queue", dict(HOLD_PERSONA), api_key="test-key")
    session.phone_number = "+16195550142"
    assert session.dial_number == "+16195550142"

    session.hold_line = session._new_hold_line()

    assert session.dial_number == "+18555550100"
    kwargs = created[0]
    assert kwargs["representative_number"] == "+16195550142"
    assert kwargs["hold_seconds"] == 9000
    assert kwargs["lease_seconds"] == 9000 + 900 + phone_callee.HOLD_LINE_LEASE_MARGIN_SECONDS
    assert kwargs["audio_manifest"]["name"] == "air-canada-2026-10-06"
    assert session.analysis_timeout_seconds() == phone_callee.CALLEE_ANALYSIS_TIMEOUT_SECONDS


def test_hold_line_config_requires_named_audio():
    for hold_line in ({"hold_seconds": 9000}, "air-canada", {"hold_seconds": 9000, "audio": " "}):
        session = phone_callee.PhoneCalleeSession(
            "phone-call-hold-queue", {"system_prompt": "Rep", "hold_line": hold_line}, api_key="test-key"
        )
        try:
            session._hold_line_config()
        except ValueError as exc:
            assert "hold_line" in str(exc)
        else:
            raise AssertionError(f"hold_line={hold_line!r} must be rejected")
    plain = phone_callee.PhoneCalleeSession("phone-call-payment", {"system_prompt": "Rep"}, api_key="test-key")
    assert plain._new_hold_line() is None


class _NoNetwork:
    def __init__(self, **_kwargs):
        raise AssertionError("an untransferred hold has no persona call to poll")


def test_untransferred_hold_reports_line_evidence_without_waiting_for_persona_analysis(monkeypatch):
    monkeypatch.setattr(phone_callee.httpx, "AsyncClient", _NoNetwork)
    session = phone_callee.PhoneCalleeSession("phone-call-hold-queue", dict(HOLD_PERSONA), api_key="test-key")
    session.hold_line = _FakeHoldLine(transferred=False)

    data = asyncio.run(session.fetch_callee_structured_data(timeout_seconds=1))

    assert data == {
        "caller_stayed_on_hold": False,
        "hold_line": {"hold_line_number": "+18555550100", "transferred_at": ""},
    }
    assert phone_callee.callee_check_failures({"caller_stayed_on_hold": True}, data) == [
        "caller_stayed_on_hold: expected True, got False"
    ]


def test_hold_line_record_overrides_what_the_persona_inferred(monkeypatch):
    analysis = {
        "caller_stayed_on_hold": True,
        "caller_requested_flight_credit": True,
        "confirmation_code": "ACFC-2458",
    }

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return [
                {
                    "id": "call-rep",
                    "assistantId": "asst-rep",
                    "createdAt": "2026-10-06T16:30:47+00:00",
                    "analysis": {"structuredData": analysis},
                }
            ]

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, path, params=None):
            assert path == "/call" and params["phoneNumberId"] == "pn-rep"
            return Response()

    monkeypatch.setattr(phone_callee.httpx, "AsyncClient", Client)
    monkeypatch.setattr(phone_callee, "payment_audit_structured_data_since", lambda _since: {})
    session = phone_callee.PhoneCalleeSession("phone-call-hold-queue", dict(HOLD_PERSONA), api_key="test-key")
    session.phone_number_id, session.assistant_id = "pn-rep", "asst-rep"
    for stayed in (False, True):
        session.hold_line = _FakeHoldLine(transferred=True, stayed=stayed)
        data = asyncio.run(session.fetch_callee_structured_data(timeout_seconds=1))
        assert data["caller_stayed_on_hold"] is stayed
        assert data["caller_requested_flight_credit"] is True and data["confirmation_code"] == "ACFC-2458"
        assert data["hold_line"]["transferred_at"] == "2026-10-06T16:30:46+00:00"


def test_setup_leases_the_line_after_the_persona_and_cleanup_releases_it_first(monkeypatch):
    events: list[str] = []
    monkeypatch.setattr(phone_callee, "HoldLineSession", lambda **kw: _FakeHoldLine(events=events, **kw))

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, path, params=None):
            events.append(f"vapi GET {path}")
            raise phone_callee.httpx.ConnectError("offline")

        async def patch(self, path, json=None):
            events.append(f"vapi PATCH {path}")

            class Ok:
                status_code = 200

            return Ok()

        async def delete(self, path):
            events.append(f"vapi DELETE {path}")

            class Ok:
                status_code = 200
                text = ""

            return Ok()

    monkeypatch.setattr(phone_callee.httpx, "AsyncClient", Client)

    async def run(fail_acquire: bool) -> phone_callee.PhoneCalleeSession:
        events.clear()
        session = phone_callee.PhoneCalleeSession("phone-call-hold-queue", dict(HOLD_PERSONA), api_key="test-key")

        async def ensure(_client):
            events.append("number")
            session.phone_number, session.phone_number_id = "+16195550142", "pn-rep"

        async def assistant(_client):
            events.append("assistant")
            session.assistant_id = "asst-rep"

        async def attach(_client, assistant_id):
            events.append(f"attach {assistant_id}")

        async def no_tools(_client):
            return None

        monkeypatch.setattr(session, "_ensure_phone_number", ensure)
        monkeypatch.setattr(session, "_create_persona_tools", no_tools)
        monkeypatch.setattr(session, "_create_persona_assistant", assistant)
        monkeypatch.setattr(session, "_attach_assistant", attach)
        if fail_acquire:

            async def busy():
                events.append("acquire")
                raise RuntimeError("Every benchmark hold line is busy")

            monkeypatch.setattr(_FakeHoldLine, "acquire", lambda self: busy())
        try:
            await session.setup()
        except RuntimeError:
            assert fail_acquire
            return session
        await asyncio.sleep(0)
        assert session.dial_number == "+18555550100"
        assert session.hold_line.kwargs["representative_number"] == "+16195550142"
        await session.cleanup()
        return session

    asyncio.run(run(fail_acquire=False))
    assert events[:5] == ["number", "assistant", "attach asst-rep", "acquire", "run"]
    assert events[5] == "release"
    assert "vapi DELETE /assistant/asst-rep" in events[6:]

    asyncio.run(run(fail_acquire=True))
    assert events[:4] == ["number", "assistant", "attach asst-rep", "acquire"]
    assert "run" not in events
    assert events.index("release") < events.index("vapi DELETE /assistant/asst-rep")


def test_configured_number_reclaims_a_leaked_persona_assistant_instead_of_restoring_it():
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    stale = (now - phone_callee.CALLEE_SESSION_NUMBER_TTL - timedelta(minutes=1)).isoformat()
    fresh = (now - timedelta(hours=1)).isoformat()
    assistants = {
        "leaked": {"name": "benchmark-callee-phone-call-hold-queue", "createdAt": stale},
        "concurrent": {"name": "benchmark-callee-phone-call-hold-queue", "createdAt": fresh},
        "owner": {"name": "Rose Labs", "createdAt": stale},
    }
    requests: list[str] = []

    def handler(request: phone_callee.httpx.Request) -> phone_callee.httpx.Response:
        requests.append(f"{request.method} {request.url.path}")
        assistant_id = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET":
            if assistant_id not in assistants:
                return phone_callee.httpx.Response(404, json={"message": "Not Found"})
            return phone_callee.httpx.Response(200, json={"id": assistant_id, **assistants[assistant_id]})
        if request.method == "DELETE":
            return phone_callee.httpx.Response(200, json={})
        return phone_callee.httpx.Response(200, json={"id": "pn-hold", "assistantId": None})

    async def prior_after_setup(prior_id: str) -> tuple:
        requests.clear()
        session = phone_callee.PhoneCalleeSession("phone-call-hold-queue", {"system_prompt": "p"}, api_key="k")
        session.phone_number_id, session.assistant_id, session._prior_assistant_id = "pn-hold", "asst-new", prior_id
        async with phone_callee.httpx.AsyncClient(
            base_url="https://vapi.test", transport=phone_callee.httpx.MockTransport(handler)
        ) as client:
            await session._reclaim_leaked_prior_assistant(client)
        return session._prior_assistant_id, list(requests)

    assert asyncio.run(prior_after_setup("leaked")) == (None, ["GET /assistant/leaked", "DELETE /assistant/leaked"])
    assert asyncio.run(prior_after_setup("concurrent")) == ("concurrent", ["GET /assistant/concurrent"])
    assert asyncio.run(prior_after_setup("owner")) == ("owner", ["GET /assistant/owner"])
    assert asyncio.run(prior_after_setup("deleted")) == (None, ["GET /assistant/deleted"])
    assert asyncio.run(prior_after_setup("asst-new")) == ("asst-new", [])


def test_callee_checks_match_spoken_calendar_dates():
    assert (
        phone_callee.callee_check_failures(
            {"credit_expiry": "October 2, 2027"},
            {"credit_expiry": "October second two thousand twenty seven"},
        )
        == []
    )
    assert (
        phone_callee.callee_check_failures(
            {"credit_expiry": "October 2, 2027"},
            {"credit_expiry": "October 2nd, twenty twenty-seven"},
        )
        == []
    )
    assert phone_callee.callee_check_failures(
        {"credit_expiry": "October 2, 2027"},
        {"credit_expiry": "March 4, 2026"},
    ) == ["credit_expiry: expected to contain 'October 2, 2027', got 'March 4, 2026'"]
