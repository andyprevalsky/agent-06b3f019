"""Schema-owned operational projection, separate from page/raster projection."""
from __future__ import annotations
from typing import Any, Callable, get_args, get_origin
from types import UnionType
from typing import Union
from pydantic import BaseModel


def _project_declared(value: Any, annotation: Any, redact: Callable[[Any], Any]) -> Any:
    if annotation is Any:
        return redact(value)
    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        choices = [a for a in get_args(annotation) if a is not type(None)]
        if len(choices) == 1:
            return _project_declared(value, choices[0], redact)
    if isinstance(value, BaseModel):
        return {
            name: _project_declared(getattr(value, name), field.annotation, redact)
            for name, field in type(value).model_fields.items()
            if name in value.model_fields_set
        }
    if isinstance(value, list) and origin is list:
        subtype = get_args(annotation)[0] if get_args(annotation) else Any
        return [_project_declared(item, subtype, redact) for item in value]
    # Unknown dictionaries retain the observation policy, not schema authority.
    # Scalars use that same policy, preserving its numeric/encoded-secret rules
    # and withholding data:image strings after private credential entry.
    return redact(value)


class OperationalResult(dict):
    """Activity-local typed source; private attributes never enter dict serialization."""
    def __init__(self, value: dict, *, field: str, source: BaseModel):
        _require_operational_source(source, field=field)
        super().__init__(value)
        self.operational_field = field
        self.operational_source = source


def project_operational_source(source: BaseModel, redact: Callable[[Any], Any]) -> dict:
    """Project a validated producer source once; never parse a masked view."""
    _require_operational_source(source)
    projected = _project_declared(source, type(source), redact)
    projected.pop("tool", None)
    return projected


def retain_operational_source(source: Any, view: Any) -> Any:
    if isinstance(source, OperationalResult) and isinstance(view, dict):
        return OperationalResult(view, field=source.operational_field, source=source.operational_source)
    return view


def _require_operational_source(source: Any, *, field: str | None = None) -> None:
    from browser_tools.schemas import GenerateWriteLockNotificationTool, RequestPaymentCardBrowserTool
    schemas = {"payment_request": RequestPaymentCardBrowserTool,
               "write_lock_notification": GenerateWriteLockNotificationTool}
    if type(source) not in schemas.values() or (field is not None and schemas.get(field) is not type(source)):
        raise TypeError("operational source must match its producer schema")
