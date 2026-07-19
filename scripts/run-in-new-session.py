#!/usr/bin/env python3
"""Exec a command as the leader of a new POSIX session.

macOS does not ship the GNU ``setsid(1)`` executable.  Python exposes the
same kernel primitive on every POSIX platform supported by this repository,
so process-group-owning launchers use this tiny adapter instead of depending
on a platform-specific command-line utility.
"""

from __future__ import annotations

import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: run-in-new-session.py COMMAND [ARG ...]")

    os.setsid()
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
