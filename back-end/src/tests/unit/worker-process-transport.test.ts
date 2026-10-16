import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalWorkerJSON, workerSHA256 } from '../../providers/workerProcessDeployment';
import { createWorkerProcessTransport } from '../../providers/workerProcessTransport';

const app = 'navi-whisper-lux';
const machineId = '8362dec7769d78';
const envelope = {
  action: process.argv.includes('--compact') ? 'status' : 'ensure',
  app,
  machineId,
  machineVersion: 'version-1',
  bootId: 'boot-1',
  bundleBase64: process.argv.includes('--compact') ? null : 'x'.repeat(1_200_000),
  signature: 'a'.repeat(64),
};
const capsule = { origin: 'https://backend.example', planIdentity: 'b'.repeat(64) };
const probe =
  "import json,sys\nb=sys.stdin.buffer.read()\nprint(json.dumps({'inputBytes':len(b)}))";
const pythonHarness = `
import io,json,sys,urllib.request
from pathlib import Path
body=Path(sys.argv[2]).read_bytes()
options=json.loads(sys.argv[4])
class Reply:
 status=200
 headers={}
 def __init__(self):
  self.status=options.get('status',200)
  self.headers=options.get('headers',{})
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,n): return body[:n]
class Opener:
 def open(self,request,timeout):
  Path(sys.argv[3]).write_text(json.dumps({'url':request.full_url,'headers':dict(request.header_items()),'timeout':timeout}))
  if options.get('redirect'):
   redirect_handler.redirect_request(request,None,302,'redirect',{},'https://foreign.example/')
  return Reply()
def opener(*args):
 global redirect_handler
 redirect_handler=args[0]
 return Opener()
urllib.request.build_opener=opener
sys.stdin=io.TextIOWrapper(io.BytesIO(b''))
exec(compile(sys.argv[1],'<actual-native-command>','exec'),{'__name__':'__main__'})
`;

async function negativeControls() {
  const directory = mkdtempSync(join(tmpdir(), 'worker-capsule-'));
  try {
    const bodyPath = join(directory, 'body.json');
    const tracePath = join(directory, 'http.json');
    let options: Record<string, unknown> = {};
    let responseBody = JSON.stringify(envelope);
    let key: string | undefined = 'fixture-secret-no-live';
    const nativeBodies: { command: string[]; timeout: number }[] = [];
    const fakeNative = (async (_url: unknown, init?: RequestInit) => {
      const wire = String(init?.body);
      assert.ok(
        Buffer.byteLength(wire) <= 15 * 1024,
        'native command exceeds measured safe margin'
      );
      assert.ok(!wire.includes('fixture-secret-no-live'));
      const body = JSON.parse(wire);
      assert.equal('stdin' in body, false);
      nativeBodies.push(body);
      writeFileSync(bodyPath, responseBody);
      const env = { ...process.env };
      delete env.BACKEND_API_KEY;
      if (key !== undefined) env.BACKEND_API_KEY = key;
      const child = spawnSync(
        'python3',
        [
          '-I',
          '-B',
          '-c',
          pythonHarness,
          body.command[4],
          bodyPath,
          tracePath,
          JSON.stringify(options),
        ],
        {
          encoding: 'utf8',
          env,
        }
      );
      return Response.json({ exit_code: child.status, stdout: child.stdout });
    }) as typeof fetch;
    const transport = createWorkerProcessTransport('fixture-token', fakeNative, capsule);
    const attempt = () => transport.execBootstrap(app, machineId, probe, envelope);
    const reject = async (name: string) => {
      await assert.rejects(attempt(), /terminal successful/);
      process.stdout.write(`PASS ${name}` + '\n');
    };
    responseBody = JSON.stringify({ ...envelope, bootId: 'different-boot' });
    await reject('changed envelope rejected before trusted bootstrap');
    responseBody = 'not JSON';
    await reject('malformed envelope rejected');
    responseBody = JSON.stringify(envelope);
    options = { status: 403 };
    await reject('backend authentication failure rejected');
    options = { headers: { 'Content-Length': String(48 * 1024 * 1024 + 1) } };
    await reject('oversized declared envelope rejected');
    options = {};
    responseBody = ' '.repeat(48 * 1024 * 1024 + 1);
    await reject('oversized streamed envelope rejected without trusting content length');
    responseBody = JSON.stringify(envelope);
    options = { redirect: true };
    await reject('credential-bearing redirect rejected');
    options = {};
    key = undefined;
    rmSync(tracePath, { force: true });
    await reject('absent inherited credential rejected before HTTP');
    assert.throws(() => readFileSync(tracePath));
    key = 'fixture-secret-no-live';
    await attempt();
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const url = new URL(trace.url);
    assert.equal(
      url.searchParams.get('envelopeSHA256'),
      workerSHA256(canonicalWorkerJSON(envelope))
    );
    assert.equal(url.searchParams.get('planIdentity'), capsule.planIdentity);
    assert.equal(url.searchParams.get('machineVersion'), envelope.machineVersion);
    assert.equal(url.searchParams.get('bootId'), envelope.bootId);
    assert.equal(url.pathname, '/api/worker-process-runtime');
    assert.equal(url.searchParams.has('signature'), false);
    process.stdout.write(
      'PASS fetched envelope bound to exact plan, host, boot and canonical digest' + '\n'
    );
    const compact = { ...envelope, action: 'status', bundleBase64: null, note: 'native café' };
    responseBody = JSON.stringify(compact);
    const compactReceipt = await transport.execBootstrap(app, machineId, probe, compact);
    assert.equal(
      (compactReceipt as unknown as { inputBytes: number }).inputBytes,
      Buffer.byteLength(responseBody)
    );
    process.stdout.write(
      'PASS compact status uses same pinned bootstrap and UTF-8 canonical digest\n'
    );
    for (const origin of [
      'http://backend.example',
      'https://key@backend.example',
      'https://backend.example/path',
      'https://backend.example/?x=1',
    ]) {
      assert.throws(() =>
        createWorkerProcessTransport('token', fakeNative, { ...capsule, origin })
      );
    }
    const count = nativeBodies.length;
    await assert.rejects(
      createWorkerProcessTransport('token', fakeNative).execBootstrap(
        app,
        machineId,
        probe,
        envelope
      ),
      /capsule/
    );
    await assert.rejects(
      transport.execBootstrap(app, machineId, probe, { ...envelope, machineId: 'foreign' }),
      /exact existing host/
    );
    await assert.rejects(
      transport.execBootstrap(app, machineId, probe, { ...envelope, action: 'other' }),
      /exact existing host/
    );
    await assert.rejects(
      transport.execBootstrap(app, machineId, `${probe}\n# changed`, envelope),
      /source changed/
    );
    assert.equal(nativeBodies.length, count);
    process.stdout.write(
      'PASS invalid origin, missing capsule, foreign host/action and changed source have zero native calls' +
        '\n'
    );

    const source = readFileSync(
      join(__dirname, '../../../../scripts/production_worker_process.py'),
      'utf8'
    );
    let captured = '';
    const inspect = (async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body);
      assert.ok(Buffer.byteLength(captured) <= 15 * 1024);
      return Response.json({ exit_code: 0, stdout: '{"phase":"MISSING"}' });
    }) as typeof fetch;
    await createWorkerProcessTransport('token', inspect, capsule).execBootstrap(
      app,
      machineId,
      source,
      envelope
    );
    if (typeof envelope.bundleBase64 === 'string')
      assert.ok(!captured.includes(envelope.bundleBase64));
    assert.ok(!captured.includes(source));
    const command = JSON.parse(captured).command[4] as string;
    assert.equal(command.split('base64.b64decode(').length - 1, 1);
    process.stdout.write(
      `PASS exact production bootstrap compressed once: ${Buffer.byteLength(captured)} native wire bytes` +
        '\n'
    );

    const native = createWorkerProcessTransport('token', (async (
      _url: unknown,
      init?: RequestInit
    ) =>
      init?.method === 'GET'
        ? Response.json({
            id: machineId,
            instance_id: 'native-version',
            state: 'started',
            config: {},
          })
        : Response.json({
            exit_code: 0,
            stdout: '{"machineId":"8362dec7769d78"}',
          })) as typeof fetch);
    assert.equal((await native.getMachine(app, machineId)).version, 'native-version');
    assert.equal((await native.readFacts(app, machineId)).machineId, machineId);
    process.stdout.write(
      'PASS existing native instance identity and standalone readFacts remain supported' + '\n'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'worker-transport-'));
  try {
    const bodyPath = join(directory, 'response.json');
    const tracePath = join(directory, 'http.json');
    writeFileSync(bodyPath, JSON.stringify(envelope));
    const calls: Record<string, unknown>[] = [];
    const fakeNative = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command: string[] };
      calls.push(body);
      if (Buffer.byteLength(String(init?.body)) > 25 * 1024)
        return Response.json({ exit_code: 0, stdout: '', stderr: 'PayloadTooLarge' });
      const stdout = execFileSync(
        'python3',
        ['-I', '-B', '-c', pythonHarness, body.command[4], bodyPath, tracePath, '{}'],
        {
          encoding: 'utf8',
          env: { ...process.env, BACKEND_API_KEY: 'fixture-secret-no-live' },
        }
      );
      return Response.json({ exit_code: 0, stdout });
    }) as typeof fetch;
    const transport = createWorkerProcessTransport('fixture-fly-token', fakeNative, capsule);
    let receipt;
    let transportError: unknown;
    try {
      receipt = await transport.execBootstrap(app, machineId, probe, envelope);
    } catch (error) {
      transportError = error;
    }
    assert.equal(
      transportError,
      undefined,
      'actual native transport must deliver the signed envelope'
    );
    assert.equal(
      (receipt as unknown as { inputBytes: number }).inputBytes,
      Buffer.byteLength(JSON.stringify(envelope)),
      'native exec dropped signed envelope'
    );
    assert.equal(calls.length, 1);
    assert.equal('stdin' in calls[0], false, 'native API stdin is unsupported');
    assert.ok(Buffer.byteLength(JSON.stringify(calls[0])) <= 15 * 1024);
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    assert.equal(trace.headers['X-api-key'], 'fixture-secret-no-live');
    assert.equal(trace.timeout, 15);
    assert.equal(new URL(trace.url).origin, capsule.origin);
    process.stdout.write(
      `PASS actual Python loader delivers ${Buffer.byteLength(JSON.stringify(envelope))} bytes while native API ignores stdin` +
        '\n'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
main()
  .then(negativeControls)
  .catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n');
    process.exitCode = 1;
  });
