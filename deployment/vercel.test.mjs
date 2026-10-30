import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, matchesGlob } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createApp, seed } from '../server.mjs';
import { AuthError } from '../auth.mjs';
import { createVercelHandler } from '../api/index.mjs';
import { startDaemon } from '../daemon.mjs';

const fixedNow = Date.parse('2026-10-30T06:00:00Z');
const project = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../../../work/vercel-adapter/', import.meta.url));
async function fixture(t, { authService = { configured: false }, liveStore = { configured: false }, viaSocketClient = {}, ...options } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'test-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(temporaryRoot))); await rm(directory, { recursive: true, force: true }); });
  const handler = createVercelHandler({ dataDir: directory, createAppImpl: settings => createApp({ ...settings, now: () => fixedNow, authService, liveStore, viaSocketClient, ...options }) });
  return { handler, directory };
}
async function request(handler, path, { method = 'GET', body, bodyGetter, parsed = true, type = 'application/json', cookie = '', origin, raw } = {}) {
  const req = Readable.from(raw === undefined ? [] : [raw]);
  Object.assign(req, { url: path, method, headers: { host: 'changerelay.test', 'content-type': type, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
  if (parsed && body !== undefined) req.body = body;
  if (bodyGetter) Object.defineProperty(req, 'body', { get: bodyGetter });
  const headers = {}; let status, output;
  const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, writeHead(code, values) { status = code; Object.entries(values || {}).forEach(([k, v]) => { headers[k.toLowerCase()] = v; }); this.headersSent = true; }, end(value) { output = value; this.writableEnded = true; } };
  await handler(req, res);
  const text = output === undefined ? '' : Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  return { status, headers, text, data: headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null };
}
const change = { eventId: 'AI-101', start: '2026-10-31T10:30:00.000Z', notify: false, message: 'Sample change.', recipients: [], failure: false };

test('hosted handler awaits async completion, initializes once, and opens no listener or worker', async () => {
  let initialized = 0;
  const server = new EventEmitter(); server.listen = () => { throw new Error('Must not listen'); };
  server.on('request', async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 5)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"finished":true}'); });
  const handler = createVercelHandler({ createAppImpl: async options => { initialized++; assert.equal(options.sampleEphemeral, true); assert.match(options.dataDir, /changerelay-sample/); return server; } });
  const results = await Promise.all([request(handler, '/one'), request(handler, '/two')]);
  assert.equal(initialized, 1); assert.ok(results.every(result => result.data.finished));
});

test('sample state declares temporary storage and parsed JSON approval executes the actual app', async t => {
  const { handler } = await fixture(t);
  const state = await request(handler, '/api/state'); assert.equal(state.status, 200); assert.equal(state.data.sampleEphemeral, true);
  const cookie = state.headers['set-cookie'].split(';')[0];
  const preview = await request(handler, '/api/preview', { method: 'POST', body: change, cookie, raw: '{"eventId":"wrong-stream-should-not-be-read"}' });
  assert.equal(preview.status, 200); assert.equal(preview.data.eventId, 'AI-101'); assert.equal(preview.data.start, change.start);
  const approved = await request(handler, '/api/approve', { method: 'POST', body: { planId: preview.data.id, acknowledged: true }, cookie });
  assert.equal(approved.status, 200); assert.deepEqual(approved.data.steps.map(step => step.status), ['Verified', 'Verified', 'Skipped']);
  const after = await request(handler, '/api/state', { cookie }); assert.equal(after.data.runs.length, 1);
});

test('raw streams still work when platform helpers are disabled', async t => {
  const { handler } = await fixture(t);
  const preview = await request(handler, '/api/preview', { method: 'POST', parsed: false, raw: JSON.stringify(change) });
  assert.equal(preview.status, 200); assert.equal(preview.data.start, change.start);
});

test('parsed request normalization keeps per-route validation and byte limits', async t => {
  const { handler } = await fixture(t, { authService: { configured: true } });
  for (const body of [[], null, '{malformed']) assert.equal((await request(handler, '/api/auth/sign-in', { method: 'POST', body })).status, 400);
  assert.equal((await request(handler, '/api/auth/sign-in', { method: 'POST', body: { password: 'x'.repeat(11000) } })).status, 413);
  assert.equal((await request(handler, '/api/preview', { method: 'POST', body: { text: '₹'.repeat(18000) } })).status, 413);
  assert.equal((await request(handler, '/api/preview', { method: 'POST', body: change, type: 'text/plain' })).status, 415);
  const circular = {}; circular.self = circular;
  assert.equal((await request(handler, '/api/preview', { method: 'POST', body: circular })).status, 400);
  assert.equal((await request(handler, '/api/preview', { method: 'POST', body: change, origin: 'https://other.example' })).status, 403);
});

test('malformed JSON helper getters return safe 400 before app startup and are read only once', async () => {
  let reads = 0, starts = 0;
  const handler = createVercelHandler({ createAppImpl: () => { starts++; assert.fail('Invalid helper JSON must not initialize the app'); } });
  const result = await request(handler, '/api/auth/sign-in', { method: 'POST', bodyGetter() { reads++; throw new SyntaxError('private-malformed-payload'); } });
  assert.equal(result.status, 400); assert.equal(reads, 1); assert.equal(starts, 0); assert.equal(result.data.error, 'Enter a valid request.'); assert.ok(!result.text.includes('private-malformed-payload'));
});

test('parsed account credentials reach the auth service exactly once and tokens stay out of JSON', async t => {
  let calls = 0;
  const submitted = { email: 'organiser@example.com', password: 'testing-password-only' };
  const { handler } = await fixture(t, { authService: { configured: true, signIn: async body => { calls++; assert.deepEqual(body, submitted); return { user: { id: 'user', email: submitted.email, name: 'Organiser', access_token: 'private-access' }, setCookie: 'cr_auth=private-cookie; HttpOnly; Secure', session: { refresh_token: 'private-refresh' } }; } } });
  const result = await request(handler, '/api/auth/sign-in', { method: 'POST', body: submitted });
  assert.equal(result.status, 200); assert.equal(calls, 1); assert.equal(result.headers['set-cookie'], 'cr_auth=private-cookie; HttpOnly; Secure');
  assert.ok(!/private-|testing-password/.test(result.text));
});

test('unauthenticated live requests return 401 before any workspace/provider lookup', async t => {
  let checks = 0;
  const { handler } = await fixture(t, { authService: { configured: true, requireUser: async () => { checks++; throw new AuthError(401, 'authentication_required', 'Sign in to continue.'); } }, liveStore: { configured: true, forOwner() { throw new Error('Workspace must not be read'); } } });
  assert.equal((await request(handler, '/api/live/state')).status, 401);
  assert.equal((await request(handler, '/api/live/token', { method: 'POST', body: { app: 'google-calendar' } })).status, 401);
  assert.equal(checks, 2);
});

test('only the public path allowlist is served, including the SDK browser asset', async t => {
  const { handler } = await fixture(t);
  for (const [path, type] of [['/', 'text/html'], ['/signin', 'text/html'], ['/workspace', 'text/html'], ['/app.js', 'text/javascript'], ['/vendor/viasocket-browser.js', 'text/javascript'], ['/workspace.css', 'text/css']]) {
    const result = await request(handler, path); assert.equal(result.status, 200, path); assert.equal(result.headers['content-type'], type); assert.ok(result.text.length > 100);
  }
  const head = await request(handler, '/app.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const path of ['/.env', '/server.mjs', '/data/anything.json', '/node_modules/viasocket-apps/package.json', '/%2e%2e/.env']) assert.equal((await request(handler, path)).status, 404, path);
});

test('failed cold starts return a safe response and can recover next request', async () => {
  let count = 0;
  const server = new EventEmitter(); server.on('request', (_req, res) => { res.writeHead(200); res.end('ready'); });
  const handler = createVercelHandler({ createAppImpl: () => { if (++count === 1) throw new Error('private-internal-value'); return server; } });
  const failed = await request(handler, '/'); assert.equal(failed.status, 503); assert.ok(!failed.text.includes('private-internal-value'));
  assert.equal((await request(handler, '/')).text, 'ready');
});

test('worker daemon runs only its configured background cycle and stops gracefully', async () => {
  let starts = 0, stopped = 0, cycles = 0;
  const daemon = await startDaemon({ createAppImpl: async options => { assert.equal(options.sampleEphemeral, true); return { liveService: { configured: true, async workerCycle() { cycles++; } }, listen() { throw new Error('No inbound HTTP server'); } }; }, startWorkerImpl: options => { starts++; void options.cycle(); return { async stop() { stopped++; } }; } });
  assert.equal(starts, 1); assert.equal(cycles, 1); assert.deepEqual(await daemon.stop(), { drained: true }); await daemon.stop(); assert.equal(stopped, 1);
});

test('unconfigured daemon fails closed and shutdown has a finite deadline', async () => {
  await assert.rejects(startDaemon({ createAppImpl: async () => ({ liveService: { configured: false } }), startWorkerImpl() { assert.fail('Must not start'); } }), /requires complete/);
  const daemon = await startDaemon({ createAppImpl: async () => ({ liveService: { configured: true, workerCycle() {} } }), startWorkerImpl: () => ({ stop: () => new Promise(() => {}) }), shutdownGraceMs: 15 });
  assert.deepEqual(await daemon.stop(), { drained: false });
});

test('daemon keeps Node alive while the underlying worker timer is unrefed', async t => {
  const source = `import {startDaemon} from './daemon.mjs'; await startDaemon({createAppImpl:async()=>({liveService:{configured:true,workerCycle:async()=>{}}})}); console.log('daemon-ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([new Promise((resolve, reject) => { child.stdout.on('data', data => { if (String(data).includes('daemon-ready')) resolve(); }); child.once('error', reject); child.once('exit', () => reject(new Error('Daemon exited before ready'))); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Daemon startup timed out')), 5000); timer.unref(); })]);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(child.exitCode, null);
  const exited = once(child, 'exit'); child.kill(); await exited;
});

test('Vercel package config includes dynamic assets and one approved minimum-size recovery worker', async () => {
  const config = JSON.parse(await readFile(join(project, 'vercel.json'), 'utf8'));
  assert.equal(config.outputDirectory, 'deployment/static'); assert.equal(config.fluid, true); assert.equal(config.functions['api/index.mjs'].maxDuration, 300);
  assert.match(config.functions['api/index.mjs'].includeFiles, /public\/\*\*/); assert.match(config.functions['api/index.mjs'].includeFiles, /viasocket-apps\/dist\/esm\/browser\.js/);
  assert.equal(config.daemons.worker.resources.requests.memory, '1Gi'); assert.deepEqual(config.daemons.worker.instances, { iad1: 1 }); assert.equal(config.daemons.worker.terminationGracePeriodSeconds, 30);
  for (const file of ['.dockerignore', '.vercelignore']) { const ignore = await readFile(join(project, file), 'utf8'); assert.match(ignore, /\.env/); assert.match(ignore, /data/); }
  const docker = await readFile(join(project, 'Dockerfile.worker'), 'utf8'); assert.match(docker, /USER node/); assert.ok(!docker.includes('COPY . .')); assert.ok(!docker.includes('ARG '));
});

test('private local files are excluded from function tracing and Node major matches the worker image', async () => {
  const config = JSON.parse(await readFile(join(project, 'vercel.json'), 'utf8'));
  const exclude = config.functions['api/index.mjs'].excludeFiles;
  for (const path of ['data/.session-key', 'data/sample.json', 'data/nested/.private', 'data/.hidden/private.json', '.env', '.env.production.local', 'nested/.env', 'nested/.env.production', 'work/fixture.json', 'work/.private', 'auth.test.mjs', 'deployment/vercel.test.mjs']) assert.equal(matchesGlob(path, exclude), true, path);
  for (const path of ['server.mjs', 'auth.mjs', 'supabase-store.mjs', 'public/workspace.js', 'node_modules/viasocket-apps/dist/esm/browser.js']) assert.equal(matchesGlob(path, exclude), false, path);
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.engines.node, '24.x'); assert.equal(lock.packages[''].engines.node, manifest.engines.node);
});

test('hosted sample screens disclose resets while local history wording stays unchanged', async () => {
  const source = await readFile(join(project, 'public/app.js'), 'utf8');
  const definitions = source.slice(0, source.lastIndexOf("api('state').then"));
  const initialState = seed(); initialState.runs = [{ id: 'sample-run', eventId: 'AI-101', title: 'Sample workshop', created: '2026-10-30T06:00:00Z', steps: [{ name: 'Calendar', status: 'Verified', detail: 'Sample verified.' }] }];
  const context = { sessionStorage: { getItem() { return null; } }, location: { hash: '' }, window: { addEventListener() {} }, document: {}, URLSearchParams, initialState };
  const pages = runInNewContext(`${definitions}\nstate=initialState;state.sampleEphemeral=true;const hosted={landing:landing(),workspace:shell(''),activity:activity(),settings:settings()};state.sampleEphemeral=false;({hosted,localActivity:activity(),localSettings:settings()});`, context);
  assert.match(pages.hosted.landing, /Temporary sample workspace/); assert.match(pages.hosted.workspace, /can reset when the server instance changes/);
  assert.match(pages.hosted.activity, /temporary sample history/); assert.doesNotMatch(pages.hosted.activity, /refresh-safe saved history/);
  assert.match(pages.hosted.settings, /temporary server storage/); assert.doesNotMatch(pages.hosted.settings, /stores event changes on this local server/);
  assert.match(pages.localActivity, /refresh-safe saved history/); assert.match(pages.localSettings, /stores event changes on this local server/);
});
