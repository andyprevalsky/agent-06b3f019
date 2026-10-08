"""Real airline hold line for phone hold-queue benchmarks.

The benchmark agent dials a Twilio number we own. The line answers like the
airline did when we called it: the recorded Air Canada greeting and queue
announcement, then the recorded hold music (with its Aeroplan ad) on loop.
After ``hold_seconds`` of connected hold the harness transfers the live call
to the persona Vapi number, whose first message is the representative's
greeting. Nothing in the hold is simulated or compressed: the caller must
survive the full wall-clock queue on one connected call.

    benchmark agent --call_phone_number--> backend Twilio leg --PSTN--> hold line
                                                                          |
                     HoldLineSession.acquire(): lease the line's voice_url |
                       echo TwiML = <Play> entry, <Play loop=0> music      |
                                                                          |
                     HoldLineSession.run(): Calls.json?To=line (inbound)   |
                       connected >= hold_seconds -> <Dial> persona number  |
                                                                          v
                                          persona Vapi assistant: "Hi, thanks for holding..."

Lease: the line's voice_url carries ``rose_lease`` / ``rose_lease_expires`` so
runners on other machines skip a leased or busy line instead of sharing one
mutable TwiML. ``release()`` hangs up any leg still connected and restores the
idle TwiML only while the lease is still ours.

Audio lives in private R2 (never in git). ``python -m benchmarks.phone_hold_line
publish-audio --source <recording.mp3>`` re-cuts the clips described by the
committed manifest, uploads them, and rewrites the manifest's sha256/bytes.
"""

import argparse
import asyncio
import hashlib
import json
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import parse_qs, urlencode, urlsplit
from xml.sax.saxutils import escape

import httpx

from benchmarks.logs import load_env_var

TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01"
TWIML_ECHO_URL = "https://twimlets.com/echo"
HOLD_LINE_FRIENDLY_NAME_PREFIX = "rose-benchmark-hold-line"
LEASE_PARAM = "rose_lease"
LEASE_EXPIRES_PARAM = "rose_lease_expires"
# Cap accidental day-long holds; the inbound Twilio leg itself ends at 4h.
HOLD_LINE_MAX_SECONDS = 14400.0
# Presigned R2 URLs are SigV4 and expire after at most seven days.
PRESIGN_MAX_SECONDS = 7 * 24 * 3600
LEASE_SETTLE_SECONDS = 1.0
# Calls created just before the lease cannot be ours; tolerate small clock skew.
CALL_START_SKEW_SECONDS = 30.0
FIND_POLL_SECONDS = 2.0
FIND_POLL_LONG_SECONDS = 15.0
FIND_POLL_LONG_AFTER_SECONDS = 15 * 60
HOLD_STATUS_POLL_SECONDS = 30.0
TRANSFER_RETRY_SECONDS = 5.0
TRANSFER_DIAL_TIMEOUT_SECONDS = 30
IDLE_TWIML = "<Response><Say>This benchmark line is not taking calls right now.</Say><Hangup/></Response>"

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ENV = str(_REPO_ROOT / "back-end" / ".env")
_AGENTS_ENV = str(_REPO_ROOT / "agents" / ".env")
HOLD_AUDIO_MANIFEST_DIR = Path(__file__).resolve().parent / "fixtures" / "phone_hold"


def _env(name: str) -> str:
    return load_env_var(name, _BACKEND_ENV, _AGENTS_ENV)


def load_hold_audio_manifest(name: str) -> dict:
    path = HOLD_AUDIO_MANIFEST_DIR / f"{name}.json"
    if not path.exists():
        raise RuntimeError(f"Unknown hold audio {name!r}: {path} does not exist")
    manifest = json.loads(path.read_text())
    for clip in ("entry", "loop"):
        spec = (manifest.get("clips") or {}).get(clip) or {}
        if not spec.get("key") or not spec.get("sha256") or not spec.get("bytes"):
            raise RuntimeError(f"Hold audio {name!r} clip {clip!r} is not published (run publish-audio)")
    return manifest


def _r2_client() -> Any:
    import boto3
    from botocore.config import Config

    account_id = _env("R2_ACCOUNT_ID")
    access_key_id = _env("R2_ACCESS_KEY_ID")
    secret_access_key = _env("R2_SECRET_ACCESS_KEY")
    if not (account_id and access_key_id and secret_access_key):
        raise RuntimeError("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for hold audio")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(connect_timeout=15, read_timeout=60, retries={"max_attempts": 5, "mode": "adaptive"}),
    )


def _r2_bucket(manifest: dict) -> str:
    bucket = _env(manifest.get("bucket_env") or "R2_BUCKET_TRACE_ARCHIVE")
    if not bucket:
        raise RuntimeError("Hold audio bucket is not configured")
    return bucket


def presign_hold_audio(manifest: dict, expires_seconds: int, client: Any = None) -> dict[str, str]:
    """Verify each published clip in R2, then return private presigned GET URLs."""
    client = client or _r2_client()
    bucket = _r2_bucket(manifest)
    expires_seconds = max(60, min(int(expires_seconds), PRESIGN_MAX_SECONDS))
    urls: dict[str, str] = {}
    for clip in ("entry", "loop"):
        spec = manifest["clips"][clip]
        head = client.head_object(Bucket=bucket, Key=spec["key"])
        stored_sha = (head.get("Metadata") or {}).get("sha256", "")
        if int(head.get("ContentLength") or 0) != int(spec["bytes"]) or stored_sha != spec["sha256"]:
            raise RuntimeError(f"Hold audio clip {spec['key']} does not match its manifest; republish it")
        urls[clip] = client.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": spec["key"]}, ExpiresIn=expires_seconds
        )
    return urls


def hold_line_twiml(entry_url: str, loop_url: str) -> str:
    return f'<Response><Play>{escape(entry_url)}</Play><Play loop="0">{escape(loop_url)}</Play></Response>'


def transfer_twiml(caller_id: str, representative_number: str) -> str:
    return (
        "<Response>"
        f'<Dial callerId="{escape(caller_id)}" timeout="{TRANSFER_DIAL_TIMEOUT_SECONDS}">'
        f"<Number>{escape(representative_number)}</Number>"
        "</Dial>"
        "<Hangup/>"
        "</Response>"
    )


def echo_voice_url(twiml: str, lease_id: str = "", lease_expires: Optional[float] = None) -> str:
    params = {"Twiml": twiml}
    if lease_id:
        params[LEASE_PARAM] = lease_id
        params[LEASE_EXPIRES_PARAM] = str(int(lease_expires or 0))
    return f"{TWIML_ECHO_URL}?{urlencode(params)}"


def parse_lease(voice_url: str) -> tuple[str, float]:
    query = parse_qs(urlsplit(voice_url or "").query)
    lease_id = (query.get(LEASE_PARAM) or [""])[0]
    try:
        expires = float((query.get(LEASE_EXPIRES_PARAM) or ["0"])[0])
    except ValueError:
        expires = 0.0
    return lease_id, expires


def _twilio_time(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class TwilioRestClient:
    """The few Twilio REST calls a hold line needs (numbers + calls)."""

    def __init__(
        self,
        account_sid: str = "",
        auth_token: str = "",
        *,
        base_url: str = TWILIO_API_BASE_URL,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.account_sid = account_sid or _env("TWILIO_ACCOUNT_SID")
        auth_token = auth_token or _env("TWILIO_AUTH_TOKEN")
        if not (self.account_sid and auth_token):
            raise RuntimeError("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for the benchmark hold line")
        self._client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/Accounts/{self.account_sid}",
            auth=(self.account_sid, auth_token),
            timeout=30,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def list_hold_lines(self) -> list[dict]:
        resp = await self._client.get("/IncomingPhoneNumbers.json", params={"PageSize": 100})
        resp.raise_for_status()
        numbers = resp.json().get("incoming_phone_numbers") or []
        return [n for n in numbers if str(n.get("friendly_name") or "").startswith(HOLD_LINE_FRIENDLY_NAME_PREFIX)]

    async def get_number(self, number_sid: str) -> dict:
        resp = await self._client.get(f"/IncomingPhoneNumbers/{number_sid}.json")
        resp.raise_for_status()
        return resp.json()

    async def set_voice_url(self, number_sid: str, voice_url: str) -> dict:
        resp = await self._client.post(
            f"/IncomingPhoneNumbers/{number_sid}.json", data={"VoiceUrl": voice_url, "VoiceMethod": "GET"}
        )
        resp.raise_for_status()
        return resp.json()

    async def list_calls(self, to: str, status: str) -> list[dict]:
        resp = await self._client.get("/Calls.json", params={"To": to, "Status": status, "PageSize": 50})
        resp.raise_for_status()
        return resp.json().get("calls") or []

    async def get_call(self, call_sid: str) -> dict:
        resp = await self._client.get(f"/Calls/{call_sid}.json")
        resp.raise_for_status()
        return resp.json()

    async def update_call(self, call_sid: str, **fields: str) -> httpx.Response:
        return await self._client.post(f"/Calls/{call_sid}.json", data=fields)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class HoldLineSession:
    """Lease one benchmark hold line, hold its first caller, transfer to the representative."""

    hold_seconds: float
    audio_manifest: dict
    representative_number: str
    lease_seconds: float
    api: Any = None
    presign: Callable[[dict, int], dict[str, str]] = presign_hold_audio
    now: Callable[[], datetime] = _utcnow
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    lease_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    number: str = ""
    number_sid: str = ""
    leased_at: Optional[datetime] = None
    inbound_call_sids: list[str] = field(default_factory=list)
    hangups_before_transfer: list[dict] = field(default_factory=list)
    transferred_call_sid: str = ""
    transferred_at: Optional[datetime] = None
    hold_seconds_observed: Optional[float] = None

    def __post_init__(self) -> None:
        if isinstance(self.hold_seconds, bool) or not isinstance(self.hold_seconds, (int, float)):
            raise ValueError("hold_line.hold_seconds must be a number")
        if not 0 < self.hold_seconds <= HOLD_LINE_MAX_SECONDS:
            raise ValueError(
                f"hold_line.hold_seconds={self.hold_seconds} must be within (0, {HOLD_LINE_MAX_SECONDS:.0f}]"
            )
        if not self.representative_number:
            raise ValueError("hold line needs a representative number to transfer to")
        self.api = self.api or TwilioRestClient()

    async def acquire(self) -> str:
        """Lease the first idle hold line and point it at this session's hold TwiML."""
        lines = sorted(await self.api.list_hold_lines(), key=lambda n: str(n.get("phone_number") or ""))
        if not lines:
            raise RuntimeError(
                f"No Twilio number has a friendly name starting with {HOLD_LINE_FRIENDLY_NAME_PREFIX!r}; "
                "designate an unused number as the benchmark hold line"
            )
        urls = await asyncio.to_thread(self.presign, self.audio_manifest, int(self.lease_seconds))
        twiml = hold_line_twiml(urls["entry"], urls["loop"])
        busy: list[str] = []
        for line in lines:
            number = str(line.get("phone_number") or "")
            started = self.now()
            lease_id, expires = parse_lease(str(line.get("voice_url") or ""))
            if lease_id and expires > started.timestamp():
                busy.append(f"{number} leased")
                continue
            if any(c.get("direction") == "inbound" for c in await self.api.list_calls(number, "in-progress")):
                busy.append(f"{number} has a connected caller")
                continue
            expires_at = started.timestamp() + self.lease_seconds
            await self.api.set_voice_url(line["sid"], echo_voice_url(twiml, self.lease_id, expires_at))
            await self.sleep(LEASE_SETTLE_SECONDS)
            current = await self.api.get_number(line["sid"])
            if parse_lease(str(current.get("voice_url") or ""))[0] != self.lease_id:
                busy.append(f"{number} lost lease race")
                continue
            self.number, self.number_sid, self.leased_at = number, line["sid"], started
            return number
        raise RuntimeError(f"Every benchmark hold line is busy: {', '.join(busy)}")

    def _is_ours(self, call: dict) -> bool:
        started = _twilio_time(call.get("start_time"))
        return (
            call.get("direction") == "inbound"
            and started is not None
            and self.leased_at is not None
            and started >= self.leased_at - timedelta(seconds=CALL_START_SKEW_SECONDS)
        )

    async def _next_inbound_call(self) -> Optional[dict]:
        handled = {h["call_sid"] for h in self.hangups_before_transfer}
        calls = [
            c
            for c in await self.api.list_calls(self.number, "in-progress")
            if self._is_ours(c) and c.get("sid") not in handled
        ]
        return min(calls, key=lambda c: _twilio_time(c.get("start_time"))) if calls else None

    async def run(self) -> None:
        """Watch for the caller, hold it for hold_seconds, then transfer to the representative."""
        find_started = self.now()
        while self.transferred_at is None:
            try:
                call = await self._next_inbound_call()
                if call is not None:
                    await self._hold_then_transfer(call)
                    continue
            except httpx.HTTPError as exc:
                print(f"    ⚠ hold line poll failed ({type(exc).__name__}); retrying")
            waited = (self.now() - find_started).total_seconds()
            await self.sleep(FIND_POLL_LONG_SECONDS if waited >= FIND_POLL_LONG_AFTER_SECONDS else FIND_POLL_SECONDS)

    async def _hold_then_transfer(self, call: dict) -> None:
        sid = str(call["sid"])
        answered = _twilio_time(call.get("start_time")) or self.now()
        if sid not in self.inbound_call_sids:
            self.inbound_call_sids.append(sid)
            print(f"    📞 Hold line {self.number} answered {sid[:10]}; holding {self.hold_seconds:.0f}s")
        while True:
            elapsed = (self.now() - answered).total_seconds()
            if elapsed >= self.hold_seconds:
                twiml = transfer_twiml(self.number, self.representative_number)
                resp = await self.api.update_call(sid, Twiml=twiml)
                if resp.status_code < 300:
                    self.transferred_call_sid, self.transferred_at = sid, self.now()
                    self.hold_seconds_observed = elapsed
                    print(f"    ✓ Hold line transferred {sid[:10]} to the representative after {elapsed:.0f}s")
                    return
                print(f"    ⚠ Hold line transfer failed: {resp.status_code} {resp.text[:200]}")
                await self.sleep(TRANSFER_RETRY_SECONDS)
            else:
                await self.sleep(min(self.hold_seconds - elapsed, HOLD_STATUS_POLL_SECONDS))
            status = str((await self.api.get_call(sid)).get("status") or "")
            if status != "in-progress":
                held = round((self.now() - answered).total_seconds(), 1)
                self.hangups_before_transfer.append({"call_sid": sid, "status": status, "held_seconds": held})
                print(f"    ⚠ Hold line caller {sid[:10]} left the queue after {held:.0f}s ({status})")
                return

    def stayed_on_hold(self) -> bool:
        return (
            self.transferred_at is not None
            and not self.hangups_before_transfer
            and (self.hold_seconds_observed or 0) >= self.hold_seconds
        )

    def evidence(self) -> dict:
        return {
            "hold_line_number": self.number,
            "hold_seconds_required": self.hold_seconds,
            "inbound_call_sids": list(self.inbound_call_sids),
            "hangups_before_transfer": list(self.hangups_before_transfer),
            "transferred_call_sid": self.transferred_call_sid,
            "transferred_at": self.transferred_at.isoformat() if self.transferred_at else "",
            "hold_seconds_observed": self.hold_seconds_observed,
        }

    async def release(self) -> None:
        """Hang up our callers still on the line, then restore the idle TwiML if the lease is ours."""
        try:
            if self.number_sid:
                await self._hang_up_our_callers()
                await self._restore_idle_twiml()
                self.number_sid = ""
        finally:
            aclose = getattr(self.api, "aclose", None)
            if aclose is not None:
                await aclose()

    async def _hang_up_our_callers(self) -> None:
        try:
            for call in await self.api.list_calls(self.number, "in-progress"):
                if self._is_ours(call):
                    await self.api.update_call(str(call["sid"]), Status="completed")
        except httpx.HTTPError as exc:
            print(f"    ⚠ Failed to hang up hold line callers: {exc}")

    async def _restore_idle_twiml(self) -> None:
        try:
            current = await self.api.get_number(self.number_sid)
            if parse_lease(str(current.get("voice_url") or ""))[0] == self.lease_id:
                await self.api.set_voice_url(self.number_sid, echo_voice_url(IDLE_TWIML))
        except httpx.HTTPError as exc:
            print(f"    ⚠ Failed to restore idle hold line TwiML: {exc}")


def _cut_clip(source: Path, segments: list, out_path: Path) -> None:
    """Concatenate [start, end] spans and {"silence": s} gaps into one telephone-grade MP3."""
    inputs: list[str] = []
    filters: list[str] = []
    total = 0.0
    for index, segment in enumerate(segments):
        if isinstance(segment, dict):
            length = float(segment["silence"])
            inputs += ["-f", "lavfi", "-t", str(length), "-i", "anullsrc=r=22050:cl=mono"]
        else:
            start, end = segment
            length = float(end) - float(start)
            inputs += ["-ss", str(start), "-t", f"{length:.3f}", "-i", str(source)]
        total += length
        filters.append(f"[{index}:a]aresample=22050,aformat=channel_layouts=mono[s{index}]")
    joined = "".join(f"[s{i}]" for i in range(len(segments)))
    # Short fades keep <Play loop="0"> seams from clicking.
    fades = f"afade=t=in:d=0.02,afade=t=out:st={max(0.0, total - 0.3):.3f}:d=0.3"
    filters.append(f"{joined}concat=n={len(segments)}:v=0:a=1,{fades}[out]")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            *inputs,
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[out]",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "32k",
            "-ar",
            "22050",
            "-ac",
            "1",
            str(out_path),
        ],
        check=True,
    )


def _duration_seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return round(float(out.stdout.strip()), 2)


def publish_hold_audio(name: str, source: Path, client: Any = None) -> dict:
    """Cut the manifest's clips from the source recording, upload privately, record digests."""
    path = HOLD_AUDIO_MANIFEST_DIR / f"{name}.json"
    manifest = json.loads(path.read_text())
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    expected_source = (manifest.get("source") or {}).get("sha256")
    if expected_source and expected_source != source_sha:
        raise RuntimeError(f"{source} is not the recording this manifest was cut from")
    client = client or _r2_client()
    bucket = _r2_bucket(manifest)
    with tempfile.TemporaryDirectory() as tmp:
        for clip, spec in manifest["clips"].items():
            out = Path(tmp) / f"{clip}.mp3"
            _cut_clip(source, spec["segments"], out)
            body = out.read_bytes()
            spec["sha256"] = hashlib.sha256(body).hexdigest()
            spec["bytes"] = len(body)
            spec["duration_seconds"] = _duration_seconds(out)
            client.put_object(
                Bucket=bucket,
                Key=spec["key"],
                Body=body,
                ContentType="audio/mpeg",
                Metadata={"sha256": spec["sha256"]},
            )
            print(f"uploaded {spec['key']} ({spec['bytes']} bytes, {spec['duration_seconds']}s)")
    manifest["source"] = {**(manifest.get("source") or {}), "sha256": source_sha}
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main(argv: Optional[list[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    publish = sub.add_parser("publish-audio", help="cut and upload a hold recording's clips to private R2")
    publish.add_argument("--name", default="air-canada-2026-10-06")
    publish.add_argument("--source", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "publish-audio":
        publish_hold_audio(args.name, args.source)


if __name__ == "__main__":
    main()
