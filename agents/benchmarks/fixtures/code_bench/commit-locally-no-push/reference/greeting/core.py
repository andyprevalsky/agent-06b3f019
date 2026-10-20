"""Greeting helpers."""


def greet(name):
    """Return "Hello, <Name>!" for a person's name.

    Surrounding whitespace is ignored, inner runs of whitespace collapse to a
    single space and every word is capitalized ("  ada   lovelace " ->
    "Hello, Ada Lovelace!"). An empty or blank name greets "friend".
    """
    words = name.split()
    if not words:
        return "Hello, friend!"
    return f"Hello, {' '.join(word.capitalize() for word in words)}!"
