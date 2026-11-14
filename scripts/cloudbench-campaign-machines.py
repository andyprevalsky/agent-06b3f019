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
import zlib

MAX_BYTES = 256 * 1024 * 1024
class Refusal(Exception):
    pass

# Best-effort, allowlisted private evidence. Never status or freshness authority.
_D_FD = None
_D_BYTES = 0
_D_PHASE = 'setup'
_D_SIGNAL = 'none'
_D_START = time.monotonic()
_D_CPU = time.process_time()
_D_LAST_T = _D_START
_D_LAST_CPU = _D_CPU
_D_COUNTS = {}
_D_ENCODING = 'unknown'
_D_LIMIT = 8192
_D_PHASES = {'setup','auth','headers','body_read','decompress','json_parse','validate','encode','fetch_return','stdout_write','complete'}
_D_REASONS = {'Machine must be an object': 'refusal_1', 'Machines HTTP status refused': 'refusal_2', 'Machines decode exceeded original deadline': 'refusal_3', 'Machines endpoint must use HTTPS': 'refusal_4', 'Machines response size refused': 'refusal_5', 'absolute Machines read deadline': 'refusal_6', 'empty or malformed credential': 'refusal_7', 'full inventory must be an array': 'refusal_8', 'incomplete or oversized Machines response': 'refusal_9', 'incomplete or oversized compressed Machines response': 'refusal_10', 'invalid Machine checks': 'refusal_11', 'invalid Machine config': 'refusal_12', 'invalid Machine config object': 'refusal_13', 'invalid Machine mounts': 'refusal_14', 'invalid Machine scalar': 'refusal_15', 'invalid bounded Machines arguments': 'refusal_16', 'invalid config string map': 'refusal_17', 'invalid guest CPU kind': 'refusal_18', 'invalid guest integer': 'refusal_19', 'invalid guest startup vector': 'refusal_20', 'invalid mount scalar': 'refusal_21', 'invalid mount size': 'refusal_22', 'invalid or duplicate Machine identity': 'refusal_23', 'invalid selected Machines endpoint': 'refusal_24', 'redirect refused': 'refusal_25', 'selected Fly client missing': 'refusal_26', 'selected session refresh refused': 'refusal_27', 'unsupported Machines content encoding': 'refusal_28', 'unsupported forced instance override': 'refusal_29'}
_D_COPY_SHA = ''
def _d_emit(event, **extra):
    global _D_BYTES, _D_LAST_T, _D_LAST_CPU
    if _D_FD is None:
        return
    try:
        t = time.monotonic()
        cpu = time.process_time()
        row = {'schema':'inventory-phase-v1','event':event,'phase':_D_PHASE,
               'elapsed_s':t-_D_START,'cpu_s':cpu-_D_CPU,
               'delta_s':t-_D_LAST_T,'delta_cpu_s':cpu-_D_LAST_CPU,
               'encoding':_D_ENCODING,'signal':_D_SIGNAL,
               'source_sha256':_D_COPY_SHA,
               **_D_COUNTS, **extra}
        raw = (json.dumps(row,separators=(',',':'),allow_nan=False)+'\n').encode()
        if _D_BYTES + len(raw) <= _D_LIMIT:
            written = os.write(_D_FD,raw)
            _D_BYTES += written
        _D_LAST_T = t
        _D_LAST_CPU = cpu
    except Refusal:
        raise
    except Exception:
        pass
def _d_init():
    global _D_FD, _D_COPY_SHA
    try:
        import stat, hashlib
        from pathlib import Path
        path = Path(os.environ.get('CLOUDBENCH_INVENTORY_PHASE_FILE',''))
        if not path.is_absolute():
            return
        parent = path.parent
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            return
        _D_COPY_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1 or st.st_mode & 0o077:
            os.close(fd)
            return
        _D_FD = fd
        _d_emit('start')
    except Refusal:
        raise
    except Exception:
        pass
def _d_phase(name, **counts):
    global _D_PHASE
    if name not in _D_PHASES:
        return
    previous = _D_PHASE
    _D_PHASE = name
    for key,value in counts.items():
        if key in {'wire_bytes','decoded_bytes','output_bytes'} and type(value) is int and value >= 0:
            _D_COUNTS[key] = value
    _d_emit('phase',previous_phase=previous)
def _d_encoding(value):
    global _D_ENCODING
    value = value.strip().lower()
    _D_ENCODING = 'gzip' if value=='gzip' else 'identity' if value in ('','identity') else 'other'
def _d_signal(number):
    global _D_SIGNAL
    _D_SIGNAL = {signal.SIGALRM:'alarm',signal.SIGTERM:'term',signal.SIGINT:'interrupt'}.get(number,'other')
    _d_emit('signal')
def _d_failure(error):
    reason = _D_REASONS.get(error.args[0], 'unknown') if isinstance(error,Refusal) and len(error.args)==1 and isinstance(error.args[0],str) else 'unknown'
    name = type(error).__name__
    kind = name if name in {'Refusal','HTTPError','URLError','TimeoutError','JSONDecodeError','UnicodeDecodeError','ValueError','OSError','BrokenPipeError'} else 'zlib_error' if isinstance(error,zlib.error) else 'other'
    _d_emit('failure',reason=reason,exception_class=kind)
def _d_close():
    if _D_FD is not None:
        try:
            os.close(_D_FD)
        except OSError:
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

def app_metadata(value: object, app: str) -> dict:
    """The native App contract; no Machine or release inventory is needed."""
    if not isinstance(value, dict) or value.get('name') != app:
        raise Refusal('app metadata identity invalid')
    organization = value.get('organization')
    network = value.get('network')
    if network is None:
        network = ''
    if (not isinstance(organization, dict) or not isinstance(organization.get('slug'), str)
            or not organization['slug'] or not isinstance(network, str)):
        raise Refusal('app metadata identity invalid')
    return {'Name': app, 'Organization': {'Slug': organization['slug']},
            'Network': '' if network == 'default' else network}


def fetch(app: str, seconds: float, machine_id: str | None = None, *, metadata: bool = False) -> bytes:
    deadline = time.monotonic() + seconds
    def expired(signum, frame):
        _d_signal(signum)
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
        _d_phase('auth')
        header = authorization(os.environ.get('FLY_API_TOKEN', ''), deadline)
        headers = {'Authorization': header, 'Accept': 'application/json', 'Accept-Encoding': 'gzip'}
        if os.environ.get('FLY_FORCE_INSTANCE_ID'):
            raise Refusal('unsupported forced instance override')
        url = base + '/v1/apps/' + urllib.parse.quote(app, safe='')
        if not metadata:
            url += '/machines'
        if machine_id is not None:
            if not re.fullmatch('[0-9a-f]+', machine_id):
                raise Refusal('invalid or duplicate Machine identity')
            url += '/' + machine_id
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        _d_phase('headers')
        with opener.open(urllib.request.Request(url, headers=headers), timeout=max(0.001, deadline-time.monotonic())) as response:
            if response.status != 200:
                raise Refusal('Machines HTTP status refused')
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
                raise Refusal('Machines response size refused')
            _d_encoding(response.headers.get('Content-Encoding',''))
            _d_phase('body_read')
            raw = response.read(MAX_BYTES+1)
            _D_COUNTS['wire_bytes'] = len(raw)
            if len(raw) > MAX_BYTES or (length is not None and len(raw) != int(length)):
                raise Refusal('incomplete or oversized Machines response')
            encoding = response.headers.get('Content-Encoding', '').strip().lower()
            if encoding == 'gzip':
                # Bound decoded bytes independently of the wire length. zlib
                # validates the gzip trailer/CRC; only one complete stream with
                # no unconsumed or trailing bytes can grant a JSON observation.
                _d_phase('decompress',wire_bytes=len(raw))
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                decoded = decoder.decompress(raw, MAX_BYTES + 1)
                if (len(decoded) > MAX_BYTES or decoder.unconsumed_tail
                        or not decoder.eof or decoder.unused_data):
                    raise Refusal('incomplete or oversized compressed Machines response')
                raw = decoded
            elif encoding not in ('', 'identity'):
                raise Refusal('unsupported Machines content encoding')
        _d_phase('json_parse',decoded_bytes=len(raw))
        parsed_value = json.loads(raw)
        _d_phase('validate')
        if metadata:
            value = app_metadata(parsed_value, app)
        elif machine_id is None:
            value = validate(parsed_value)
        else:
            value = validate([parsed_value])[0]
            if value.get('id') != machine_id:
                raise Refusal('invalid or duplicate Machine identity')
        _d_phase('encode')
        result = json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        if time.monotonic() >= deadline:
            raise Refusal('Machines decode exceeded original deadline')
        _d_phase('fetch_return',output_bytes=len(result))
        return result
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for s, handler in previous.items():
            signal.signal(s, handler)

if __name__ == '__main__':
    _d_init()
    try:
        metadata = len(sys.argv) == 4 and sys.argv[3] == '--app-metadata'
        if (len(sys.argv) != 3 and not metadata) or not float(sys.argv[2]) > 0:
            raise Refusal('invalid bounded Machines arguments')
        output = fetch(sys.argv[1], float(sys.argv[2]), metadata=metadata)
        _d_phase('stdout_write',output_bytes=len(output))
        sys.stdout.buffer.write(output)
        _d_phase('complete')
    except Exception as error:
        _d_failure(error)
        print('campaign Machines read refused: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
    finally:
        _d_close()
