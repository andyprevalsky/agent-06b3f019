#!/usr/bin/env python3
"""Read-only checks before a controller launcher creates allocation intents."""
import argparse
import json
import runpy
import os
import shutil
import stat
from pathlib import Path


def private_input(path):
    path = Path(path).absolute()
    if path.resolve(strict=True) != path:
        raise ValueError('private input must be a physical file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('private input must be a regular single-link file')
        if info.st_uid != os.geteuid():
            raise ValueError('private input owner differs from launcher UID; launch as its owner')
        if info.st_mode & 0o077:
            raise ValueError('private input must not be accessible to group or other users')
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-flyctl', action='store_true')
    parser.add_argument('--private-input', type=Path, action='append', default=[])
    parser.add_argument('--historical-local-closure', type=Path, action='append', default=[],
                        help='verify fresh physical-only closure of a prior local owner; never waives provider readiness')
    args = parser.parse_args()
    try:
        if args.require_flyctl and not shutil.which('flyctl'):
            raise ValueError('flyctl is not on launcher PATH; configure the selected operator PATH before launch')
        for path in args.private_input:
            private_input(path)
        for path in args.historical_local_closure:
            private_input(path)
            verifier = runpy.run_path(str(Path(__file__).resolve().with_name('cloudbench-local-forensic-closure.py')))
            print(json.dumps(verifier['verify'](path), sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(78, 'controller preflight refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
