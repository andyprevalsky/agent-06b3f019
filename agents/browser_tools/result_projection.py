"""Model-only browser result previews; canonical action receipts stay complete."""
import json
import re

from utils.browser_result_limits import BROWSER_STATE_MAX_CHARS, EVALUATE_RESULT_MAX_CHARS
from browser_tools.secret_refs import VALUE_SCOPED_RESULT_FIELDS, redact_current_secret_values
from helpers.tool_output import _safe_text, bound_tool_result, preview_tool_text


class BrowserModelResult(dict):
    pass


def project_result(original, action_name: str, redact, scoped_redact=None):
    """Project strictly, re-projecting only the action's observation fields value-scoped."""
    safe = redact(original)
    if callable(scoped_redact) and isinstance(original, dict) and isinstance(safe, dict):
        for key in VALUE_SCOPED_RESULT_FIELDS.get(action_name, ()):
            if key in original:
                safe[key] = scoped_redact(original[key])
    return safe


def browser_result_text_view(action_name: str, result: dict) -> dict:
    if action_name == "read_browser_state" and result.get("formatted_state"):
        return {
            "success": result.get("success", True),
            "message": result.get("message", ""),
            "formatted_state": result["formatted_state"],
            **({"auth_context": result["auth_context"]} if "auth_context" in result else {}),
        }
    clean = {key: value for key, value in result.items() if key not in {"screenshot", "screenshot_b64", "base64", "dom_tree"}}
    if action_name == "screenshot" and (result.get("screenshot") or result.get("screenshot_b64")):
        clean["screenshot_attached"] = True
    return clean


async def prepare_browser_result(action_name: str, result: dict, *, user_id: str, agent_id: str, session_id: str) -> dict:
    """Bound a browser result for the model; ``result`` must already be its model-visible projection."""
    if action_name == "read_tool_output":
        return result  # Readback is already bounded; never persist it again.
    view = browser_result_text_view(action_name, result)
    owner = dict(user_id=user_id, agent_id=agent_id, session_id=session_id)
    if action_name == "evaluate" and "value" in view:
        value = view["value"]
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        if len(text) > EVALUATE_RESULT_MAX_CHARS:
            view["value"] = await preview_tool_text(text, limit=EVALUATE_RESULT_MAX_CHARS, **owner)
    elif action_name == "read_browser_state" and isinstance(view.get("formatted_state"), str):
        view["formatted_state"] = await preview_tool_text(
            view["formatted_state"], limit=BROWSER_STATE_MAX_CHARS, value_scoped=True, **owner
        )
    field = "value" if action_name == "evaluate" else "formatted_state"
    issued_retained = False
    if isinstance(view.get(field), str):
        match = re.search(r'\n\[Retained tool output: read_tool_output output_id="([a-f0-9]{32})" offset=(\d+) limit=20000; total_chars=(\d+); Unicode characters; originating agent/session only; expires after 24h\.\]$', view[field])
        if match and view[field] != result.get(field):
            view["retained_output"] = {"output_id": match[1], "offset": int(match[2]), "total_chars": int(match[3]), "field": field}
            issued_retained = True
    scoped_fields = VALUE_SCOPED_RESULT_FIELDS.get(action_name, frozenset())
    if scoped_fields:
        # Raw fields are masked strictly before the observation-scoped bound pass.
        view = {key: value if key in scoped_fields else redact_current_secret_values(value) for key, value in view.items()}
    bounded = await bound_tool_result(view, value_scoped=bool(scoped_fields), **owner)
    # Generated readback IDs are protocol addresses, not page text. An activity
    # secret can coincidentally occur inside a random ID; keep only the ID we
    # just issued while redacting the page-derived preview prefix.
    # An oversized structured result has its own readback envelope. Preserve
    # the inner handle only when the bounded result still contains that field.
    view = preserve_output_protocol(view, bounded, action_name, _safe_text) if issued_retained and field in bounded else bounded
    # Keep typed operational receipts (payment/write-lock) and canonical raw
    # action data; only the model serializer selects this private attribute.
    if not hasattr(result, "__dict__"):
        result = BrowserModelResult(result)
    result.model_preview = view
    return result


def preserve_output_protocol(original: dict, visible: dict, action_name: str, redact, *, arguments: bool = False, scoped_redact=None) -> dict:
    """Keep native readback addressing intact across later secret projections.

    Only protocol positions are exempt. Page-derived text is always redacted;
    a retained observation field uses ``scoped_redact`` when one is given.
    """
    if not isinstance(original, dict) or not isinstance(visible, dict):
        return visible
    # The harness stamps a result's receipt and capture steps after page
    # masking; a short numeric credential equal to a step must not rewrite it.
    if not arguments and type(original.get("action_step")) is int:
        visible["action_step"] = original["action_step"]
    context, visible_context = original.get("screenshot_context"), visible.get("screenshot_context")
    if not arguments and isinstance(context, dict) and isinstance(visible_context, dict) and type(context.get("step")) is int:
        visible_context["step"] = context["step"]
    if action_name == "read_tool_output":
        output_id = original.get("output_id")
        if isinstance(output_id, str) and re.fullmatch(r"[a-f0-9]{32}", output_id):
            visible["output_id"] = output_id
            for key in (("offset", "limit") if arguments else ("offset", "next_offset", "total_chars")):
                value = original.get(key)
                if value is None or type(value) is int and value >= 0:
                    if key in original:
                        visible[key] = value
    metadata = original.get("retained_output") if not arguments else None
    if not isinstance(metadata, dict) or not re.fullmatch(r"[a-f0-9]{32}", str(metadata.get("output_id", ""))):
        return visible
    allowed = {"output_id", "offset", "total_chars", "field", "encoding", "expires_in_seconds"}
    if set(metadata) - allowed:
        return visible
    field = metadata.get("field", "preview")
    if field not in {"value", "formatted_state", "preview"}:
        return visible
    text = original.get(field)
    if not isinstance(text, str):
        return visible
    match = re.search(r'\n\[Retained tool output: read_tool_output output_id="' + re.escape(metadata["output_id"]) + r'" offset=\d+ limit=20000; total_chars=\d+; Unicode characters; originating agent/session only; expires after 24h\.\]$', text)
    if match:
        if callable(scoped_redact) and field in VALUE_SCOPED_RESULT_FIELDS.get(action_name, ()):
            redact = scoped_redact
        visible[field] = redact(text[:match.start()]) + match[0]
        visible["retained_output"] = dict(metadata)
    return visible


def retain_model_preview(source: dict, visible: dict, action_name: str, redact, scoped_redact=None) -> dict:
    """Keep the model-only view when a later native policy copies raw receipts."""
    preview = getattr(source, "model_preview", None)
    if preview is None:
        return visible
    preview = preserve_output_protocol(
        preview, project_result(preview, action_name, redact, scoped_redact), action_name, redact,
        scoped_redact=scoped_redact,
    )
    if not hasattr(visible, "__dict__"):
        visible = BrowserModelResult(visible)
    visible.model_preview = preview
    return visible
