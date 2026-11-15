"""Cloud-only Rose phone boundary. No provider grants or process-local ownership.

Guidance adapted from Phone Harness 0.3.2; authorization is always server owned.
"""

import asyncio
import contextlib
import hashlib
import json
from typing import Any
from urllib.parse import quote

import httpx

PHONE_GUIDANCE = """Cloud iPhone skill (Phone Harness 0.3.2, Rose adaptation):
Use phone for authorized tasks where the account's dedicated cloud iPhone helps,
including authentication, OTPs, messages, and apps. Use mode=status to inspect
ownership/last receipt without allocating, mode=operation to ensure/reuse the
phone, and mode=release when finished. Observe with screen.text, act, then
verify. To verify without another turn, follow the action with screen.text in the
same response; calls run in order, stop at the first failure, and only reads run
after a tap, launch, press, drag, scroll, key or Home action.
iPhone coordinates are screen points; focus a field before input.text.
Use only supported cloud operations; no CLI, local bridge, Android, or shell.
In mode=operation, set operation to the wire name and args to its arguments:
- screen.text: {"min_confidence": 0.3} returns visible text and tap centers.
- screen.bounds: {} returns the coordinate space for this phone.
- apps.launch: {"name": "Settings", "fresh": false} opens an app; verify
  the foreground screen afterward, because a launch can silently miss.
- apps.list: {"include_system": true} lists installed app identifiers.
- input.tap: {"x": 100, "y": 200}; use centers from the latest screen.text.
- input.press: {"x": 100, "y": 200, "duration": 0.8} holds a point.
- input.drag: {"x1": 100, "y1": 400, "x2": 100, "y2": 200,
  "duration": 0.5, "steps": 10} moves a finger between screen points.
- input.scroll: {"x": 100, "y": 200, "dy": 200, "dx": 0, "steps": 10}
  uses content-space deltas. Observe the changed screen after scrolling.
- input.text: {"s": "text", "delay": 0.03, "keystrokes": false} types
  into the focused field; tap the field first and verify afterward.
- input.keys: {"combo": "enter"}; nav.home: {} presses the Home button.
- credentials.fill_saved: {} asks the backend to use the shared saved-password
  store for the server-verified current app/account. Supported bindings are Apple Account and Google sign-in
  for the server-configured intended identity. Supply no password, credential ref/ID, account, realm,
  or coordinates. The worker/model never reads or types the saved secret.
credentials.fill_saved requires a current successful screen.text result. The backend obtains
trusted bounds and independently verifies the current form/account binding.
When the latest successful operation is screen.text for the current interaction
cursor, use that observation to choose the next action; do not repeat an
identical read unless specific missing information or a state change requires
it. A stale-binding response is a reason to obtain a new observation.
The live host decides which operations are supported. An unsupported response
is a capability limit; do not repeat it or assume back/current-app/tree exists.
Queue/lease timeout is a tool outcome, not a request for user attention. Pending
or UNKNOWN input must never be blindly retried: inspect the durable receipt and
screen, and wait for confirmed cleanup when necessary. Private password refs are not accepted from the worker. credentials.fill_saved
performs its own server-side current form/account binding before using a secret;
completed phone setup or a signed-in account is not a prerequisite for this operation.
Use accessible Gmail push approvals and OTP flows autonomously. When a browser
sign-in asks for device approval, inspect the corresponding account app on the
owned cloud phone when available. Match the account and current sign-in challenge
or number to the browser request; approve only that intended request, then
return to the browser and verify it continued. Never approve an unrelated or ambiguous
login. An installed app alone does not prove it is signed in or can approve.
Continue supported signed-out Apple/Google authentication through the native
and shared saved-credential waterfall below before requesting password help.
If a current request cannot be matched or user presence genuinely blocks
progress, use the existing critical authentication attention path. Queue and
transport failures remain tool outcomes, not user-only auth.
For authorized browser or native phone SMS/OTP challenges, including during boot setup,
inspect the current matching Messages conversation on the owned cloud phone
before asking the user when accessible. Match the intended app/account, current
challenge, recipient, and current challenge timestamp. Enter only the newly
received code for this authorized current task, then verify continuation on the original browser or phone screen.
Never submit an ambiguous, stale, unrelated, or already used code; never reuse an
old or unrelated code, and do not consume codes for unrelated tasks. An accessible
matching code does not require user attention; unavailable or user-only
verification still uses critical help.
For an authorized
current app/account, try an already available native AutoFill suggestion for the
matching account before requesting password help, keeping the password masked.
Use ordinary observed UI taps; do not open Passwords details or search the vault.
Never reveal, extract, copy, or transcribe a saved password into observations,
model messages, tool arguments, or logs. A blank password field alone does not
prove that no saved credential exists. If no matching usable native suggestion
is available, use credentials.fill_saved once with empty args and the actual
observed setup context BEFORE requesting password assistance. Native AutoFill
and the backend saved-password catalog are separate: an empty native suggestion
list does not mean the backend has no saved credential. Do not skip this secure
backend attempt merely because the current screen asks for a password. A filled receipt is only a
private acknowledgment, not sign-in proof; observe and verify. A
phone_credential_unavailable receipt means request the protected user step if an
actual critical password screen blocks progress. Binding/stale errors mean
observe again, never supply a secret or blindly retry. UNKNOWN means inspect
status/receipts, never replay. A saved-password rejection ends autonomous password attempts for that current
sign-in. Request the protected user step only if the current observation confirms
that a critical password step still blocks progress. Do not try another saved-password
source, including credentials.fill_saved after native AutoFill rejection. This rejection
rule takes precedence over every saved-credential fallback below or above.
When user presence is required, request the protected step rather than bypassing
biometric/device authentication.
A filled masked field alone is not sign-in proof: observe and verify the result.
If a password still blocks after saved-credential unavailability/rejection, or a
user-only verification code, existing/owner-only device passcode, or user-presence authentication
(biometrics/trusted-device approval) blocks progress, call
request_user_assistance_for_authentication with targetKind="iphone" and the
matching criticalReason. The browser auth waterfall applies only to browser
targets. Queue expiry, unsupported operations, ordinary navigation, terms and
transport errors are tool outcomes, never reasons to request authentication help.
User completion means observe and verify again, never assume sign-in succeeded.
First-use setup is an account-owned stage of this same task. Read the actual
interaction.setup observation. A phone_setup_required receipt means the original
command did not execute; never replay it blindly. Navigate Apple Account sign-in
autonomously when compatible with the user's goal. The owned active setup context
may provide expectedAccountIdentifier: it is authorized nonsecret personal data
and may be typed normally. Passwords may be supplied by masked native AutoFill
or backend credentials.fill_saved without exposing their value; otherwise use
the protected user form only.
Honor actual user restrictions: mode=setup, action=defer, reasonCode=user_constraint
records a deferral for this task only, then continue permitted work. For an actual
setup blocker use action=block with reasonCode=unsupported,
configuration_unavailable, or observed_signed_out; these do not request attention.
A signed-out screen normally means continue setup; block only when unable to
proceed safely. Do not abandon the original task or claim setup succeeded.
Setup includes the required device settings, not merely Apple Account identity.
Follow setup in order: observe the current screen. Once legitimate OS controls
are reachable, configure Portrait Orientation Lock before other settings/apps.
If an existing blocking private authentication flow prevents those controls,
finish only that legitimate authentication first, then configure portrait lock.
Do not wait for configurationReady to sign in or gain legitimate access. Inspect an already
signed-in Apple Account without signing out after portrait lock is verified.
Read actual interaction.setup.verification: requirementsVersion, each target's
checks/status/current scope, configurationReady, and operationalStatus. A durable
identityVerified record or a last-known confirmed check is not current proof of
all required settings. Inspect existing signed-in state without signing out or
resetting it. Configure authorized required settings autonomously within this
same original task, honoring user restrictions and protected authentication.
After fresh observations, use mode=setup, action=verify with evidenceOperationIds
containing 1..8 successful current broker screen.text observation IDs and verificationTarget.
After any navigation or mutation, obtain a fresh screen.text observation and normally
submit only its latest operation ID with the current setup revision. If multiple
IDs are needed, they must be consecutive screen.text operations ending at the
current cursor, with no intervening tap, scroll, app launch, or other operation.
Never combine an earlier screen with a later screen across an intervening action.
Supported verification targets:
apple_account (the default when omitted), icloud_messages, icloud_keychain,
icloud_contacts,
imessage, receive_address, portrait_lock, device_passcode, gmail, or runtime. Verify iCloud Messages sync and iCloud
Keychain sync separately. iMessage activation/sign-in is separate from iCloud
Messages sync; neither one proves the other. For icloud_contacts, configure
iCloud Contacts sync and verify explicit enabled control state; populated
contact names or counts do not prove the iCloud Contacts setting is on.
For receive_address use only the
server's active expectedReceiveAddress and verify it is actually selected for
receiving, not merely listed. For portrait_lock, open native Settings with
apps.launch name Settings. Only the route since the latest Settings launch
counts, and its first screen.text must show the Settings root with Search; if
Settings resumed a subpage or hid Search, return to the root with Search
visible and launch Settings again. Tap the observed Search, type AssistiveTouch
with input.text keystrokes true and open the observed result. From its detail
page return to the native Touch parent and read the explicit same-row AssistiveTouch On/Off value (only a
trailing native chevron is ignorable). Preserve that original state; the
detail label alone is
not its switch state. If originally Off, open the row, tap its switch once (the
right end of the AssistiveTouch row, not the label) and return
to Touch to confirm the explicit value is now On, then reopen the detail page.
Open the floating AssistiveTouch menu: screen.text does not report that textless
button, which normally rests against the right edge (x 625-750, y 400-1250).
Tap that band away from observed row labels and observe; an unchanged detail
page means it missed, so try another band point, at most three in all, then keep
portrait lock unconfirmed and report that blocker. Once the menu opens, tap the
fresh observed Control Center label center. Keep this native route uninterrupted: after the launch use only
screen.text, screen.bounds, the observed taps, the AssistiveTouch typing and
setup.verify; no other operation (including input.keys, apps.list, Home, drags,
scrolls or presses), other apps/URLs, private/user control or attention
transitions. Submit setup.verify with fresh observations.
phone_portrait_route_unproven means that route broke; operation.result.portraitRoute
names the cursor where it broke and the next expected step. Restart from a new
Settings launch at the root. The
backend reports current portrait_lock status: confirmed is On, disabled is
Off, and unknown is unproven. If the returned
operation.portraitActionHint exists, use its existing input.tap arguments only
at that current evidenceCursor, then observe and verify again. Never reuse a hint
after any intervening action. Verification never taps for you. Close Control
Center and restore the original AssistiveTouch state, confirming its explicit
Touch-parent value again. Do not blindly toggle switches or use operator coordinates.
Public screen media remains unavailable. A portrait frame alone, portrait dimensions, lock labels,
static screenshots and unsupported or ambiguous layouts are not enabled-state proof.
If the native route or original switch state cannot be established, keep readiness
unconfirmed and report that precise blocker without abandoning the original task.
Before Gmail setup, inspect the owned setup checks for the required device passcode.
If absent, navigate the observed OS new-passcode creation flow; select Passcode Options
and 4-Digit Numeric Code before calling credentials.fill_device_passcode with
empty args and the actual seen setup context.
The backend supplies its configured boot passcode privately; never type, reveal,
infer, or include its value, a credential ref, account, or coordinates in model arguments.
After this task's successful creation, use the same empty-args operation on the
standard weak-code warning or confirmation form. The backend chooses only the
owned standard warning acknowledgment or private confirmation input; never tap
the warning separately. An acknowledged receipt permits only confirmation next,
not arbitrary intervening mutations. This covers only the standard weak-code warning,
never enterprise or provider policy. The backend requires its owned stage receipt.
Do not change an existing passcode; never guess, reset, or bypass an existing
unlock, change-code, OS policy, or user-presence requirement. Existing unknown
passcodes use native device_passcode assistance when genuinely blocking.
If provider management disallows changes or passcode modification is restricted,
report setup action=block with reasonCode=configuration_unavailable, not authentication attention.
Do not remove or weaken provider/MDM profiles or alter device management to proceed.
The safe passcodeStatus receipt may be created, acknowledged, confirmed, pending, unknown, or
unavailable; pending/UNKNOWN must not be replayed. A private acknowledgment alone is not enabled-state proof.
Use verificationTarget=device_passcode with fresh broker evidence of the enabled
OS setting; do not claim configurationReady or a known code from typing alone.
After Apple Account sign-in, configure and verify the required iCloud Messages,
iMessage, and receive-address settings before starting Gmail sign-in that may need SMS.
Do not wait for historical message downloads; a configured setting alone is not proof of current SMS receipt.
For Gmail boot setup, use only the active server expectedGoogleAccountIdentifier;
the Apple Account identifier is not the Google account. If Gmail is absent,
install Gmail through the observed App Store UI, then open it and sign in to
that intended Google account. An App Store password prompt for the configured
Apple Account during installation uses the same saved-credential waterfall:
matching masked native AutoFill, then credentials.fill_saved with empty args
using the current observation rule above before password help. This Apple Account is distinct from the Google identity.
The backend must verify the supported existing-password form and exact account;
no caller realm, account, or credential ref is allowed. Preserve unavailable,
rejected, user-presence, stale-binding, and UNKNOWN handling described above;
never retry rejected or uncertain input. Preserve an already matching signed-in account;
do not sign out or switch an unrelated account without authorization. Ordinary
installation and navigation are autonomous; purchases, new terms, unsupported
capabilities, or transport failures are not authentication-attention reasons.
Use matching masked native AutoFill when usable. If no matching usable native
suggestion exists, use credentials.fill_saved once with empty args using the
current observation rule above; the backend verifies the actual Google form and separately configured Google identity.
Never supply a realm, account, credential ref or secret. Missing or ambiguous
credentials mean use protected native attention only when genuinely blocked;
stale binding means observe again, and UNKNOWN means status-only, never replay.
When a password or user-only verification still blocks Google sign-in after
saved-credential unavailability or rejection, use the existing protected native attention path.
Use verificationTarget=gmail with fresh broker observations of the installed
Gmail app signed in to the intended account. App installation alone, an account
suggestion, a sign-in form, or an account label without signed-in context is not
proof. Gmail setup proof is separate from actual browser device approval: match
and approve only the current authorized browser challenge, then verify browser
continuation. Do not claim device approval from Gmail setup or installation.
Supply no phone/account override, OCR text, verdict,
proof status, attempt/revision/epoch or routing IDs.
Labels alone or an address appearing in a list do not prove an enabled toggle
or selected address. If evidence cannot establish the actual control state,
retain unknown and obtain better observations; do not invent success. The backend
independently verifies scoped receipt evidence and decides configurationReady
for the current requirements/version and ownership. User Done only resumes
verification. Current configuration readiness and runtime health are separate:
use verificationTarget=runtime for current health; transient iCloud pause or
delivery failure is not proof that the configured settings were never enabled.
A cloud iPhone may have no SIM. Incoming carrier SMS may require the user to
enable Text Message Forwarding on their primary iPhone if this cloud phone
appears there. Request that device configuration through generic assistance,
not authentication attention. Do not disable iCloud, delete messages, or shorten
history to speed startup. Historical download completion is not a prerequisite
to trying a fresh forwarded SMS. Settings or user Done alone are not proof that
a real carrier SMS arrived. No forwarding verificationTarget exists.
No setting check proves actual SMS/OTP delivery, full message history sync, or
permission to use private password refs. Do not request authentication attention
for a sync/configuration/transport problem unless a genuine protected auth step
blocks progress. Ready never unlocks private refs.
After setup or deferral, reassess the original goal and choose the next action;
setup never automatically replays the interrupted input or replaces the task.
"""

GOOGLE_POLICY_GUIDANCE = """For this explicitly opted-in account, the following Google policy exception is
an authorized alternative to the generic setup block; provider MDM protections remain unchanged.
Only for a current Gmail passcode conflict and provider-blocked passcode creation,
Open https://admin.google.com/ in the ordinary browser when not already at the
Admin console, then inspect the correct Workspace administering the server-configured
Google account using protected saved-credential authentication.
Require verified required admin privilege and explicit user-authorized scope.
Admin privilege alone is not authorization. Only when the server-owned setup
profile enables this exception may you relax that specific Workspace passcode
requirement within the user-authorized scope, including Workspace-wide scope
when explicitly authorized. Verify the full effective scope before changing it;
preserve all other security settings, account policies, and unrelated OU inheritance.
If admin privilege is absent, the Workspace is wrong, scope is uncertain, or the
change exceeds authorization, remain blocked with configuration_unavailable.
Read back the effective policy after an authorized change, then obtain fresh
actual Gmail access evidence. A policy exception is not proof that a device passcode is enabled;
only the backend's typed authorized alternative proof may satisfy boot readiness.
The active owned setup.googlePasscodeExceptionAllowed marker is the authoritative
profile opt-in. For an already observed current Gmail passcode conflict with
provider-blocked creation, if this marker is absent or false, report setup
action=block with reasonCode=configuration_unavailable. Repeated unchanged reads
cannot grant authorization; do not inspect or change admin policy for this exception.
After the authorized flow, use optional
verificationTarget=google_passcode_exception with actual current broker evidence
of usable Gmail for the exact configured Google account. A blocking policy alert,
an account menu alone, or a remembered session is not usable-access proof.
This outcome does not prove admin policy authority or a policy write. Inspect
verification.securityDisposition: passcode_enabled, authorized_google_exception,
or blocked. The exception leaves the actual device_passcode check unchanged;
all other required configuration checks, including Gmail, must still be verified.
"""


def phone_profile_enabled(profile: dict) -> bool:
    """Pure eligibility marker from existing server-owned init/profile responses."""
    marker = profile.get("iphoneCapability") if isinstance(profile, dict) else None
    return isinstance(marker, dict) and marker.get("enabled") is True


def phone_actions(actions: list[str], capability: dict) -> list[str]:
    return [name for name in actions if name != "phone" or capability.get("enabled") is True]


def _identity(*parts: Any) -> str:
    data = json.dumps(parts, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(data.encode()).hexdigest()


_SETUP_WINDOW_REJECTION = "Setup observations must be the current uninterrupted cursor window"
_SETUP_WINDOW_FEEDBACK = {
    "errorCode": "phone_setup_observation_window",
    "error": (
        "Setup evidence must be the current uninterrupted screen.text window. "
        "After navigation, read screen.text again and normally verify only its latest "
        "operation ID with the current setup revision. Do not replay a phone input."
    ),
}


async def _request(client, config, user_id, method, path, payload=None):
    response = await client.request(
        method,
        f"{config.backend.api_url.rstrip('/')}/api/iphone/{path}",
        headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id},
        json=payload,
        timeout=105.0 if path.endswith(("/operations", "/setup")) else 10.0,
    )
    if not response.is_success:
        # Only this exact backend setup rejection maps to local constant feedback.
        # Never reflect response text, URL, headers, input, or exception strings.
        if response.status_code == 409 and path.endswith("/setup") and len(response.content) <= 4096:
            try:
                body = response.json()
            except (ValueError, RecursionError):
                body = None
            if isinstance(body, dict) and body.get("error") == _SETUP_WINDOW_REJECTION:
                return {"_httpStatus": 409, **_SETUP_WINDOW_FEEDBACK}
        return {"_httpStatus": response.status_code}
    data = response.json()
    return data if isinstance(data, dict) else {"_httpStatus": 502}


async def fetch_phone_capability(config, user_id: str, *, client=None) -> dict:
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await fetch_phone_capability(config, user_id, client=owned)
    try:
        data = await _request(client, config, user_id, "GET", "capability")
        return {
            "enabled": data.get("enabled") is True,
            "configured": data.get("configured") is True,
            "setupState": data.get("setupState") if isinstance(data.get("setupState"), str) else None,
        }
    except Exception:
        return {"enabled": False, "configured": False, "setupState": None}


async def fetch_phone_availability(config, user_id: str, task_id: str, *, client=None) -> dict:
    """Server-owned task admission; account eligibility alone never grants access."""
    denied = {"enabled": False, "source": None}
    if not user_id or not task_id:
        return denied
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await fetch_phone_availability(config, user_id, task_id, client=owned)
    try:
        data = await _request(client, config, user_id, "GET", f"availability/{quote(task_id, safe='')}")
        source = data.get("source")
        if data.get("enabled") is True and source in ("ready", "bootstrap", "continuation"):
            return {"enabled": True, "source": source}
    except Exception:
        pass
    return denied


async def observe_phone(config, user_id: str, task_id: str, *, client=None) -> dict:
    """A fresh owned observation before each decision; never use cached entitlement."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await observe_phone(config, user_id, task_id, client=owned)
    capability = await fetch_phone_availability(config, user_id, task_id, client=client)
    if not capability["enabled"] or not task_id:
        return {"enabled": False}
    try:
        view = await _request(client, config, user_id, "GET", f"interactions/{quote(task_id, safe='')}")
        if "_httpStatus" in view:
            return {"enabled": False}
        # Renew only an already active claim, never allocate from observation.
        lease = view.get("lease") or {}
        if lease.get("status") == "ACTIVE":
            renewal = await _request(
                client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
            )
            if renewal.get("_httpStatus") == 403:
                return {"enabled": False}
        return {"enabled": True, "interaction": view}
    except Exception:
        return {"enabled": False}


def _busy_phone_error(acquired: dict) -> str:
    """Tell the agent which agent currently holds the phone, using the backend's own queue view."""
    holder = acquired.get("holder") if isinstance(acquired.get("holder"), dict) else {}
    position = acquired.get("queuePosition")
    agent = holder.get("agentId") if isinstance(holder.get("agentId"), str) else None
    parts = ["Phone is in use"]
    if agent:
        parts.append(f" by agent {agent}")
        if holder.get("controlOwner") == "user":
            parts.append(" (the user has control)")
    if isinstance(position, int) and not isinstance(position, bool) and position > 0:
        parts.append(f"; this task is waiting at queue position {position}")
    return "".join(parts)


async def execute_phone(
    params: dict,
    *,
    config,
    user_id: str,
    agent_id: str,
    task_id: str,
    decision_id: str,
    snapshot: dict | None,
    client=None,
) -> dict:
    """Use the decision's cursor, not a newly fetched cursor, for the CAS fence."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await execute_phone(
                params,
                config=config,
                user_id=user_id,
                agent_id=agent_id,
                task_id=task_id,
                decision_id=decision_id,
                snapshot=snapshot,
                client=owned,
            )
    if not all((user_id, agent_id, task_id)) or not (snapshot or {}).get("enabled"):
        return {"success": False, "error": "Phone unavailable for this decision"}
    from browser_tools.schemas import validate_browser_tool_args

    try:
        params = validate_browser_tool_args("phone", params)
    except ValueError:
        return {"success": False, "error": "Invalid phone arguments"}
    if params["mode"] == "operation" and params.get("operation") in {"credentials.fill_saved", "credentials.fill_device_passcode"} and params.get("args", {}) != {}:
        return {"success": False, "error": "Saved credential fill accepts no model arguments"}
    if params["mode"] == "operation" and params.get("operation") in {"messages.send_approved", "messages.verify_sent"}:
        command_args = params.get("args", {})
        if set(command_args) != {"queueId"} or not isinstance(command_args["queueId"], str) or not command_args["queueId"].strip():
            return {"success": False, "error": "Approved message operation requires only its queueId"}
    if not (await fetch_phone_availability(config, user_id, task_id, client=client))["enabled"]:
        return {"success": False, "error": "Phone capability unavailable or revoked"}
    view = (snapshot or {}).get("interaction") or {}
    path = f"interactions/{quote(task_id, safe='')}"
    if params["mode"] == "setup":
        return await _execute_setup(params, config=config, user_id=user_id, task_id=task_id,
                                    decision_id=decision_id, snapshot=snapshot, client=client)
    operation_id = None
    lease_id = None
    try:
        if params["mode"] == "status":
            current = await _request(client, config, user_id, "GET", path)
            return {"success": "_httpStatus" not in current, "phone": current}
        if params["mode"] == "release":
            lease = view.get("lease") or {}
            if not lease.get("id"):
                return {"success": True, "phone": view}
            result = await _request(
                client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/release", {}
            )
            return {"success": "_httpStatus" not in result, "phone": result}
        cursor = view.get("cursor", 0)
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            return {"success": False, "error": "Phone observation cursor invalid"}
        # Public identities contain only trusted routing/decision identity, never
        # command args (low-entropy secrets must not be dictionary-guessable).
        # The fallback is deterministic for the observed cursor, never
        # an activity attempt or a new random UUID on HTTP retry.
        intent = decision_id or _identity("cursor", task_id, cursor)
        acquired = await _request(
            client,
            config,
            user_id,
            "POST",
            path,
            {"requestKey": _identity("acquire", task_id, (view.get("lease") or {}).get("id"), intent)},
        )
        lease = acquired.get("lease") or {}
        lease_id = lease.get("id")
        if lease.get("status") != "ACTIVE" or not lease_id:
            return {"success": False, "phone": acquired, "error": _busy_phone_error(acquired)}
        # A newly allocated lease starts at its own cursor. Reuse must keep the
        # decision's observed cursor to reject a concurrently superseded action.
        observed_lease = view.get("lease") or {}
        if observed_lease.get("id") != lease_id:
            if observed_lease.get("status") in ("ACTIVE", "WAITING"):
                return {"success": False, "error": "Phone lease changed; observe again"}
            cursor = 0
        operation_id = _identity("operation", task_id, lease_id, intent)
        result = await with_phone_heartbeat(
            _request(
                client,
                config,
                user_id,
                "POST",
                f"leases/{quote(lease_id, safe='')}/operations",
                {
                    "operationId": operation_id,
                    "operation": params["operation"],
                    "args": params.get("args", {}),
                    "expectedCursor": cursor,
                    # Only the context seen by this decision can acknowledge
                    # setup. Never adopt setup from the acquire response.
                    **_seen_setup_context(view, task_id),
                },
            ),
            config,
            user_id,
            {"enabled": True, "interaction": {"lease": lease}},
            client=client,
        )
        if result.get("_httpStatus", 0) >= 500:
            raise RuntimeError("Unconfirmed phone submission")
        return {
            "success": "_httpStatus" not in result and (result.get("operation") or {}).get("status") == "SUCCEEDED",
            **result,
        }
    except Exception:
        # Submission can have executed. Observe the SAME receipt, never replay.
        if lease_id and operation_id:
            try:
                receipt = await _request(
                    client,
                    config,
                    user_id,
                    "GET",
                    f"leases/{quote(lease_id, safe='')}/operations/{quote(operation_id, safe='')}",
                )
                if "_httpStatus" not in receipt:
                    return {"success": (receipt.get("operation") or {}).get("status") == "SUCCEEDED", **receipt}
            except Exception:
                pass
        return {"success": False, "status": "UNKNOWN", "error": "Phone outcome unconfirmed; observe before acting"}


def _seen_setup_context(view: dict, task_id: str) -> dict:
    lease = view.get("lease") or {}
    setup = view.get("setup") or {}
    revision = setup.get("revision")
    attempt = setup.get("attemptId")
    if (lease.get("status") != "ACTIVE" or lease.get("browserTaskId") != task_id
        or not isinstance(attempt, str) or not attempt
        or not isinstance(revision, int) or isinstance(revision, bool) or revision < 0):
        return {}
    return {"setupAttemptId": attempt, "setupRevision": revision}


async def _execute_setup(params, *, config, user_id, task_id, decision_id, snapshot, client):
    """Submit one observed setup intent; recover status without replay or rebilling."""
    view = snapshot.get("interaction") or {}
    context = _seen_setup_context(view, task_id)
    lease = view.get("lease") or {}
    cursor = view.get("cursor")
    pending = view.get("pendingOperation") or {}
    failure = {"success": False, "error": "Phone setup unavailable for this decision"}
    if (not context or not isinstance(lease.get("id"), str)
        or not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0
        or lease.get("attentionRequestId")
        or pending.get("status") in {"CONNECTING", "RUNNING", "UNKNOWN"}):
        return failure
    intent = decision_id or _identity("setup-cursor", task_id, cursor)
    key = _identity("setup", task_id, lease["id"], context["setupAttemptId"], intent)
    path = f"interactions/{quote(task_id, safe='')}"
    payload = {"action": params["action"], "attemptId": context["setupAttemptId"],
               "expectedRevision": context["setupRevision"], "expectedCursor": cursor, "requestKey": key}
    for field in ("reasonCode", "evidenceOperationIds", "verificationTarget"):
        if field in params:
            payload[field] = params[field]

    def present(data):
        # Backend records verifier ToolUsage exactly once. Preserve its receipt
        # as evidence; never turn it into Python usage_items or token totals.
        operation = data.get("operation") or {}
        return {**data, "success": operation.get("id") == key and operation.get("status") == "SUCCEEDED"}

    try:
        result = await with_phone_heartbeat(
            _request(client, config, user_id, "POST", path + "/setup", payload),
            config, user_id, snapshot, client=client,
        )
        if result.get("_httpStatus", 0) < 500:
            return present(result)
    except Exception:
        # A paid verification may already have committed. Do not POST again.
        pass
    try:
        current = await _request(client, config, user_id, "GET", path)
        receipt = await _request(client, config, user_id, "GET",
                                 f"leases/{quote(lease['id'], safe='')}/operations/{quote(key, safe='')}")
        if "_httpStatus" not in receipt and (receipt.get("operation") or {}).get("id") == key:
            if "setup" not in receipt and "_httpStatus" not in current:
                receipt = {**receipt, "setup": current.get("setup")}
            return present(receipt)
        last = (current.get("setup") or {}).get("lastRequest") or {}
        if last.get("requestKey") == key and last.get("operationId") == key and last.get("action") == params["action"]:
            return {"success": False, "setup": current["setup"],
                    "operation": {"id": key, "status": last.get("status"), "errorCode": last.get("errorCode")}}
    except Exception:
        pass
    return {**failure, "status": "UNKNOWN", "error": "Phone setup outcome unconfirmed; observe before acting"}


async def retain_phone_for_auth(config, user_id: str, task_id: str, request_id: str, *, snapshot: dict | None = None) -> None:
    """Retain only an observed claim; never discover a phone for browser auth."""
    lease = ((snapshot or {}).get("interaction") or {}).get("lease") or {}
    if ((snapshot or {}).get("enabled") is not True or lease.get("status") != "ACTIVE"
        or lease.get("browserTaskId") != task_id or not isinstance(lease.get("id"), str)):
        return
    async with httpx.AsyncClient() as client:
        try:
            # Server rechecks feature access, exact ownership and pending auth.
            await _request(client, config, user_id, "POST",
                           f"leases/{quote(lease['id'], safe='')}/awaiting-auth",
                           {"attentionRequestId": request_id})
        except Exception:
            pass


async def with_phone_heartbeat(work, config, user_id: str, snapshot: dict, *, client=None):
    """Bounded keepalive owned/cancelled by the existing model/action lifecycle.

    No autonomous queue polling, allocation, or global ownership map. Pending
    authentication reservations survive activity shutdown in the backend.
    """
    lease = (snapshot.get("interaction") or {}).get("lease") or {}
    if not snapshot.get("enabled") or lease.get("status") != "ACTIVE":
        return await work

    async def renew():
        for _ in range(8):  # bounded to four minutes; caller has its own deadline
            await asyncio.sleep(30)
            try:
                if client is None:
                    async with httpx.AsyncClient() as owned:
                        result = await _request(
                            owned, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
                        )
                else:
                    result = await _request(
                        client, config, user_id, "POST", f"leases/{quote(lease['id'], safe='')}/heartbeat", {}
                    )
                if "_httpStatus" in result:
                    return
            except Exception:
                return

    keepalive = asyncio.create_task(renew())
    try:
        return await work
    finally:
        keepalive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keepalive


def _native_auth_receipt(data, *, user_id, agent_id, task_id, lease_id, reason, request_id=None):
    """Return only exact public handoff fields; never echo arbitrary provider data."""
    request = data.get("request") if isinstance(data, dict) else None
    handoff = data.get("handoff") if isinstance(data, dict) else None
    if not isinstance(request, dict) or not isinstance(handoff, dict):
        return None
    target = {"kind": "iphone", "browserTaskId": task_id, "leaseId": lease_id}
    identity = request.get("id")
    if (
        not isinstance(identity, str) or not identity
        or (request_id is not None and identity != request_id)
        or request.get("userId") != user_id or request.get("agentId") != agent_id
        or request.get("target") != target or handoff.get("target") != target
        or request.get("criticalReason") != reason or handoff.get("criticalReason") != reason
        or handoff.get("type") != "manual_step" or handoff.get("liveViewUrl") is not None
        or handoff.get("steelSessionId") is not None
    ):
        return None
    return {
        "request": {"id": identity, "agentId": agent_id, "userId": user_id,
                    "target": target, "criticalReason": reason},
        "handoff": {"type": "manual_step", "liveViewUrl": None, "steelSessionId": None,
                    "target": target, "criticalReason": reason},
    }


async def request_native_phone_authentication(
    *, config, user_id: str, agent_id: str, task_id: str, decision_id: str,
    snapshot: dict | None, critical_reason: str, client=None,
) -> dict:
    """One stable create intent; observe its owned receipt after an uncertain POST."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await request_native_phone_authentication(
                config=config, user_id=user_id, agent_id=agent_id, task_id=task_id,
                decision_id=decision_id, snapshot=snapshot, critical_reason=critical_reason,
                client=owned,
            )
    failure = {"success": False, "error": "Native authentication assistance unavailable"}
    view = (snapshot or {}).get("interaction") or {}
    lease = view.get("lease") or {}
    cursor = view.get("cursor")
    if (
        not all((user_id, agent_id, task_id)) or not (snapshot or {}).get("enabled")
        or lease.get("status") != "ACTIVE" or not isinstance(lease.get("id"), str)
        or lease.get("browserTaskId") != task_id
        or not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0
        or critical_reason not in {"password", "verification_code", "device_passcode", "manual_verification"}
    ):
        return failure
    if not (await fetch_phone_availability(config, user_id, task_id, client=client))["enabled"]:
        return failure
    intent = decision_id or _identity("auth-cursor", task_id, lease["id"], cursor)
    key = _identity("auth-assistance", task_id, lease["id"], intent)
    from .repo import create_phone_auth_assistance_request

    def validate(data, request_id=None):
        return _native_auth_receipt(
            data, user_id=user_id, agent_id=agent_id, task_id=task_id,
            lease_id=lease["id"], reason=critical_reason, request_id=request_id,
        )

    async def read_receipt(request_id):
        response = await client.get(
            f"{config.backend.api_url.rstrip('/')}/api/auth-assistance/{quote(request_id, safe='')}",
            headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id}, timeout=10.0,
        )
        receipt = validate(response.json(), request_id) if response.is_success else None
        return {"success": True, "request_info": receipt} if receipt else failure

    # An activity can restart after creation but before its pause result commits.
    # Reattach to the observed exact request rather than issuing another intent.
    pending_id = lease.get("attentionRequestId")
    if isinstance(pending_id, str) and pending_id:
        try:
            return await read_receipt(pending_id)
        except Exception:
            return failure
    try:
        response = await create_phone_auth_assistance_request(
            config, user_id=user_id, agent_id=agent_id, task_id=task_id,
            critical_reason=critical_reason, request_key=key, expected_cursor=cursor,
            client=client,
        )
        if response.status_code < 500:
            if not response.is_success:
                return {**failure, "httpStatus": response.status_code}
            receipt = validate(response.json())
            return {"success": True, "request_info": receipt} if receipt else failure
    except Exception:
        # Creation may have committed. No response text, exception or new POST.
        pass
    try:
        current = await _request(client, config, user_id, "GET", f"interactions/{quote(task_id, safe='')}")
        owned = current.get("lease") or {}
        request_id = owned.get("attentionRequestId")
        if owned.get("id") != lease["id"] or not isinstance(request_id, str) or not request_id:
            return failure
        return await read_receipt(request_id)
    except Exception:
        return failure


async def bind_approved_message(config, user_id: str, task_id: str, queue_id: str, *, client=None) -> None:
    """Attach an existing approved queue intent after its owned browser task exists."""
    if client is None:
        async with httpx.AsyncClient() as owned:
            return await bind_approved_message(config, user_id, task_id, queue_id, client=owned)
    try:
        response = await client.post(
            f"{config.backend.api_url.rstrip('/')}/api/imessage/queue/{quote(queue_id, safe='')}/phone-bind",
            headers={"X-API-Key": config.backend.api_key or "", "X-User-Id": user_id},
            json={"user_id": user_id, "browser_task_id": task_id},
            timeout=10.0,
        )
        value = response.json() if response.is_success else None
        if (not isinstance(value, dict) or value.get("success") is not True
                or value.get("provider") != "phone_harness" or value.get("queue_id") != queue_id
                or value.get("browser_task_id") != task_id):
            raise ValueError("Invalid binding receipt")
    except Exception:
        # No response body, opaque routing URL, credential or transport error escapes.
        raise RuntimeError("Approved cloud message binding unavailable") from None
