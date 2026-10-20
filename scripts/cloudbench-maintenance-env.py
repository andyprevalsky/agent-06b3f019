#!/usr/bin/env python3
"""Create one private Fly CLI state directory without changing HOME or auth."""
from pathlib import Path
import argparse
import os
import stat


def prepare_fly_config(stage: Path, uid: int, gid: int) -> Path:
    stage = Path(stage)
    parent = stage.lstat()
    if (not stage.is_absolute() or stage.resolve(strict=True) != stage
            or not stat.S_ISDIR(parent.st_mode)
            or stat.S_IMODE(parent.st_mode) != 0o700
            or parent.st_uid not in {os.getuid(), uid}):
        raise ValueError("unsafe private maintenance stage")
    path = stage / "fly-state"
    # Exclusive creation preserves any prior state's credentials and intent.
    path.mkdir(mode=0o700)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if opened.st_uid != os.getuid() or stat.S_IMODE(opened.st_mode) != 0o700:
            raise ValueError("unsafe new Fly state")
        if (opened.st_uid, opened.st_gid) != (uid, gid):
            os.fchown(fd, uid, gid)
        final = os.fstat(fd)
        actual = path.lstat()
        if ((final.st_uid, final.st_gid) != (uid, gid)
                or (actual.st_dev, actual.st_ino) != (final.st_dev, final.st_ino)):
            raise ValueError("Fly state changed during preparation")
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    args = parser.parse_args()
    print(prepare_fly_config(args.stage, args.uid, args.gid))
