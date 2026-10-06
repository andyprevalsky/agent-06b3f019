"""Vapi-backed inbound callee for phone-call benchmarks.

Gives phone benchmarks a programmatically-controlled counterparty: a real
phone number we own, answered by a Vapi voice assistant playing a persona
(a client, a merchant, ...). The benchmark agent places a real outbound call
via its `call_phone_number` tool, the two AIs talk, and we verify BOTH sides:

    benchmark harness (run_benchmark.py)
      |  1. PhoneCalleeSession.setup()
      |     - ensure benchmark inbound number exists   (Vapi API)
      |     - create persona assistant + attach it     (Vapi API)
      |  2. create agent with goal "...call {callee_phone_number}..."
      v
    agent worker --> call_phone_number tool --> backend /api/vapi/call
      |                                              |
      |                                              v
      |                                     Vapi outbound leg (PSTN)
      |                                              |
      |                                              v
      |                              benchmark number -> persona assistant
      v
    3. agent-side verification: expected findings in agent output/transcript
    4. optional callee tool: complete_test_payment -> public benchmark URL
       -> backend /api/test-payment/vapi-phone-payment-tool -> Stripe test
       PaymentIntent
    5. callee-side verification: persona's analysis.structuredData via
       GET /call?phoneNumberId=... (did the caller actually ask for the
       name/address? did they provide the card number? ...)
    6. PhoneCalleeSession.cleanup(): end live persona calls, detach, then delete
       persona assistant/tools

With phone_persona.hold_line the agent dials a leased Twilio hold line
instead (benchmarks/phone_hold_line.py): recorded airline queue audio for
hold_seconds, then a <Dial> transfer to the persona number above, so the
persona is the representative who picks up after the wait.

Each session owns a transient inbound number. Cloud fleet benchmarks run in
separate processes and machines, so an in-process lock cannot protect one
mutable phone-number-to-assistant attachment across distributed runners.
"""

import asyncio
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx

from benchmarks.logs import load_env_var
from benchmarks.phone_hold_line import HoldLineSession, load_hold_audio_manifest

VAPI_BASE_URL = "https://api.vapi.ai"
CALLEE_NUMBER_NAME = "rose-benchmark-callee"
CALLEE_SESSION_NUMBER_PREFIX = f"{CALLEE_NUMBER_NAME}-session-"
CALLEE_NUMBER_ID_ENV = "BENCHMARK_CALLEE_PHONE_NUMBER_ID"
CALLEE_NUMBER_IDS_ENV = "BENCHMARK_CALLEE_PHONE_NUMBER_IDS"
CALLEE_SESSION_NUMBER_TTL = timedelta(hours=5)
# Vapi documents a "couple of minutes" before free numbers become functional;
# keep a small propagation margin so benchmark calls never race that boundary.
CALLEE_SESSION_NUMBER_ACTIVATION_DELAY = timedelta(minutes=3)
VAPI_PHONE_NUMBER_NAME_MAX_LENGTH = 40
# The hold line lease outlives the hold plus the representative conversation;
# the margin covers planning before the call and post-call analysis.
HOLD_LINE_LEASE_MARGIN_SECONDS = 3600
CALLEE_ANALYSIS_TIMEOUT_SECONDS = 180
CALLEE_ANALYSIS_TIMEOUT_LONG_SECONDS = 900

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ENV = str(_REPO_ROOT / "back-end" / ".env")
_DEFAULT_SERVICES_JSON = _REPO_ROOT / ".context" / "services.json"
_PAYMENT_AUDIT_PATH_ENV = "PHONE_BENCHMARK_PAYMENT_AUDIT_PATH"
_PAYMENT_AUDIT_JSONL = _REPO_ROOT / ".context" / "phone-benchmark-payments.jsonl"

# Voice/transcriber mirror back-end/src/domains/vapi/config.ts so the callee
# leg behaves like our outbound leg (same STT quality, similar latency).
_CALLEE_ASSISTANT_BASE = {
    "model": {"provider": "openai", "model": "gpt-4o"},
    "voice": {"provider": "11labs", "voiceId": "6fZce9LFNG3iEITDfqZZ"},
    "transcriber": {
        "provider": "deepgram",
        "model": "flux-general-en",
        "language": "en",
        "eotThreshold": 0.7,
        "eotTimeoutMs": 5000,
    },
    "silenceTimeoutSeconds": 30,
    "maxDurationSeconds": 150,
}


def vapi_private_key() -> str:
    return load_env_var("VAPI_PRIVATE_KEY", _BACKEND_ENV)


def _configured_number_id_for_task(task_name: str) -> str:
    """Resolve a stable per-task Vapi number from ``task=id`` assignments.

    Vapi free-number inventory can be empty for every area code. Distributed
    phone tasks also cannot share one mutable number-to-assistant attachment,
    so the fleet needs distinct pre-provisioned numbers rather than a racing
    best-effort create call.
    """
    raw = load_env_var(CALLEE_NUMBER_IDS_ENV, _BACKEND_ENV).strip()
    if not raw:
        return ""
    assignments: dict[str, str] = {}
    for entry in raw.split(","):
        name, separator, number_id = entry.strip().partition("=")
        if not separator or not name or not number_id:
            raise RuntimeError(f"Invalid {CALLEE_NUMBER_IDS_ENV} entry: {entry!r}")
        if name in assignments:
            raise RuntimeError(f"Duplicate {CALLEE_NUMBER_IDS_ENV} task assignment: {name}")
        assignments[name] = number_id
    if task_name not in assignments:
        raise RuntimeError(f"{CALLEE_NUMBER_IDS_ENV} has no assignment for {task_name}")
    return assignments[task_name]


def _session_phone_number_name() -> str:
    """Build a collision-resistant session name within Vapi's API contract."""
    suffix_length = VAPI_PHONE_NUMBER_NAME_MAX_LENGTH - len(CALLEE_SESSION_NUMBER_PREFIX)
    if suffix_length < 8:
        raise RuntimeError("Benchmark callee number prefix leaves insufficient room for a unique suffix")
    return f"{CALLEE_SESSION_NUMBER_PREFIX}{uuid.uuid4().hex[:suffix_length]}"


def benchmark_public_base_url() -> str:
    # BENCHMARK_FRONTEND_URL is report-card/dashboard metadata and is commonly a
    # controller-local URL in cloud runs. It is never a valid server-to-server
    # webhook target for Vapi.
    for key in ("BENCHMARK_PHONE_TOOL_BASE_URL", "PUBLIC_BASE_URL"):
        value = os.environ.get(key, "").strip()
        if value:
            return value.rstrip("/")
    context_dir = os.environ.get("BENCHMARK_CONTEXT_DIR", "").strip()
    services_json = Path(context_dir) / "services.json" if context_dir else _DEFAULT_SERVICES_JSON
    if services_json.exists():
        try:
            services = json.loads(services_json.read_text())
            public_url = ((services.get("urls") or {}).get("public") or "").strip()
            if public_url:
                return public_url.rstrip("/")
        except Exception:
            pass
    raise RuntimeError(
        "Phone payment benchmarks require a public benchmark URL. Start the local "
        "benchmark stack with ngrok or set BENCHMARK_PHONE_TOOL_BASE_URL."
    )


def resolve_callee_prompt(goal: str, callee_number: str, task_name: str) -> str:
    """Substitute {callee_phone_number} in a task prompt, failing loudly if absent."""
    if "{callee_phone_number}" not in goal:
        return goal
    if not callee_number:
        raise RuntimeError(
            f"Task '{task_name}' uses {{callee_phone_number}} but no benchmark "
            f"callee session is active (task must define phone_persona)."
        )
    return goal.replace("{callee_phone_number}", callee_number)


_DIGIT_WORDS = {
    "zero": "0",
    "oh": "0",
    "o": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
}
_DIGIT_WORD_PATTERN = re.compile(
    r"\b(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)"
    r"(?:[\s-]+(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine))+\b",
    re.IGNORECASE,
)


def _normalize_spoken_digit_sequences(text: str) -> str:
    """Turn 'four eight two one' into '4821' without rewriting isolated words."""

    def replace(match: re.Match[str]) -> str:
        return "".join(_DIGIT_WORDS[word.lower()] for word in re.split(r"[\s-]+", match.group(0)))

    return _DIGIT_WORD_PATTERN.sub(replace, text)


_ONES_UNDER_TEN = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
}
_TENS_UNDER_HUNDRED = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_ORDINAL_DAY_WORDS = {
    "first": "1",
    "second": "2",
    "third": "3",
    "fourth": "4",
    "fifth": "5",
    "sixth": "6",
    "seventh": "7",
    "eighth": "8",
    "ninth": "9",
    "tenth": "10",
    "eleventh": "11",
    "twelfth": "12",
    "thirteenth": "13",
    "fourteenth": "14",
    "fifteenth": "15",
    "sixteenth": "16",
    "seventeenth": "17",
    "eighteenth": "18",
    "nineteenth": "19",
    "twentieth": "20",
    "twenty-first": "21",
    "twenty first": "21",
    "twenty-second": "22",
    "twenty second": "22",
    "twenty-third": "23",
    "twenty third": "23",
    "twenty-fourth": "24",
    "twenty fourth": "24",
    "twenty-fifth": "25",
    "twenty fifth": "25",
    "twenty-sixth": "26",
    "twenty sixth": "26",
    "twenty-seventh": "27",
    "twenty seventh": "27",
    "twenty-eighth": "28",
    "twenty eighth": "28",
    "twenty-ninth": "29",
    "twenty ninth": "29",
    "thirtieth": "30",
    "thirty-first": "31",
    "thirty first": "31",
}
_MONTH_NAMES = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
_SPOKEN_0_99_ALT = (
    "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|"
    "one|two|three|four|five|six|seven|eight|nine"
)
_SPOKEN_YEAR_THOUSAND_PATTERN = re.compile(
    rf"\btwo thousand(?: and)?((?:[\s-]+(?:and|{_SPOKEN_0_99_ALT}))*)\b",
    re.IGNORECASE,
)
_SPOKEN_YEAR_20XX_PATTERN = re.compile(
    r"\btwenty[\s-]+((?:twenty|thirty)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?)\b",
    re.IGNORECASE,
)
_SPOKEN_MONTH_DATE_PATTERN = re.compile(
    rf"\b({'|'.join(_MONTH_NAMES)})[\s,]+(?:the\s+)?("
    rf"{'|'.join(sorted(_ORDINAL_DAY_WORDS, key=len, reverse=True))}|\d{{1,2}}"
    rf")(?:st|nd|rd|th)?[\s,]+(\d{{4}})\b",
    re.IGNORECASE,
)


def _spoken_0_99(words: list[str]) -> int | None:
    if not words:
        return 0
    if len(words) == 1:
        if words[0] in _TENS_UNDER_HUNDRED:
            return _TENS_UNDER_HUNDRED[words[0]]
        return _ONES_UNDER_TEN.get(words[0])
    if len(words) == 2 and words[0] in _TENS_UNDER_HUNDRED and words[1] in _ONES_UNDER_TEN:
        return _TENS_UNDER_HUNDRED[words[0]] + _ONES_UNDER_TEN[words[1]]
    return None


def _normalize_spoken_years(text: str) -> str:
    """Turn 'two thousand twenty seven' / 'twenty twenty-seven' into 2027."""

    def from_thousand(match: re.Match[str]) -> str:
        rest = [part.lower() for part in re.split(r"[\s-]+", match.group(1) or "") if part and part.lower() != "and"]
        parsed = _spoken_0_99(rest)
        return str(2000 + parsed) if parsed is not None else match.group(0)

    def from_20xx(match: re.Match[str]) -> str:
        rest = [part.lower() for part in re.split(r"[\s-]+", match.group(1) or "") if part]
        parsed = _spoken_0_99(rest)
        return str(2000 + parsed) if parsed is not None else match.group(0)

    text = _SPOKEN_YEAR_THOUSAND_PATTERN.sub(from_thousand, text)
    return _SPOKEN_YEAR_20XX_PATTERN.sub(from_20xx, text)


def _normalize_spoken_calendar_dates(text: str) -> str:
    """Turn 'October second 2027' into 'October 2, 2027' after years are digitized."""

    def replace(match: re.Match[str]) -> str:
        month, day, year = match.group(1), match.group(2), match.group(3)
        day_key = re.sub(r"\s+", " ", day.lower())
        day_n = _ORDINAL_DAY_WORDS.get(day_key) or _ORDINAL_DAY_WORDS.get(day_key.replace(" ", "-")) or day
        return f"{month} {day_n}, {year}"

    return _SPOKEN_MONTH_DATE_PATTERN.sub(replace, text)


def _normalize_spoken_code_separators(text: str) -> str:
    """Treat spoken dash words like punctuation in codes such as R-O-S-E-4471."""
    return re.sub(r"\b(?:dash|hyphen|minus)\b", "-", text, flags=re.IGNORECASE)


def _squash(text: str) -> str:
    """Lowercase and drop separators so spoken/extracted phone facts can match."""
    normalized = _normalize_spoken_calendar_dates(_normalize_spoken_years(text))
    normalized = _normalize_spoken_code_separators(_normalize_spoken_digit_sequences(normalized))
    return re.sub(r"[\s\-().,/]", "", normalized.lower())


def missing_call_findings(findings: List[str], haystack: str) -> List[str]:
    """Findings not present in the agent's output, tolerant of spacing/punctuation."""
    lowered = haystack.lower()
    squashed = _squash(haystack)
    return [f for f in findings if f.lower() not in lowered and _squash(f) not in squashed]


def phone_search_text(data: dict) -> str:
    """Agent messages + full metadata JSON (includes phoneCall transcript/structuredData)."""
    chunks: List[str] = []
    for message in data.get("messages", []) or []:
        if not isinstance(message, dict):
            continue
        chunks.append(str(message.get("text") or message.get("message") or ""))
        metadata = message.get("metadata")
        if isinstance(metadata, dict):
            chunks.append(json.dumps(metadata))
    return "\n".join(chunks)


def callee_check_failures(expected: dict, actual: dict) -> List[str]:
    """Compare expected callee-side structuredData against what the persona extracted.

    Booleans compare exactly (with lenient 'true'/'false' string coercion);
    strings compare by squashed containment; everything else compares equal.
    """
    failures: List[str] = []
    actual = actual if isinstance(actual, dict) else {}
    for key, want in expected.items():
        got = actual.get(key)
        if isinstance(want, bool):
            got_bool = got if isinstance(got, bool) else str(got).strip().lower() == "true"
            if got_bool != want:
                failures.append(f"{key}: expected {want}, got {got!r}")
        elif isinstance(want, str):
            if _squash(want) not in _squash(str(got or "")):
                failures.append(f"{key}: expected to contain {want!r}, got {got!r}")
        elif got != want:
            failures.append(f"{key}: expected {want!r}, got {got!r}")
    return failures


def phone_payment_audit_path() -> Path:
    override = os.environ.get(_PAYMENT_AUDIT_PATH_ENV, "").strip()
    return Path(override).expanduser().resolve() if override else _PAYMENT_AUDIT_JSONL


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_audit_timestamp(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def payment_audit_structured_data_since(since: Optional[datetime]) -> dict:
    """Return callee-check fields backed by our payment-tool audit log.

    Vapi's post-call structured-data extractor sees the spoken conversation, but
    does not persist custom tool-call results in the call record. The benchmark
    therefore verifies Stripe completion from the backend boundary that processed
    the tool request.
    """
    path = phone_payment_audit_path()
    if not path.exists():
        return {}
    since_utc = (
        since.astimezone(timezone.utc)
        if since and since.tzinfo
        else since.replace(tzinfo=timezone.utc)
        if since
        else None
    )
    latest: Optional[dict] = None
    for raw_line in path.read_text().splitlines():
        try:
            entry = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        created_at = _parse_audit_timestamp(entry.get("createdAt"))
        if since_utc and created_at and created_at < since_utc:
            continue
        if entry.get("status") != "succeeded" or not entry.get("paymentIntentId"):
            continue
        if latest is None or (
            created_at is not None
            and (_parse_audit_timestamp(latest.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc))
            <= created_at
        ):
            latest = entry
    if not latest:
        return {}
    return {
        "payment_completed": True,
        "confirmation_code_given": bool(latest.get("confirmationCode")),
        "payment_tool_succeeded": True,
        "stripe_payment_intent_id": latest.get("paymentIntentId", ""),
        "confirmation_code": latest.get("confirmationCode", ""),
        "total_charged_usd": f"{(latest.get('amountCents') or 0) / 100:.2f}",
    }


class PhoneCalleeSession:
    """Owns the benchmark inbound number + a per-task persona assistant."""

    def __init__(self, task_name: str, persona: dict, api_key: Optional[str] = None):
        if not isinstance(persona, dict) or not persona.get("system_prompt"):
            raise ValueError(f"Task '{task_name}' phone_persona must define system_prompt")
        self.task_name = task_name
        self.persona = persona
        self._api_key = api_key or vapi_private_key()
        if not self._api_key:
            raise RuntimeError(
                "VAPI_PRIVATE_KEY is required for phone benchmarks (set it in "
                "back-end/.env or the environment)."
            )
        self.phone_number: str = ""
        self.phone_number_id: str = ""
        self.phone_number_name = _session_phone_number_name()
        self._owns_phone_number = False
        self._prior_assistant_id: Optional[str] = None
        self.assistant_id: str = ""
        self.tool_ids: List[str] = []
        self.started_at: Optional[datetime] = None
        self._keypad_success_task: Optional[asyncio.Task] = None
        self._keypad_success_announced = False
        self.hold_line: Optional[HoldLineSession] = None
        self._hold_line_task: Optional[asyncio.Task] = None

    @property
    def dial_number(self) -> str:
        """The number the benchmark agent calls: the hold line when one is leased."""
        return self.hold_line.number if self.hold_line else self.phone_number

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    def _keypad_success_config(self) -> Optional[dict]:
        """Optional deterministic IVR success injection after tracking DTMF.

        AI IVR assistants often receive the correct keypad digits but still skip
        the scripted status line. When phone_persona.keypad_success is set, a
        background watcher injects the canned say+end-call via live call control
        as soon as the tracking number appears as a keypad entry.
        """
        config = self.persona.get("keypad_success")
        if not isinstance(config, dict):
            return None
        tracking_number = str(config.get("tracking_number") or "").strip()
        say = str(config.get("say") or "").strip()
        if not tracking_number or not say:
            return None
        return {"tracking_number": tracking_number, "say": say}

    def _hold_line_config(self) -> Optional[dict]:
        """phone_persona.hold_line: {"hold_seconds": N, "audio": "<manifest name>"}."""
        config = self.persona.get("hold_line")
        if config is None:
            return None
        if not isinstance(config, dict) or not str(config.get("audio") or "").strip():
            raise ValueError(f"Task '{self.task_name}' phone_persona.hold_line needs hold_seconds and audio")
        return {"hold_seconds": config.get("hold_seconds"), "audio": str(config["audio"]).strip()}

    def _new_hold_line(self) -> Optional[HoldLineSession]:
        config = self._hold_line_config()
        if config is None:
            return None
        max_duration = self.persona.get("max_duration_seconds") or _CALLEE_ASSISTANT_BASE["maxDurationSeconds"]
        hold_seconds = config["hold_seconds"]
        lease_seconds = (hold_seconds if isinstance(hold_seconds, (int, float)) else 0) + max_duration
        return HoldLineSession(
            hold_seconds=hold_seconds,
            audio_manifest=load_hold_audio_manifest(config["audio"]),
            representative_number=self.phone_number,
            lease_seconds=lease_seconds + HOLD_LINE_LEASE_MARGIN_SECONDS,
        )

    def analysis_timeout_seconds(self) -> int:
        """How long to wait for Vapi structuredData after the inbound call ends.

        Short IVR/payment calls finish analysis inside the default 180s window.
        An hour-long persona call leaves a large artifact; give Vapi 15 minutes.
        """
        max_duration = self.persona.get("max_duration_seconds") or 0
        if isinstance(max_duration, (int, float)) and max_duration >= 3600:
            return CALLEE_ANALYSIS_TIMEOUT_LONG_SECONDS
        return CALLEE_ANALYSIS_TIMEOUT_SECONDS

    async def setup(self) -> None:
        try:
            async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=45) as client:
                await self._ensure_phone_number(client)
                await self._create_persona_tools(client)
                await self._create_persona_assistant(client)
                await self._attach_assistant(client, self.assistant_id)
            self.hold_line = self._new_hold_line()
            if self.hold_line is not None:
                await self.hold_line.acquire()
            self.started_at = _utcnow()
            if self._keypad_success_config() is not None:
                self._keypad_success_task = asyncio.create_task(
                    self._watch_keypad_success_announcement(),
                    name=f"keypad-success-{self.task_name}",
                )
            if self.hold_line is not None:
                self._hold_line_task = asyncio.create_task(self.hold_line.run(), name=f"hold-line-{self.task_name}")
        except BaseException:
            await self.cleanup()
            raise

    async def _ensure_phone_number(self, client: httpx.AsyncClient) -> None:
        resp = await client.get("/phone-number")
        resp.raise_for_status()
        numbers = resp.json() or []
        override_id = load_env_var(CALLEE_NUMBER_ID_ENV, _BACKEND_ENV) or _configured_number_id_for_task(
            self.task_name
        )
        chosen = next((entry for entry in numbers if override_id and entry.get("id") == override_id), None)
        if override_id:
            if chosen is None:
                raise RuntimeError(f"{CALLEE_NUMBER_ID_ENV}={override_id} not found in Vapi phone numbers")
        else:
            await self._reclaim_stale_session_numbers(client, numbers)
            chosen = await self._provision_number(client)
            self._owns_phone_number = True
        self.phone_number_id = chosen["id"]
        self.phone_number = chosen.get("number") or ""
        self._prior_assistant_id = chosen.get("assistantId")
        if not self.phone_number:
            raise RuntimeError(f"Benchmark callee number {self.phone_number_id} has no E.164 number assigned yet")
        if self._owns_phone_number:
            await self._wait_for_number_activation(chosen)

    async def _wait_for_number_activation(self, phone_number: dict) -> None:
        """Honor Vapi's activation window before placing calls to a new free number."""
        created_at = _parse_audit_timestamp(phone_number.get("createdAt"))
        elapsed = datetime.now(timezone.utc) - created_at if created_at else timedelta(0)
        remaining = CALLEE_SESSION_NUMBER_ACTIVATION_DELAY - elapsed
        if remaining.total_seconds() <= 0:
            return
        wait_seconds = remaining.total_seconds()
        print(f"    ⏳ Waiting {wait_seconds:.0f}s for Vapi callee number activation")
        await asyncio.sleep(wait_seconds)

    async def _provision_number(self, client: httpx.AsyncClient) -> dict:
        """Provision a free Vapi US number dedicated to benchmark callees.

        Area-code availability shifts over time; when the preferred code is
        unavailable Vapi's 400 suggests alternatives ("Try one of 619, 442,
        207."), so chase those before giving up.
        """
        area_codes = ["415"]
        last_error = ""
        hint_parsed = False
        while area_codes:
            create = await client.post(
                "/phone-number",
                json={
                    "provider": "vapi",
                    "name": self.phone_number_name,
                    "numberDesiredAreaCode": area_codes.pop(0),
                },
            )
            if create.status_code in (200, 201):
                return create.json()
            last_error = f"{create.status_code} {create.text}"
            if create.status_code == 400 and not area_codes and not hint_parsed:
                hint_parsed = True
                suggested = re.findall(r"\b(\d{3})\b", str(create.json().get("message", "")))
                area_codes = [c for c in suggested if c != "400"][:3]
        raise RuntimeError(
            f"Failed to provision benchmark callee number: {last_error}. "
            f"Provision one in the Vapi dashboard or set "
            f"{CALLEE_NUMBER_ID_ENV}."
        )

    async def _reclaim_stale_session_numbers(self, client: httpx.AsyncClient, numbers: list[dict]) -> None:
        cutoff = datetime.now(timezone.utc) - CALLEE_SESSION_NUMBER_TTL
        for entry in numbers:
            if not str(entry.get("name") or "").startswith(CALLEE_SESSION_NUMBER_PREFIX):
                continue
            created_at = _parse_audit_timestamp(entry.get("createdAt"))
            if created_at is None or created_at >= cutoff:
                continue
            number_id = str(entry.get("id") or "")
            if not number_id:
                continue
            response = await client.delete(f"/phone-number/{number_id}")
            if response.status_code != 200:
                print(f"    ⚠ Failed to reclaim stale callee number {number_id[:8]}: {response.status_code}")

    async def _create_persona_tools(self, client: httpx.AsyncClient) -> None:
        tool_specs = self.persona.get("tools") or []
        if "complete_test_payment" not in tool_specs:
            return
        public_base_url = benchmark_public_base_url()
        config = {
            "type": "function",
            "function": {
                "name": "complete_test_payment",
                "description": (
                    "Submit the collected phone-order card credentials to the Rose Test "
                    "Florist Stripe test payment processor. Call this only after collecting "
                    "card number, expiration, CVC, and billing ZIP."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "card_number": {
                            "type": "string",
                            "description": "Full card number provided by the caller.",
                        },
                        "expiration": {
                            "type": "string",
                            "description": "Card expiration date, for example 12/30.",
                        },
                        "cvc": {"type": "string", "description": "Card CVC."},
                        "billing_zip": {"type": "string", "description": "Billing ZIP code."},
                        "cardholder_name": {
                            "type": "string",
                            "description": "Cardholder name, if provided; otherwise use Rose Labs.",
                        },
                    },
                    "required": ["card_number", "expiration", "cvc", "billing_zip"],
                },
            },
            "server": {"url": f"{public_base_url}/api/test-payment/vapi-phone-payment-tool"},
        }
        resp = await client.post("/tool", json=config)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to create callee payment tool: {resp.status_code} {resp.text}")
        self.tool_ids.append(resp.json()["id"])

    async def _create_persona_assistant(self, client: httpx.AsyncClient) -> None:
        config = dict(_CALLEE_ASSISTANT_BASE)
        config["name"] = f"benchmark-callee-{self.task_name}"[:40]  # Vapi caps assistant names at 40 chars
        config["model"] = {
            **_CALLEE_ASSISTANT_BASE["model"],
            "messages": [{"role": "system", "content": self.persona["system_prompt"]}],
            "tools": [{"type": "endCall"}],
            "temperature": 0,
        }
        if self.tool_ids:
            config["model"]["toolIds"] = self.tool_ids
        if self.persona.get("first_message"):
            config["firstMessage"] = self.persona["first_message"]
        if self.persona.get("end_call_message"):
            # When the IVR LLM short-circuits to endCall after valid tracking DTMF,
            # this guarantees the caller still hears DELIV-9012 / status.
            config["endCallMessage"] = self.persona["end_call_message"]
        keypad_input_plan = self.persona.get("keypad_input_plan")
        if isinstance(keypad_input_plan, dict) and keypad_input_plan:
            config["keypadInputPlan"] = keypad_input_plan
        if isinstance(self.persona.get("silence_timeout_seconds"), int):
            config["silenceTimeoutSeconds"] = self.persona["silence_timeout_seconds"]
        if isinstance(self.persona.get("max_duration_seconds"), int):
            config["maxDurationSeconds"] = self.persona["max_duration_seconds"]
        analysis_plan: dict = {"summaryPlan": {"enabled": True}}
        if self.persona.get("structured_data_schema"):
            analysis_plan["structuredDataPlan"] = {
                "enabled": True,
                "schema": self.persona["structured_data_schema"],
            }
        config["analysisPlan"] = analysis_plan
        # Live call control is required for deterministic keypad_success injection.
        if self._keypad_success_config() is not None:
            config["monitorPlan"] = {"listenEnabled": True, "controlEnabled": True}
        resp = await client.post("/assistant", json=config)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to create callee persona assistant: {resp.status_code} {resp.text}")
        self.assistant_id = resp.json()["id"]

    async def _watch_keypad_success_announcement(self) -> None:
        """Inject the canned IVR success line once tracking DTMF is observed."""
        success = self._keypad_success_config()
        if success is None:
            return
        tracking_number = success["tracking_number"]
        say = success["say"]
        deadline = asyncio.get_event_loop().time() + float(
            self.persona.get("max_duration_seconds") or _CALLEE_ASSISTANT_BASE["maxDurationSeconds"]
        )
        try:
            async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=30) as client:
                while asyncio.get_event_loop().time() < deadline and not self._keypad_success_announced:
                    if not (self.phone_number_id and self.assistant_id):
                        return
                    resp = await client.get(
                        "/call", params={"phoneNumberId": self.phone_number_id, "limit": 10}
                    )
                    resp.raise_for_status()
                    for call in resp.json() or []:
                        if call.get("assistantId") != self.assistant_id:
                            continue
                        if call.get("status") not in {"queued", "ringing", "in-progress"}:
                            continue
                        created_at = str(call.get("createdAt") or "")
                        if self.started_at and created_at:
                            try:
                                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                                if created < self.started_at:
                                    continue
                            except ValueError:
                                pass
                        call_id = str(call.get("id") or "")
                        detailed = call
                        if call_id:
                            detail_resp = await client.get(f"/call/{call_id}")
                            if detail_resp.status_code == 200:
                                detailed = detail_resp.json() or call
                        if not self._call_messages_contain_keypad_tracking(detailed, tracking_number):
                            continue
                        control_url = ((detailed.get("monitor") or call.get("monitor") or {}).get("controlUrl") or "").strip()
                        if not control_url:
                            # controlUrl can lag a moment after the call becomes in-progress
                            continue
                        if not await self._inject_control_say(control_url, say, call_id, "keypad_success"):
                            continue
                        self._keypad_success_announced = True
                        print(
                            f"    ✓ Injected keypad_success announcement for tracking "
                            f"{tracking_number} on call {call_id[:8]}"
                        )
                        return
                    await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"    ⚠ keypad_success watcher error: {exc}")

    async def _inject_control_say(self, control_url: str, say: str, call_id: str, label: str) -> bool:
        """Speak a canned closing line on a live call, then hang up."""
        async with httpx.AsyncClient(timeout=30) as control_client:
            say_resp = await control_client.post(
                control_url,
                json={
                    "type": "say",
                    "content": say,
                    "endCallAfterSpoken": True,
                },
            )
            if say_resp.status_code >= 300:
                print(
                    f"    ⚠ {label} say failed for call "
                    f"{call_id[:8]}: "
                    f"{say_resp.status_code} {say_resp.text[:200]}"
                )
                return False
        return True

    @staticmethod
    def _call_messages_contain_keypad_tracking(call: dict, tracking_number: str) -> bool:
        """True when the inbound call artifact shows keypad entry of the tracking number."""
        chunks: List[str] = []
        for message in call.get("messages") or []:
            if not isinstance(message, dict):
                continue
            chunks.append(str(message.get("message") or message.get("content") or ""))
        artifact = call.get("artifact") or {}
        if isinstance(artifact, dict):
            for message in artifact.get("messages") or []:
                if isinstance(message, dict):
                    chunks.append(str(message.get("message") or message.get("content") or ""))
            transcript = artifact.get("transcript")
            if isinstance(transcript, str):
                chunks.append(transcript)
        haystack = "\n".join(chunks)
        if tracking_number not in haystack:
            return False
        # Prefer explicit keypad labeling when present; still accept bare digits
        # because some call snapshots omit the "Keypad Entry" prefix.
        lowered = haystack.lower()
        return "keypad" in lowered or f"User's Keypad Entry: {tracking_number}" in haystack or tracking_number in haystack

    async def _attach_assistant(self, client: httpx.AsyncClient, assistant_id: Optional[str]) -> None:
        resp = await client.patch(f"/phone-number/{self.phone_number_id}", json={"assistantId": assistant_id})
        if resp.status_code != 200:
            raise RuntimeError(
                f"Failed to attach assistant to callee number {self.phone_number_id}: "
                f"{resp.status_code} {resp.text}"
            )

    async def fetch_callee_structured_data(self, timeout_seconds: Optional[int] = None) -> dict:
        """Poll Vapi for the inbound call answered by this session's persona.

        Call analysis (summary + structuredData) is produced asynchronously after
        the call ends, so poll until it appears or the timeout elapses.
        """
        hold_evidence = self._hold_line_structured_data()
        if hold_evidence:
            print(f"    📞 Hold line evidence: {json.dumps(hold_evidence['hold_line'])}")
            if self.hold_line is not None and self.hold_line.transferred_at is None:
                # Nobody reached the representative, so there is no persona call to analyze.
                return hold_evidence
        if timeout_seconds is None:
            timeout_seconds = self.analysis_timeout_seconds()
        deadline = asyncio.get_event_loop().time() + timeout_seconds
        last_state = "no inbound call observed"
        async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=30) as client:
            while True:
                resp = await client.get("/call", params={"phoneNumberId": self.phone_number_id, "limit": 20})
                resp.raise_for_status()
                for call in resp.json() or []:
                    if call.get("assistantId") != self.assistant_id:
                        continue
                    created_at = str(call.get("createdAt") or "")
                    if self.started_at and created_at:
                        try:
                            created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                            if created < self.started_at:
                                continue
                        except ValueError:
                            pass
                    analysis = call.get("analysis") or {}
                    structured = analysis.get("structuredData")
                    if isinstance(structured, dict):
                        return {**structured, **payment_audit_structured_data_since(self.started_at), **hold_evidence}
                    last_state = f"call {call.get('id')} status={call.get('status')} awaiting analysis"
                if asyncio.get_event_loop().time() >= deadline:
                    raise RuntimeError(f"Timed out waiting for callee-side call analysis ({last_state})")
                await asyncio.sleep(5)

    def _hold_line_structured_data(self) -> dict:
        """Callee-check fields observed on the hold line itself, not inferred by the persona."""
        if self.hold_line is None:
            return {}
        return {"caller_stayed_on_hold": self.hold_line.stayed_on_hold(), "hold_line": self.hold_line.evidence()}

    async def _end_active_persona_calls(self, client: httpx.AsyncClient) -> None:
        if not (self.phone_number_id and self.assistant_id):
            return
        resp = await client.get("/call", params={"phoneNumberId": self.phone_number_id, "limit": 20})
        resp.raise_for_status()
        for call in resp.json() or []:
            if call.get("assistantId") != self.assistant_id:
                continue
            if call.get("status") not in {"queued", "ringing", "in-progress"}:
                continue
            created_at = str(call.get("createdAt") or "")
            if self.started_at and created_at:
                try:
                    created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                    if created < self.started_at:
                        continue
                except ValueError:
                    pass
            control_url = ((call.get("monitor") or {}).get("controlUrl") or "").strip()
            if not control_url:
                continue
            try:
                async with httpx.AsyncClient(timeout=30) as control_client:
                    await control_client.post(control_url, json={"type": "end-call"})
            except Exception as exc:
                print(f"    ⚠ Failed to end active callee call {str(call.get('id', ''))[:8]}: {exc}")

    async def _delete_owned_phone_number(self, client: httpx.AsyncClient) -> None:
        if not (self._owns_phone_number and self.phone_number_id):
            return
        response = await client.delete(f"/phone-number/{self.phone_number_id}")
        if response.status_code != 200:
            raise RuntimeError(
                f"Failed to delete callee number {self.phone_number_id}: "
                f"{response.status_code} {response.text}"
            )
        self._owns_phone_number = False
        self.phone_number_id = ""
        self.phone_number = ""

    async def _cancel_background_task(self, task: Optional[asyncio.Task], label: str) -> None:
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            print(f"    ⚠ {label} watcher cleanup error: {exc}")

    async def cleanup(self) -> None:
        """Best-effort: detach and delete every resource owned by this session."""
        await self._cancel_background_task(self._keypad_success_task, "keypad_success")
        self._keypad_success_task = None
        await self._cancel_background_task(self._hold_line_task, "hold_line")
        self._hold_line_task = None
        if self.hold_line is not None:
            await self.hold_line.release()
        try:
            async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=30) as client:
                try:
                    await self._end_active_persona_calls(client)
                except Exception as exc:
                    print(f"    ⚠ Failed to end active callee calls: {exc}")
                if self.phone_number_id and self.assistant_id:
                    try:
                        await self._attach_assistant(client, self._prior_assistant_id)
                    except Exception as exc:
                        print(f"    ⚠ Failed to detach callee assistant: {exc}")
                if self.assistant_id:
                    try:
                        await client.delete(f"/assistant/{self.assistant_id}")
                    except Exception as exc:
                        print(f"    ⚠ Failed to delete callee assistant {self.assistant_id[:8]}: {exc}")
                    self.assistant_id = ""
                for tool_id in self.tool_ids:
                    try:
                        await client.delete(f"/tool/{tool_id}")
                    except Exception as exc:
                        print(f"    ⚠ Failed to delete callee tool {tool_id[:8]}: {exc}")
                self.tool_ids = []
                try:
                    await self._delete_owned_phone_number(client)
                except Exception as exc:
                    print(f"    ⚠ Failed to delete callee number {self.phone_number_id[:8]}: {exc}")
        except Exception as exc:
            print(f"    ⚠ Callee cleanup error: {exc}")
