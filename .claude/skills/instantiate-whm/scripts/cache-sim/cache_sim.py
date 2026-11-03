"""Simulate GPT-5.6+ prompt caching (Azure Foundry / OpenAI Responses) over real request sequences.

Rule (fits every probe measured 2026-10-12):
  writes  : end of the opening instructions block, end of the latest input item (implicit),
            and the latest 3 explicit breakpoints
  lookups : end of the opening block, explicit breakpoints (latest 50), the latest item end,
            and up to 20 earlier message endings
  a lookup hits only a prefix some earlier request wrote exactly; reads need >= 1024 tokens
"""

from __future__ import annotations

import hashlib
import json

import tiktoken

ENC = tiktoken.get_encoding("o200k_base")


def tokens(text: str) -> int:
    return len(ENC.encode(text, disallowed_special=()))


def item_text(item: dict) -> str:
    if isinstance(item.get("content"), list):
        return "".join(p.get("text", "") for p in item["content"] if isinstance(p, dict))
    return json.dumps(item, ensure_ascii=False, sort_keys=True)


class Cache:
    def __init__(self, read_price: float = 0.05):
        self.store: set[str] = set()
        self.read_price = read_price

    def request(self, instructions: str, items: list[dict], marks: set[int], explicit_mode: bool = False) -> dict:
        """marks: indices of input items whose end carries an explicit breakpoint.

        explicit_mode: only explicit breakpoints are read and written (no opening-block
        or latest-message points); no breakpoints means no caching at all.
        """
        digest = hashlib.sha256(instructions.encode()).hexdigest()
        prefixes, lengths = [digest], [tokens(instructions)]
        for item in items:
            digest = hashlib.sha256((digest + json.dumps(item, sort_keys=True, ensure_ascii=False)).encode()).hexdigest()
            prefixes.append(digest)
            lengths.append(lengths[-1] + tokens(item_text(item)) + 4)
        last = len(items)  # position after the latest item
        message_ends = [i + 1 for i, item in enumerate(items) if item.get("role") in ("user", "assistant")]
        explicit = sorted(i + 1 for i in marks)
        lookups = set(explicit[-50:]) if explicit_mode else {0, last, *explicit[-50:], *message_ends[-21:]}
        read_pos = max((p for p in lookups if prefixes[p] in self.store and lengths[p] >= 1024), default=None)
        read = lengths[read_pos] if read_pos is not None else 0
        writes = set(explicit[-4:]) if explicit_mode else {0, last, *explicit[-3:]}
        for p in writes:
            if lengths[p] >= 1024:
                self.store.add(prefixes[p])
        total = lengths[last]
        written = max(0, max((lengths[p] for p in writes), default=0) - read)
        plain = total - read - written
        return {"total": total, "read": read, "written": written, "plain": max(plain, 0)}
