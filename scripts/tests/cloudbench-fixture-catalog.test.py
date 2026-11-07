#!/usr/bin/env python3
"""The native fleet fixture supplies the timeout metadata its real CLI requires."""
import json
from pathlib import Path

source = Path(__file__).with_name('cloudbench-multi-workstream.test.sh').read_text()
marker = "<<'TASKCATALOG'\n"
start = source.index(marker) + len(marker)
end = source.index('\nTASKCATALOG', start)
rows = json.loads(source[start:end])
assert rows
for row in rows:
    timeout = row.get('timeout_seconds')
    expected = 9000 if row['name'] == 'bench-default-detach' else 240
    assert type(timeout) is int and timeout == expected, (
        f"{row['name']} must declare its existing {expected}s fixture deadline; got {timeout!r}"
    )
print('PASS: every synthetic fleet task declares its existing deadline; explicit operator caps stay authoritative')
