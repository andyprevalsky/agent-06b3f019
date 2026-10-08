"""Hold line lifecycle against a fake Twilio REST API and a fake wall clock.

The fake implements the Twilio endpoints the hold line uses (numbers, calls,
call updates) behind httpx.MockTransport, so the real TwilioRestClient request
encoding is exercised. The clock advances only through the session's sleeps,
so a 2.5-hour hold runs instantly while every poll is still counted.
"""

import asyncio
import functools
import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from urllib.parse import parse_qs, urlsplit

import httpx

from benchmarks import phone_hold_line as hl

LINE = "+18555550100"
REP = "+16195550142"
CALLER = "+14155550123"
START = datetime(2026, 10, 6, 14, 0, tzinfo=timezone.utc)
ENTRY_URL = "https://r2.example/entry.mp3?X-Amz-Credential=a&X-Amz-Signature=b"
LOOP_URL = "https://r2.example/loop.mp3?X-Amz-Credential=c&X-Amz-Signature=d"
HOLD = 9000.0


def async_case(function):
    @functools.wraps(function)
    def run():
        return asyncio.run(function())

    run.async_case = function
    return run


class ClockStopped(Exception):
    pass


class FakeClock:
    def __init__(self, stop_after: float = 4 * 3600):
        self.t = 0.0
        self.stop_after = stop_after
        self.events: list[tuple[float, object]] = []

    def now(self) -> datetime:
        return START + timedelta(seconds=self.t)

    def at(self, t: float, action) -> None:
        self.events.append((t, action))
        self.events.sort(key=lambda event: event[0])

    async def sleep(self, seconds: float) -> None:
        self.t += seconds
        while self.events and self.events[0][0] <= self.t:
            _, action = self.events.pop(0)
            action()
        if self.t > self.stop_after:
            raise ClockStopped()
        await asyncio.sleep(0)


class FakeTwilio:
    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.numbers: dict[str, dict] = {}
        self.calls: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.call_updates: list[tuple[str, dict]] = []
        self.fail_next: dict[str, int] = {}
        self.after_set_voice_url = None

    def add_line(self, sid: str, number: str, voice_url: str = "https://demo.twilio.com/welcome/voice/", name=None):
        self.numbers[sid] = {
            "sid": sid,
            "phone_number": number,
            "friendly_name": name or f"{hl.HOLD_LINE_FRIENDLY_NAME_PREFIX}-{sid}",
            "voice_url": voice_url,
            "voice_method": "POST",
        }

    def add_call(self, sid: str, to: str = LINE, direction: str = "inbound", started: float | None = None):
        when = START + timedelta(seconds=self.clock.t if started is None else started)
        self.calls[sid] = {
            "sid": sid,
            "to": to,
            "from": CALLER,
            "direction": direction,
            "status": "in-progress",
            "start_time": format_datetime(when),
        }

    def end_call(self, sid: str, status: str = "completed") -> None:
        self.calls[sid]["status"] = status

    def _fail(self, key: str):
        if self.fail_next.get(key):
            self.fail_next[key] -= 1
            return httpx.Response(503 if key != "update_call" else 500, json={"message": "fake outage"})
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.split("/Accounts/ACfake", 1)[1]
        self.requests.append((request.method, path))
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()} if request.method == "POST" else {}
        if path == "/IncomingPhoneNumbers.json":
            return httpx.Response(200, json={"incoming_phone_numbers": list(self.numbers.values())})
        if path.startswith("/IncomingPhoneNumbers/"):
            sid = path.split("/")[2].removesuffix(".json")
            if request.method == "POST":
                assert form["VoiceMethod"] == "GET"
                self.numbers[sid]["voice_url"] = form["VoiceUrl"]
                if self.after_set_voice_url:
                    self.after_set_voice_url(sid)
            return httpx.Response(200, json=self.numbers[sid])
        if path == "/Calls.json":
            failure = self._fail("list_calls")
            if failure:
                return failure
            to, status = request.url.params["To"], request.url.params["Status"]
            calls = [c for c in self.calls.values() if c["to"] == to and c["status"] == status]
            return httpx.Response(200, json={"calls": calls})
        sid = path.split("/")[2].removesuffix(".json")
        if request.method == "GET":
            return httpx.Response(200, json=self.calls[sid])
        failure = self._fail("update_call")
        if failure:
            return failure
        self.call_updates.append((sid, form))
        if self.calls[sid]["status"] != "in-progress":
            return httpx.Response(400, json={"code": 21220, "message": "Call is not in-progress"})
        if form.get("Status") == "completed":
            self.calls[sid]["status"] = "completed"
        return httpx.Response(200, json=self.calls[sid])


def _session(clock: FakeClock, twilio: FakeTwilio, **overrides) -> hl.HoldLineSession:
    api = hl.TwilioRestClient("ACfake", "token", transport=httpx.MockTransport(twilio.handler))
    presigned: list[int] = []

    def presign(manifest, expires_seconds):
        presigned.append(expires_seconds)
        return {"entry": ENTRY_URL, "loop": LOOP_URL}

    session = hl.HoldLineSession(
        hold_seconds=overrides.pop("hold_seconds", HOLD),
        audio_manifest={"name": "fake"},
        representative_number=REP,
        lease_seconds=overrides.pop("lease_seconds", 13500),
        api=api,
        presign=presign,
        now=clock.now,
        sleep=clock.sleep,
        **overrides,
    )
    session.presigned = presigned
    return session


def _twiml_of(voice_url: str) -> str:
    return parse_qs(urlsplit(voice_url).query)["Twiml"][0]


@async_case
async def test_acquire_leases_first_idle_line_with_recorded_queue_twiml():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    future = (START + timedelta(hours=1)).timestamp()
    twilio.add_line("PN1", "+18555550097", hl.echo_voice_url("<Response/>", "foreign", future))
    twilio.add_line("PN2", "+18555550098")
    twilio.add_call("CAstale", to="+18555550098")
    twilio.add_line("PN3", LINE)
    twilio.add_line("PN4", "+18555550096", name="Rose Labs")
    session = _session(clock, twilio)

    assert await session.acquire() == LINE
    assert (session.number_sid, session.leased_at) == ("PN3", START)
    assert session.presigned == [13500]
    lease_id, expires = hl.parse_lease(twilio.numbers["PN3"]["voice_url"])
    assert lease_id == session.lease_id and expires == START.timestamp() + 13500
    assert twilio.numbers["PN3"]["voice_url"].startswith(hl.TWIML_ECHO_URL + "?")
    twiml = _twiml_of(twilio.numbers["PN3"]["voice_url"])
    assert twiml == (
        "<Response><Play>https://r2.example/entry.mp3?X-Amz-Credential=a&amp;X-Amz-Signature=b</Play>"
        '<Play loop="0">https://r2.example/loop.mp3?X-Amz-Credential=c&amp;X-Amz-Signature=d</Play></Response>'
    )
    assert twilio.numbers["PN1"]["voice_url"].endswith(f"{hl.LEASE_EXPIRES_PARAM}={int(future)}")
    assert "rose_lease" not in twilio.numbers["PN2"]["voice_url"]


@async_case
async def test_acquire_reclaims_expired_lease_and_fails_closed_when_all_lines_busy():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    expired = (START - timedelta(minutes=1)).timestamp()
    twilio.add_line("PN1", LINE, hl.echo_voice_url("<Response/>", "crashed-runner", expired))
    assert await _session(clock, twilio).acquire() == LINE

    busy = _session(clock, twilio)
    try:
        await busy.acquire()
    except RuntimeError as exc:
        assert "busy" in str(exc) and f"{LINE} leased" in str(exc)
    else:
        raise AssertionError("a live lease must not be shared")

    empty = FakeTwilio(clock)
    empty.add_line("PN9", LINE, name="Rose Labs")
    try:
        await _session(clock, empty).acquire()
    except RuntimeError as exc:
        assert hl.HOLD_LINE_FRIENDLY_NAME_PREFIX in str(exc)
    else:
        raise AssertionError("no designated hold line must fail closed")


@async_case
async def test_acquire_moves_on_when_another_runner_wins_the_lease_race():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", "+18555550101")
    twilio.add_line("PN2", "+18555550102")
    future = (START + timedelta(hours=4)).timestamp()

    def other_runner_overwrites(sid):
        if sid == "PN1":
            twilio.numbers[sid]["voice_url"] = hl.echo_voice_url("<Response/>", "other-runner", future)

    twilio.after_set_voice_url = other_runner_overwrites
    session = _session(clock, twilio)
    assert await session.acquire() == "+18555550102"
    assert hl.parse_lease(twilio.numbers["PN1"]["voice_url"])[0] == "other-runner"


@async_case
async def test_run_holds_the_caller_for_the_full_wait_then_transfers_to_the_representative():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio)
    await session.acquire()
    twilio.add_call("CAold", started=-600)
    clock.at(45, lambda: twilio.add_call("CAagent", direction="outbound-api"))
    clock.at(45, lambda: twilio.add_call("CAhold"))

    await session.run()

    sid, form = twilio.call_updates[-1]
    assert sid == "CAhold"
    assert form["Twiml"] == (
        f'<Response><Dial callerId="{LINE}" timeout="30"><Number>{REP}</Number></Dial><Hangup/></Response>'
    )
    assert [update[0] for update in twilio.call_updates] == ["CAhold"]
    answered = (hl._twilio_time(twilio.calls["CAhold"]["start_time"]) - START).total_seconds()
    assert session.hold_seconds_observed >= HOLD
    assert clock.t - answered < HOLD + hl.HOLD_STATUS_POLL_SECONDS
    assert session.stayed_on_hold() is True
    assert session.evidence() == {
        "hold_line_number": LINE,
        "hold_seconds_required": HOLD,
        "inbound_call_sids": ["CAhold"],
        "hangups_before_transfer": [],
        "transferred_call_sid": "CAhold",
        "transferred_at": session.transferred_at.isoformat(),
        "hold_seconds_observed": session.hold_seconds_observed,
    }
    status_reads = [r for r in twilio.requests if r == ("GET", "/Calls/CAhold.json")]
    assert len(status_reads) <= HOLD / hl.HOLD_STATUS_POLL_SECONDS + 2


@async_case
async def test_caller_who_hangs_up_rejoins_at_the_back_and_fails_stayed_on_hold():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio)
    await session.acquire()
    clock.at(10, lambda: twilio.add_call("CAfirst"))
    clock.at(1800, lambda: twilio.end_call("CAfirst"))
    clock.at(2000, lambda: twilio.add_call("CAsecond"))

    await session.run()

    assert [h["call_sid"] for h in session.hangups_before_transfer] == ["CAfirst"]
    assert 1700 <= session.hangups_before_transfer[0]["held_seconds"] <= 1830
    assert session.transferred_call_sid == "CAsecond"
    assert session.transferred_at >= START + timedelta(seconds=2000 + HOLD)
    assert session.inbound_call_sids == ["CAfirst", "CAsecond"]
    assert session.stayed_on_hold() is False


@async_case
async def test_transfer_and_poll_outages_retry_while_the_caller_stays_connected():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio, hold_seconds=120)
    await session.acquire()
    twilio.add_call("CAhold")
    twilio.fail_next = {"list_calls": 2, "update_call": 1}

    await session.run()

    assert session.transferred_call_sid == "CAhold"
    assert [update[0] for update in twilio.call_updates] == ["CAhold"]
    assert session.stayed_on_hold() is True


@async_case
async def test_caller_gone_at_transfer_time_is_recorded_not_transferred():
    clock = FakeClock(stop_after=200)
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio, hold_seconds=60)
    await session.acquire()
    twilio.add_call("CAhold")
    twilio.fail_next = {"update_call": 1}
    clock.at(62, lambda: twilio.end_call("CAhold", "busy"))

    try:
        await session.run()
    except ClockStopped:
        pass

    assert session.transferred_at is None
    assert session.hangups_before_transfer[0]["status"] == "busy"
    assert session.stayed_on_hold() is False


@async_case
async def test_waiting_for_a_caller_backs_off_after_fifteen_minutes():
    clock = FakeClock(stop_after=12600)
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio)
    await session.acquire()
    try:
        await session.run()
    except ClockStopped:
        pass
    polls = [r for r in twilio.requests if r == ("GET", "/Calls.json")]
    fast = hl.FIND_POLL_LONG_AFTER_SECONDS / hl.FIND_POLL_SECONDS
    slow = (12600 - hl.FIND_POLL_LONG_AFTER_SECONDS) / hl.FIND_POLL_LONG_SECONDS
    assert len(polls) <= fast + slow + 3
    assert session.transferred_at is None and session.stayed_on_hold() is False


@async_case
async def test_release_hangs_up_our_callers_and_restores_idle_only_while_the_lease_is_ours():
    clock = FakeClock()
    twilio = FakeTwilio(clock)
    twilio.add_line("PN1", LINE)
    session = _session(clock, twilio)
    await session.acquire()
    twilio.add_call("CAold", started=-600)
    twilio.add_call("CAours")
    await session.release()
    assert twilio.calls["CAours"]["status"] == "completed"
    assert twilio.calls["CAold"]["status"] == "in-progress"
    assert _twiml_of(twilio.numbers["PN1"]["voice_url"]) == hl.IDLE_TWIML
    assert hl.parse_lease(twilio.numbers["PN1"]["voice_url"]) == ("", 0.0)
    await session.release()

    twilio.end_call("CAold")
    taken = _session(clock, twilio)
    await taken.acquire()
    foreign = hl.echo_voice_url("<Response/>", "next-runner", (START + timedelta(hours=3)).timestamp())
    twilio.numbers["PN1"]["voice_url"] = foreign
    await taken.release()
    assert twilio.numbers["PN1"]["voice_url"] == foreign


def test_presign_verifies_published_clips_and_clamps_expiry():
    class FakeR2:
        def __init__(self, stored_sha: str):
            self.stored_sha = stored_sha
            self.presigned: list[tuple[str, int]] = []

        def head_object(self, Bucket, Key):
            return {"ContentLength": 10, "Metadata": {"sha256": self.stored_sha}}

        def generate_presigned_url(self, operation, Params, ExpiresIn):
            assert operation == "get_object"
            self.presigned.append((Params["Key"], ExpiresIn))
            return f"https://r2.example/{Params['Key']}?sig"

    manifest = {
        "bucket_env": "HOLD_TEST_BUCKET",
        "clips": {
            "entry": {"key": "benchmark-assets/x/entry.mp3", "sha256": "aa", "bytes": 10},
            "loop": {"key": "benchmark-assets/x/loop.mp3", "sha256": "aa", "bytes": 10},
        },
    }
    original_env = hl._env
    hl._env = lambda name: "bucket" if name == "HOLD_TEST_BUCKET" else ""
    try:
        good = FakeR2("aa")
        urls = hl.presign_hold_audio(manifest, 10**9, client=good)
        assert urls == {
            "entry": "https://r2.example/benchmark-assets/x/entry.mp3?sig",
            "loop": "https://r2.example/benchmark-assets/x/loop.mp3?sig",
        }
        assert {expires for _, expires in good.presigned} == {hl.PRESIGN_MAX_SECONDS}
        try:
            hl.presign_hold_audio(manifest, 3600, client=FakeR2("stale"))
        except RuntimeError as exc:
            assert "republish" in str(exc)
        else:
            raise AssertionError("a clip that drifted from its manifest must fail closed")
    finally:
        hl._env = original_env


def test_committed_air_canada_manifest_is_published_and_cut_from_the_real_queue():
    manifest = hl.load_hold_audio_manifest("air-canada-2026-10-06")
    entry, loop = manifest["clips"]["entry"], manifest["clips"]["loop"]
    for clip in (entry, loop):
        assert clip["key"].startswith("benchmark-assets/phone-hold/air-canada-2026-10-06/")
        assert len(clip["sha256"]) == 64 and clip["bytes"] > 0
    assert entry["segments"][0][0] == 0.0
    assert 20 <= entry["duration_seconds"] <= 40
    assert loop["duration_seconds"] >= 15 * 60
    assert entry["segments"][-1][1] == loop["segments"][0][0]
    assert len(manifest["source"]["sha256"]) == 64
    assert json.loads((hl.HOLD_AUDIO_MANIFEST_DIR / "air-canada-2026-10-06.json").read_text()) == manifest
    try:
        hl.load_hold_audio_manifest("missing-recording")
    except RuntimeError as exc:
        assert "does not exist" in str(exc)
    else:
        raise AssertionError("an unknown hold recording must fail closed")


def test_hold_seconds_are_bounded_and_need_a_representative():
    for bad in (0, -5, True, "9000", hl.HOLD_LINE_MAX_SECONDS + 1):
        try:
            hl.HoldLineSession(bad, {}, REP, 100, api=object())
        except ValueError:
            continue
        raise AssertionError(f"hold_seconds={bad!r} must be rejected")
    try:
        hl.HoldLineSession(HOLD, {}, "", 100, api=object())
    except ValueError as exc:
        assert "representative" in str(exc)
    else:
        raise AssertionError("a hold line without a representative must be rejected")
