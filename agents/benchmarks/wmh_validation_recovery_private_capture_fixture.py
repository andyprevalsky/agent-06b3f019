"""Exercise the existing native private redactor/atomic writer, without a model."""

import json
import os
import sys
from pathlib import Path

from benchmarks.build_experiential_world_model import atomic_json, redact_archive

os.umask(0o077)
payload = json.load(sys.stdin)
safe, redactions = redact_archive(payload)
safe["redaction_count"] = redactions
atomic_json(Path(sys.argv[1]), safe)
