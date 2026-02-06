"""Soft penalties for ME/CE/Complexity check failures."""

LAMBDA = {'ME': 0.3, 'CE': 0.2, 'CX': 0.1}


def soft_penalties(me: bool, ce: bool, cx: bool) -> float:
    return (
        LAMBDA['ME'] * (not me)
        + LAMBDA['CE'] * (not ce)
        + LAMBDA['CX'] * (not cx)
    )
