"""Small text statistics helpers."""

import re
from collections import Counter

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


def top_words(text, n=3, stopwords=None):
    """Return the ``n`` most frequent words as ``(word, count)`` tuples."""
    if n <= 0:
        raise ValueError("n must be positive")
    excluded = {word.lower() for word in (stopwords or ())}
    counts = Counter(word for word in tokenize(text) if word not in excluded)
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:n]
