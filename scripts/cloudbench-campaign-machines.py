#!/usr/bin/env python3
"""One bounded, full Machines read for the campaign-owned inventory publisher."""
from __future__ import annotations
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request

MAX_BYTES = 256 * 1024 * 1024
class Refusal(Exception):
    pass

def authorization(token: str, deadline: float) -> str:
    """Use the existing exact selected-session refresh; never print credentials."""
    def split(value):
        while re.match(r'^(Bearer|FlyV1)\s+', value, re.I):
            value = re.sub(r'^(Bearer|FlyV1)\s+', '', value, count=1, flags=re.I)
        values = [x.strip() for x in value.split(',') if x.strip()]
        if not values or any('\r' in x or '\n' in x for x in values):
            raise Refusal('empty or malformed credential')
        return values
    tokens = split(token.strip())
    if any(x.startswith(('fm1r_', 'fm1a_', 'fm2_')) for x in tokens):
        binary = shutil.which('flyctl')
        if not binary:
            raise Refusal('selected Fly client missing')
        env = dict(os.environ)
        env.pop('FLY_ACCESS_TOKEN', None)
        process = subprocess.Popen([binary, 'auth', 'token', '--json', '--quiet'], env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            output, _ = process.communicate(timeout=max(0.001, deadline-time.monotonic()))
            value = json.loads(output).get('token') if process.returncode == 0 else None
            if not isinstance(value, str) or not value.strip():
                raise Refusal('selected session refresh refused')
            tokens = split(value.strip())
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    macaroons = [x for x in tokens if x.startswith(('fm1r_', 'fm1a_', 'fm2_'))]
    return ('FlyV1 ' + ','.join(macaroons)) if macaroons else ('Bearer ' + ','.join(tokens))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refusal('redirect refused')

def validate(value: object) -> list[dict]:
    if not isinstance(value, list):
        raise Refusal('full inventory must be an array')
    seen = set()
    for machine in value:
        if not isinstance(machine, dict):
            raise Refusal('Machine must be an object')
        ident = machine.get('id')
        if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', ident) or ident in seen:
            raise Refusal('invalid or duplicate Machine identity')
        seen.add(ident)
        for key in ('name', 'state', 'region', 'private_ip', 'instance_id'):
            if key in machine and machine[key] is not None and not isinstance(machine[key], str):
                raise Refusal('invalid Machine scalar')
        config = machine.get('config')
        if config is not None and not isinstance(config, dict):
            raise Refusal('invalid Machine config')
        if isinstance(config, dict):
            for key in ('guest', 'init', 'metadata', 'env'):
                if config.get(key) is not None and not isinstance(config[key], dict):
                    raise Refusal('invalid Machine config object')
            guest = config.get('guest') or {}
            for key in ('cpus', 'memory_mb'):
                if guest.get(key) is not None and type(guest[key]) is not int:
                    raise Refusal('invalid guest integer')
            if guest.get('cpu_kind') is not None and not isinstance(guest['cpu_kind'], str):
                raise Refusal('invalid guest CPU kind')
            for key in ('metadata', 'env'):
                if any(not isinstance(v, str) for v in (config.get(key) or {}).values()):
                    raise Refusal('invalid config string map')
            for key in ('cmd', 'exec', 'entrypoint'):
                v = (config.get('init') or {}).get(key)
                if v is not None and (not isinstance(v, list) or any(not isinstance(x, str) for x in v)):
                    raise Refusal('invalid guest startup vector')
            mounts = config.get('mounts')
            if mounts is not None and (not isinstance(mounts, list) or any(not isinstance(x, dict) for x in mounts)):
                raise Refusal('invalid Machine mounts')
            for mount in mounts or []:
                for key in ('volume', 'path'):
                    if mount.get(key) is not None and not isinstance(mount[key], str):
                        raise Refusal('invalid mount scalar')
                if mount.get('size_gb') is not None and type(mount['size_gb']) is not int:
                    raise Refusal('invalid mount size')
        checks = machine.get('checks')
        if checks is not None:
            if not isinstance(checks, list) or any(not isinstance(x, dict) or not isinstance(x.get('name', ''), str) for x in checks):
                raise Refusal('invalid Machine checks')
            machine['checks'] = [x for x in checks if not x.get('name', '').startswith('bg_deployments_compat')]
    return value

def fetch(app: str, seconds: float) -> bytes:
    deadline = time.monotonic() + seconds
    def expired(signum, frame):
        raise Refusal('absolute Machines read deadline')
    previous = {s: signal.signal(s, expired) for s in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)}
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        base = os.environ.get('FLY_FLAPS_BASE_URL', 'https://api.machines.dev').rstrip('/')
        parsed = urllib.parse.urlsplit(base)
        loopback = parsed.hostname in ('127.0.0.1', 'localhost', '::1')
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise Refusal('invalid selected Machines endpoint')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
            raise Refusal('Machines endpoint must use HTTPS')
        header = authorization(os.environ.get('FLY_API_TOKEN', ''), deadline)
        headers = {'Authorization': header, 'Accept': 'application/json'}
        if os.environ.get('FLY_FORCE_INSTANCE_ID'):
            raise Refusal('unsupported forced instance override')
        url = base + '/v1/apps/' + urllib.parse.quote(app, safe='') + '/machines'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(urllib.request.Request(url, headers=headers), timeout=max(0.001, deadline-time.monotonic())) as response:
            if response.status != 200:
                raise Refusal('Machines HTTP status refused')
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
                raise Refusal('Machines response size refused')
            raw = response.read(MAX_BYTES+1)
            if len(raw) > MAX_BYTES or (length is not None and len(raw) != int(length)):
                raise Refusal('incomplete or oversized Machines response')
        value = validate(json.loads(raw))
        result = json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        if time.monotonic() >= deadline:
            raise Refusal('Machines decode exceeded original deadline')
        return result
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for s, handler in previous.items():
            signal.signal(s, handler)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or not float(sys.argv[2]) > 0:
            raise Refusal('invalid bounded Machines arguments')
        sys.stdout.buffer.write(fetch(sys.argv[1], float(sys.argv[2])))
    except Exception as error:
        print('campaign Machines read refused: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
