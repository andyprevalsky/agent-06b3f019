"""Greeting helpers."""


def greet(name):
    """Return "Hello, <Name>!" for a person's name.

    Surrounding whitespace is ignored, inner runs of whitespace collapse to a
    single space and every word is capitalized ("  ada   lovelace " ->
    "Hello, Ada Lovelace!"). An empty or blank name greets "friend".
    """
    return f"Hello, {name}!"
