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

The inbound phone number is a persistent, shared resource (one per Vapi
account, named `rose-benchmark-callee`); only the persona assistant is
per-task. A module-level lock serializes phone tasks within a run so two
tasks never fight over the number's attached assistant.
"""

import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import httpx

from benchmarks.logs import load_env_var

VAPI_BASE_URL = "https://api.vapi.ai"
CALLEE_NUMBER_NAME = "rose-benchmark-callee"
CALLEE_NUMBER_ID_ENV = "BENCHMARK_CALLEE_PHONE_NUMBER_ID"

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ENV = str(_REPO_ROOT / "back-end" / ".env")
_SERVICES_JSON = _REPO_ROOT / ".context" / "services.json"
_PAYMENT_AUDIT_PATH_ENV = "PHONE_BENCHMARK_PAYMENT_AUDIT_PATH"
_PAYMENT_AUDIT_JSONL = _REPO_ROOT / ".context" / "phone-benchmark-payments.jsonl"

# One inbound number is shared by all phone tasks — serialize sessions so a
# parallel suite run never swaps the number's assistant mid-call.
_callee_lock = asyncio.Lock()

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


def benchmark_public_base_url() -> str:
    for key in ("BENCHMARK_PHONE_TOOL_BASE_URL", "BENCHMARK_FRONTEND_URL", "PUBLIC_BASE_URL"):
        value = os.environ.get(key, "").strip()
        if value:
            return value.rstrip("/")
    if _SERVICES_JSON.exists():
        try:
            services = json.loads(_SERVICES_JSON.read_text())
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


def _normalize_spoken_code_separators(text: str) -> str:
    """Treat spoken dash words like punctuation in codes such as R-O-S-E-4471."""
    return re.sub(r"\b(?:dash|hyphen|minus)\b", "-", text, flags=re.IGNORECASE)


def _squash(text: str) -> str:
    """Lowercase and drop separators so spoken/extracted phone facts can match."""
    normalized = _normalize_spoken_code_separators(_normalize_spoken_digit_sequences(text))
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
        self.assistant_id: str = ""
        self.tool_ids: List[str] = []
        self.started_at: Optional[datetime] = None
        self._lock_held = False

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    async def setup(self) -> None:
        await _callee_lock.acquire()
        self._lock_held = True
        try:
            async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=45) as client:
                await self._ensure_phone_number(client)
                await self._create_persona_tools(client)
                await self._create_persona_assistant(client)
                await self._attach_assistant(client, self.assistant_id)
            self.started_at = datetime.now(timezone.utc)
        except BaseException:
            await self.cleanup()
            raise

    async def _ensure_phone_number(self, client: httpx.AsyncClient) -> None:
        resp = await client.get("/phone-number")
        resp.raise_for_status()
        numbers = resp.json() or []
        override_id = load_env_var(CALLEE_NUMBER_ID_ENV, _BACKEND_ENV)
        chosen = None
        for entry in numbers:
            if override_id and entry.get("id") == override_id:
                chosen = entry
                break
            if not override_id and entry.get("name") == CALLEE_NUMBER_NAME:
                chosen = entry
                break
        if chosen is None and override_id:
            raise RuntimeError(f"{CALLEE_NUMBER_ID_ENV}={override_id} not found in Vapi phone numbers")
        if chosen is None:
            chosen = await self._provision_number(client)
        self.phone_number_id = chosen["id"]
        self.phone_number = chosen.get("number") or ""
        if not self.phone_number:
            raise RuntimeError(f"Benchmark callee number {self.phone_number_id} has no E.164 number assigned yet")

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
                json={"provider": "vapi", "name": CALLEE_NUMBER_NAME, "numberDesiredAreaCode": area_codes.pop(0)},
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
            f"Provision one in the Vapi dashboard named '{CALLEE_NUMBER_NAME}' or set "
            f"{CALLEE_NUMBER_ID_ENV}."
        )

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
        }
        if self.tool_ids:
            config["model"]["toolIds"] = self.tool_ids
        if self.persona.get("first_message"):
            config["firstMessage"] = self.persona["first_message"]
        analysis_plan: dict = {"summaryPlan": {"enabled": True}}
        if self.persona.get("structured_data_schema"):
            analysis_plan["structuredDataPlan"] = {
                "enabled": True,
                "schema": self.persona["structured_data_schema"],
            }
        config["analysisPlan"] = analysis_plan
        resp = await client.post("/assistant", json=config)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to create callee persona assistant: {resp.status_code} {resp.text}")
        self.assistant_id = resp.json()["id"]

    async def _attach_assistant(self, client: httpx.AsyncClient, assistant_id: Optional[str]) -> None:
        resp = await client.patch(f"/phone-number/{self.phone_number_id}", json={"assistantId": assistant_id})
        if resp.status_code != 200:
            raise RuntimeError(
                f"Failed to attach assistant to callee number {self.phone_number_id}: "
                f"{resp.status_code} {resp.text}"
            )

    async def fetch_callee_structured_data(self, timeout_seconds: int = 180) -> dict:
        """Poll Vapi for the inbound call answered by this session's persona.

        Call analysis (summary + structuredData) is produced asynchronously after
        the call ends, so poll until it appears or the timeout elapses.
        """
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
                        return {**structured, **payment_audit_structured_data_since(self.started_at)}
                    last_state = f"call {call.get('id')} status={call.get('status')} awaiting analysis"
                if asyncio.get_event_loop().time() >= deadline:
                    raise RuntimeError(f"Timed out waiting for callee-side call analysis ({last_state})")
                await asyncio.sleep(5)

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

    async def cleanup(self) -> None:
        """Best-effort: detach + delete persona assistant, then release the lock."""
        try:
            async with httpx.AsyncClient(base_url=VAPI_BASE_URL, headers=self._headers(), timeout=30) as client:
                try:
                    await self._end_active_persona_calls(client)
                except Exception as exc:
                    print(f"    ⚠ Failed to end active callee calls: {exc}")
                if self.phone_number_id and self.assistant_id:
                    try:
                        await self._attach_assistant(client, None)
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
        except Exception as exc:
            print(f"    ⚠ Callee cleanup error: {exc}")
        finally:
            if self._lock_held:
                self._lock_held = False
                _callee_lock.release()
