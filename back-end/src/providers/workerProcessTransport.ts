import type {
  NativeWorkerHost,
  ProcessReceipt,
  RuntimeHostFacts,
  WorkerProcessTransport,
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
  fetcher: typeof fetch = fetch
): WorkerProcessTransport {
  if (!token) throw new Error('Missing existing Fly API credential for runtime recovery');
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
  const run = async (
    app: string,
    id: string,
    source: string,
    envelope?: unknown
  ): Promise<unknown> => {
    const reply = (await request(exactURL(app, id, true), {
      command: ['python', '-I', '-B', '-c', source],
      timeout: 30,
      ...(envelope === undefined ? {} : { stdin: JSON.stringify(envelope) }),
    })) as ExecReply;
    if (reply.exit_code !== 0 || reply.exit_signal || typeof reply.stdout !== 'string')
      throw new Error('Existing Machine command did not return a terminal successful receipt');
    try {
      return JSON.parse(reply.stdout);
    } catch {
      throw new Error('Worker runtime receipt is not JSON');
    }
  };
  return {
    async getMachine(app, id) {
      return (await request(exactURL(app, id))) as NativeWorkerHost;
    },
    async readFacts(app, id) {
      return (await run(app, id, FACTS_SCRIPT)) as RuntimeHostFacts;
    },
    async execBootstrap(app, id, source, envelope) {
      return (await run(app, id, source, envelope)) as ProcessReceipt;
    },
  };
}
