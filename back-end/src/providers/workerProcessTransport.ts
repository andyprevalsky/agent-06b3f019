import { deflateSync } from 'node:zlib';
import {
  canonicalWorkerJSON,
  workerSHA256,
  type NativeWorkerHost,
  type ProcessReceipt,
  type RuntimeHostFacts,
  type WorkerProcessTransport,
} from './workerProcessDeployment';

const FACTS_SCRIPT = [
  'import json,os,http.client',
  'from pathlib import Path',
  'primary=None',
  "for p in Path('/proc').iterdir():",
  ' try:',
  "  if not p.name.isdigit() or (p/'cwd').resolve()!=Path('/app'): continue",
  "  args=(p/'cmdline').read_bytes().split(b'\\0')",
  "  if not any(a==b'worker.py' or a.endswith(b'/worker.py') for a in args): continue",
  "  before=(p/'stat').read_text().rsplit(')',1)[1].split()",
  "  c=http.client.HTTPConnection('127.0.0.1',8080,timeout=2)",
  "  c.request('GET','/health'); r=c.getresponse(); h=json.loads(r.read(65537)); c.close()",
  "  after=(p/'stat').read_text().rsplit(')',1)[1].split()",
  "  if before[19]!=after[19] or after[0]=='Z': continue",
  "  primary={'pid':int(p.name),'birthTicks':after[19],'buildId':h.get('build_id'),'healthy':r.status==200 and h.get('healthy') is True,'phase':h.get('phase')}",
  ' except (OSError,ValueError,http.client.HTTPException): continue',
  "print(json.dumps({'machineId':os.getenv('FLY_MACHINE_ID'),'machineVersion':os.getenv('FLY_MACHINE_VERSION'),'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'primary':primary}))",
].join('\n');

interface ExecReply {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  exit_signal?: number;
}
export function createWorkerProcessTransport(
  token: string,
  fetcher: typeof fetch = fetch,
  capsule?: { origin: string; planIdentity: string }
): WorkerProcessTransport {
  if (!token) throw new Error('Missing existing Fly API credential for runtime recovery');
  const planIdentity = capsule?.planIdentity;
  let origin: string | undefined;
  if (capsule) {
    const parsed = new URL(capsule.origin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/' ||
      !/^[a-f0-9]{64}$/.test(capsule.planIdentity)
    )
      throw new Error('Invalid retained runtime capsule identity');
    origin = parsed.origin;
  }
  let pinnedSource: string | undefined;
  let compressedSource: string | undefined;
  const exactURL = (app: string, id: string, exec = false) => {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(app) || !/^[a-f0-9]{14}$/.test(id))
      throw new Error('Invalid exact existing Machine target');
    return `https://api.machines.dev/v1/apps/${app}/machines/${id}${exec ? '/exec' : ''}`;
  };
  const request = async (url: string, body?: unknown): Promise<unknown> => {
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok)
      throw new Error(`Existing Machine observation returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 128 * 1024)
      throw new Error('Existing Machine observation exceeds response bound');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Existing Machine observation is not JSON');
    }
  };
  const run = async (app: string, id: string, source: string): Promise<unknown> => {
    const command = {
      command: ['python', '-I', '-B', '-c', source],
      timeout: 30,
    };
    if (Buffer.byteLength(JSON.stringify(command)) > 15 * 1024)
      throw new Error('Existing Machine command exceeds supported transport bound');
    const reply = (await request(exactURL(app, id, true), command)) as ExecReply;
    if (reply.exit_code !== 0 || reply.exit_signal || typeof reply.stdout !== 'string')
      throw new Error('Existing Machine command did not return a terminal successful receipt');
    try {
      return JSON.parse(reply.stdout);
    } catch {
      throw new Error('Worker runtime receipt is not JSON');
    }
  };
  return {
    async listMachines(app) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(app))
        throw new Error('Invalid exact existing Machine app');
      const machines = await request(`https://api.machines.dev/v1/apps/${app}/machines`);
      if (!Array.isArray(machines))
        throw new Error('Existing Machine pool is not a complete native list');
      return machines;
    },
    async getMachine(app, id) {
      const raw = (await request(exactURL(app, id))) as NativeWorkerHost & {
        instance_id?: unknown;
      };
      const version = raw.version ?? raw.instance_id;
      if (
        raw.id !== id ||
        typeof version !== 'string' ||
        !version ||
        (raw.version !== undefined &&
          raw.instance_id !== undefined &&
          raw.version !== raw.instance_id)
      )
        throw new Error('Existing Machine instance identity is absent or conflicting');
      return { ...raw, version };
    },
    async readFacts(app, id) {
      return (await run(app, id, FACTS_SCRIPT)) as RuntimeHostFacts;
    },
    async execBootstrap(app, id, source, envelope) {
      if (!capsule || !origin) throw new Error('Missing retained runtime capsule');
      exactURL(app, id);
      if (
        !['status', 'ensure'].includes(String(envelope.action)) ||
        envelope.app !== app ||
        envelope.machineId !== id ||
        typeof envelope.machineVersion !== 'string' ||
        !envelope.machineVersion ||
        typeof envelope.bootId !== 'string' ||
        !envelope.bootId
      )
        throw new Error('Runtime envelope does not identify the exact existing host');
      if (
        !source ||
        Buffer.byteLength(source) > 128 * 1024 ||
        (pinnedSource !== undefined && pinnedSource !== source)
      )
        throw new Error('Runtime capsule bootstrap source changed');
      if (pinnedSource === undefined) {
        pinnedSource = source;
        compressedSource = deflateSync(Buffer.from(source), { level: 9 }).toString('base64');
      }
      const envelopeSHA256 = workerSHA256(canonicalWorkerJSON(envelope));
      const url = new URL('/api/worker-process-runtime', origin);
      for (const [key, value] of Object.entries({
        action: envelope.action,
        app,
        machineId: id,
        machineVersion: envelope.machineVersion,
        bootId: envelope.bootId,
        planIdentity,
        envelopeSHA256,
      }))
        url.searchParams.set(key, String(value));
      const loader = [
        'import base64,hashlib,io,json,os,signal,sys,urllib.request,zlib',
        'class NoRedirect(urllib.request.HTTPRedirectHandler):',
        " def redirect_request(self,*a,**k): raise ValueError('redirect denied')",
        "key=os.environ.get('BACKEND_API_KEY')",
        "if not key: raise ValueError('missing runtime credential')",
        `req=urllib.request.Request(${JSON.stringify(url.href)},headers={'X-API-Key':key,'Accept':'application/json'})`,
        'def expired(*a): raise TimeoutError()',
        'previous=signal.signal(signal.SIGALRM,expired);signal.alarm(15)',
        'try:',
        ' with urllib.request.build_opener(NoRedirect()).open(req,timeout=15) as r:',
        "  if r.status!=200 or int(r.headers.get('Content-Length','0'))>50331648: raise ValueError('invalid capsule response')",
        '  body=r.read(50331649)',
        'finally: signal.alarm(0);signal.signal(signal.SIGALRM,previous)',
        "if len(body)>50331648: raise ValueError('capsule too large')",
        "actual=hashlib.sha256(json.dumps(json.loads(body),sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()",
        `if actual!=${JSON.stringify(envelopeSHA256)}: raise ValueError('capsule digest mismatch')`,
        `source=zlib.decompress(base64.b64decode(${JSON.stringify(compressedSource)}))`,
        `if len(source)>131072 or hashlib.sha256(source).hexdigest()!=${JSON.stringify(workerSHA256(source))}: raise ValueError('bootstrap digest mismatch')`,
        "sys.stdin=io.TextIOWrapper(io.BytesIO(body),encoding='utf-8')",
        "exec(compile(source,'<worker-bootstrap>','exec'),{'__name__':'__main__'})",
      ].join('\n');
      return (await run(app, id, loader)) as ProcessReceipt;
    },
  };
}
