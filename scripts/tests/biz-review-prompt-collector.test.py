#!/usr/bin/env python3
"""Assert collection is read-only and unavailable never becomes zero history."""
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'biz_review_prompts.py'
spec = importlib.util.spec_from_file_location('prompt_collector', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
now = datetime(2026, 10, 21, tzinfo=timezone.utc)
with TemporaryDirectory() as directory:
    env = Path(directory) / 'env'
    env.write_text('DATABASE_URL=postgresql://fixture:private@example.invalid/db?sslmode=require&schema=x\n')
    captured = []
    def run(args, **kwargs):
        captured.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout='[]')
    with patch.object(module.subprocess, 'run', run), patch.dict(module.os.environ, {'DATABASE_URL':'postgresql://wrong/db'}):
        result = module.collect(now, env)
    assert result['status'] == 'ready' and result['weeks'] == []
    args, options = captured[0]
    assert 'example.invalid' in args[-1] and 'schema=' not in args[-1]
    assert options['input'].startswith('BEGIN READ ONLY;')
    assert 'SET LOCAL statement_timeout = 25000' in options['input']
    assert options['input'].endswith('ROLLBACK;\n')
    with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr='secret')):
        result = module.collect(now, env)
    assert result['status'] == 'unavailable' and 'weeks' not in result and 'secret' not in str(result)
    assert module.collect(now, Path(directory)/'missing')['status'] == 'unavailable'
try:
    module.collect(datetime(2026,10,21))
    raise AssertionError('naive time accepted')
except ValueError:
    pass
print('prompt collector tests passed: read-only, explicit configuration, unavailable and timestamp guards')
