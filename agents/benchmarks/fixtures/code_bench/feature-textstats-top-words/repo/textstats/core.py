"""Small text statistics helpers."""

import re

_WORD_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def tokenize(text):
    """Return the lowercase words in ``text``.

    A word is a run of ASCII letters, optionally with one inner apostrophe
    ("don't"). Everything else separates words.
    """
    return _WORD_RE.findall(text.lower())


def word_count(text):
    """Return the number of words in ``text``."""
    return len(tokenize(text))
