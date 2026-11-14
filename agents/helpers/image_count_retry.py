"""One request-local image-count retry; original conversation stays intact."""
from __future__ import annotations

import copy
import re
import time
from typing import Any

from providers.rose.errors import RoseAllFailed, RoseInvalidRequest

DEFAULT_RETRY_IMAGES = 10
IMAGE_TYPES = frozenset({"image", "image_url", "input_image"})


def image_count_limit(error: BaseException) -> int | None:
    """Recognize only typed invalid-request image-count errors, never other 400s."""
    if isinstance(error, RoseAllFailed):
        limits = [image_count_limit(step.error) for step in error.step_errors]
        return min(limits) if limits and all(limit is not None for limit in limits) else None
    if not isinstance(error, RoseInvalidRequest):
        return None
    text = str(error).lower()
    count_error = re.search(r"too many (?:input )?images|(?:number|count) of images.{0,80}(?:exceed|limit)|(?:maximum|max|at most|up to).{0,25}\d+.{0,12}images|images.{0,40}(?:maximum|limit).{0,20}\d+|maximum number of images", text)
    if not count_error:
        return None
    limits = []
    for pattern in (r"(?:maximum|max|at most|up to|limit(?: of| is|:)?)\D{0,15}(\d+)\s*(?:input )?images",
                    r"images.{0,35}(?:maximum|max|limit)\D{0,15}(\d+)",
                    r"(?:maximum|max) (?:number|count) of images\D{0,15}(\d+)",
                    r"too many images[^\n]*>\s*(\d+)"):
        limits.extend(int(match) for match in re.findall(pattern, text))
    return min([DEFAULT_RETRY_IMAGES, *limits])


def last_images(messages: list[dict], count: int) -> list[dict]:
    """Copy the request and omit older images only; keep tool/text association."""
    copied = copy.deepcopy(messages)
    locations = [(message, index) for message in copied
                 if isinstance(message.get("content"), list)
                 for index, block in enumerate(message["content"])
                 if isinstance(block, dict) and block.get("type") in IMAGE_TYPES]
    for message, index in locations[:max(0, len(locations) - count)]:
        message["content"][index] = {"type": "text", "text": "[Earlier screenshot omitted for provider image-count limit; original history retained.]"}
    return copied


async def stream_with_image_count_retry(stream_factory, *, messages, **kwargs):
    """Retry once, before productive output, only after a provider count rejection."""
    started = time.monotonic()
    request = messages
    for attempt in range(2):
        productive = False
        stream = stream_factory(messages=request, **kwargs).__aiter__()
        try:
            async for chunk in stream:
                if getattr(chunk, "kind", None) in {"content", "reasoning", "tool_call"}:
                    productive = True
                yield chunk
            return
        except (RoseInvalidRequest, RoseAllFailed) as error:
            limit = image_count_limit(error)
            if attempt or productive or limit is None:
                raise
            reduced = last_images(messages, limit)
            if reduced == messages:
                raise
            if kwargs.get("deadline_s") is not None:
                remaining = kwargs["deadline_s"] - (time.monotonic() - started)
                if remaining <= 0:
                    raise
                kwargs = {**kwargs, "deadline_s": remaining}
            request = reduced
        finally:
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()


async def collect_with_image_count_retry(collect, *, messages, **kwargs):
    """Non-streaming equivalent, with the same single-retry and history rules."""
    started = time.monotonic()
    try:
        return await collect(messages=messages, **kwargs)
    except (RoseInvalidRequest, RoseAllFailed) as error:
        limit = image_count_limit(error)
        if limit is None:
            raise
        reduced = last_images(messages, limit)
        if reduced == messages:
            raise
        if kwargs.get("deadline_s") is not None:
            remaining = kwargs["deadline_s"] - (time.monotonic() - started)
            if remaining <= 0:
                raise
            kwargs = {**kwargs, "deadline_s": remaining}
        return await collect(messages=reduced, **kwargs)
