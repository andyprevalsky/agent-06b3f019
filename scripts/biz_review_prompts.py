"""Read-only aggregate prompt history for /biz-review; never exports message text."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).resolve().parent.parent
SCOPE = ('Retained human-input rows in Andy’s real root conversations, including follow-ups. '
         'Excludes child goals, tools, A2A, workflow writes and empty attachments. Explicit '
         'request IDs count once; repeated text is retained. Deleted messages and unmarked '
         'legacy internal rows cannot be fully reconciled: this is not a lifetime total.')


def collect(end: datetime, env_file: Path | None = None) -> dict:
    if end.tzinfo is None:
        raise ValueError('Prompt history end must include a timezone')
    env_file = env_file or ROOT / 'back-end/.env'
    # Deliberately do not inherit the shell's DATABASE_URL: devbox shells often
    # point at a local fixture DB. Use the authoritative file explicitly.
    values = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$', line)
            if match:
                values[match[1]] = match[2].strip().strip('"').strip("'")
    source = values.get('DATABASE_URL')
    if not source:
        return {'status': 'unavailable', 'detail': 'Authoritative database configuration unavailable'}
    url = urlsplit(source)
    source = urlunsplit(url._replace(query=urlencode({k: v for k, v in parse_qsl(url.query)
                                                      if k in ('sslmode', 'connect_timeout')})))
    query = (ROOT / 'back-end/scripts/biz-review-prompt-history.sql').read_text().rstrip().rstrip(';')
    query = query.replace('$1', "'" + end.astimezone(timezone.utc).isoformat() + "'")
    query = query.replace('$2', "'1f85ff25-6e29-4c1b-8739-f917bd101a30'")
    sql = 'BEGIN READ ONLY;\nSET LOCAL statement_timeout = 25000;\n'
    sql += "SELECT COALESCE(json_agg(t), '[]'::json) FROM (" + query + ') t;\nROLLBACK;\n'
    try:
        result = subprocess.run(['psql', '-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-d', source],
                                input=sql, text=True, capture_output=True, timeout=40,
                                env={**os.environ, 'PGCONNECT_TIMEOUT': '10'})
        if result.returncode:
            return {'status': 'unavailable', 'detail': 'Read-only prompt-history query failed'}
        weeks = json.loads(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {'status': 'unavailable', 'detail': 'Read-only prompt-history collection unavailable'}
    return {'status': 'ready', 'timezone': 'America/Los_Angeles',
            'collectedThrough': end.isoformat(), 'weeks': weeks, 'scope': SCOPE}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--env-file', type=Path)
    args = parser.parse_args()
    result = collect(datetime.now(timezone.utc), args.env_file)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(args.out)
    raise SystemExit(0 if result['status'] == 'ready' else 1)
