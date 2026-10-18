"""Hold only writer scheduling while exercising the actual private capture writer."""

import json
import os
import sys
import time
from pathlib import Path

from benchmarks.wmh_provider_capture import write_capture

root = Path(sys.argv[1])
packet = json.load(sys.stdin)
block = root / "block-capture-session"
if block.exists() and block.read_text() == packet["owner"]["session_id"]:
    (root / "blocked-writer-pid").write_text(str(os.getpid()))
    (root / "blocked-writer-started").write_text(packet["owner"]["prediction_id"])
    limit = time.monotonic() + 10
    while not (root / "release-capture").exists():
        if time.monotonic() >= limit:
            raise RuntimeError("Offline writer barrier timed out")
        time.sleep(0.01)
print(json.dumps(write_capture(root, packet)))
