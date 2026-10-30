import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createAuthService } from './auth.mjs';
import { createAuthRoutes } from './auth-routes.mjs';
import { createSupabaseStore } from './supabase-store.mjs';
import { createViaSocket, viaSocketConfigured } from './viasocket.mjs';
import { createLiveService } from './live-routes.mjs';
import { startDurableWorker } from './worker.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const sameRecord = (left, right) => !!left && !!right && ['eventId', 'start', 'end', 'revision'].every(key => left[key] === right[key]);
const atTarget = (record, plan) => !!record && record.eventId === plan.eventId && record.start === plan.start && record.end === plan.end;
const complete = run => run.steps.every(step => ['Verified', 'Skipped'].includes(step.status));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function seed() {
  const events = [
    { id: 'AI-101', title: 'AI Workshop', category: 'Workshop', location: 'Hacker House · Goa', start: '2026-10-31T08:30:00.000Z', end: '2026-10-31T09:30:00.000Z', timezone: 'Asia/Kolkata', participants: [{ name: 'Aarav Shah', email: 'aarav@example.com', role: 'Participant' }, { name: 'Maya Rao', email: 'maya@example.com', role: 'Participant' }, { name: 'Riya Mehta', email: 'riya@example.com', role: 'Volunteer' }], assignments: [{ name: 'Riya Mehta', title: 'Welcome desk', start: '2026-10-31T10:30:00.000Z', end: '2026-10-31T11:30:00.000Z' }], calendar: 'AI Workshop', sheet: 'Goa event schedule', version: 1 },
    { id: 'DES-102', title: 'Design for good', category: 'Community', location: 'Studio B · Goa', start: '2026-11-01T04:30:00.000Z', end: '2026-11-01T06:00:00.000Z', timezone: 'Asia/Kolkata', participants: [], assignments: [], calendar: 'Design for good', sheet: 'Goa event schedule', version: 1 }
  ];
  const records = Object.fromEntries(events.map(event => [event.id, { eventId: event.id, start: event.start, end: event.end, revision: 1 }]));
  return { schemaVersion: 2, events, plans: [], runs: [], sampleSources: { calendar: clone(records), sheet: clone(records) }, notificationOutcomes: [] };
}

export function proposal(event, body, now = Date.now()) {
  const start = new Date(body.start), duration = Date.parse(event.end) - Date.parse(event.start);
  if (typeof body.start !== 'string' || !Number.isFinite(+start) || +start <= now) throw new HttpError(400, 'Choose a valid future date and time.');
  if (!Number.isFinite(duration) || duration <= 0) throw new HttpError(400, 'The linked event has an invalid duration. Correct it before planning a change.');
  if (!Array.isArray(body.recipients) || body.recipients.some(email => typeof email !== 'string' || !event.participants.some(person => person.email === email))) throw new HttpError(400, 'Choose recipients from the linked roster.');
  if ((body.notify !== undefined && typeof body.notify !== 'boolean') || (body.failure !== undefined && typeof body.failure !== 'boolean')) throw new HttpError(400, 'Notification and sample failure choices must be true or false.');
  if (typeof body.message !== 'string' || body.message.length > 10000 || (body.notify && !body.message.trim())) throw new HttpError(400, 'Enter an announcement under 10,000 characters.');
  const end = new Date(start.getTime() + duration);
  if (!Number.isFinite(+end)) throw new HttpError(400, 'The proposed end time is invalid.');
  return { id: randomUUID(), eventId: event.id, version: event.version, before: { start: event.start, end: event.end }, start: start.toISOString(), end: end.toISOString(), message: body.message, recipients: [...new Set(body.recipients)], notify: body.notify === true, failure: body.failure === true, conflicts: event.assignments.filter(assignment => Date.parse(assignment.start) < +end && Date.parse(assignment.end) > +start), created: new Date(now).toISOString() };
}

async function sessionKey(directory) {
  const path = join(directory, '.session-key');
  try { const bytes = await readFile(path); if (bytes.length !== 32) throw new Error('Invalid stored session key.'); return bytes; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    try { await writeFile(path, key, { flag: 'wx', mode: 0o600 }); return key; }
    catch (writeError) { if (writeError.code === 'EEXIST') return sessionKey(directory); throw writeError; }
  }
}
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };

// Local sample adapter only: each source write and verification is independently persisted.
export async function createApp({ dataDir = join(root, 'data'), sampleEphemeral = false, now = () => Date.now(), authService, liveStore, viaSocketClient, liveService } = {}) {
  await mkdir(dataDir, { recursive: true });
  const store = liveStore || createSupabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, encryptionKey: process.env.AUTH_SESSION_KEY });
  const auth = authService || createAuthService({ url: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, sessionKey: process.env.AUTH_SESSION_KEY, appUrl: process.env.APP_URL || 'http://localhost:54880', sessionRegistry: store.configured ? store.authSessionRegistry : undefined });
  const authRoutes = createAuthRoutes({ service: auth, now });
  const live = liveService || createLiveService({ auth, store, viasocket: viaSocketClient || (viaSocketConfigured() ? createViaSocket() : null), sessionKey: process.env.AUTH_SESSION_KEY, now });
  const key = await sessionKey(dataDir), locks = new Map();
  const time = () => new Date(now()).toISOString();
  const sign = id => createHmac('sha256', key).update(id).digest('base64url');
  const pathFor = id => { if (!UUID.test(id)) throw new HttpError(400, 'Invalid sample session.'); return join(dataDir, id + '.json'); };
  async function load(id) {
    let value;
    try { value = JSON.parse(await readFile(pathFor(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return seed(); throw new HttpError(500, 'Saved sample data could not be read. Your existing file has been preserved.'); }
    if (value.schemaVersion !== 2 || !Array.isArray(value.events) || !Array.isArray(value.plans) || !Array.isArray(value.runs) || !value.sampleSources?.calendar || !value.sampleSources?.sheet || !Array.isArray(value.notificationOutcomes)) throw new HttpError(500, 'Saved sample data has an unsupported format. Your existing file has been preserved.');
    return value;
  }
  async function save(id, state) {
    const path = pathFor(id), temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, path); }
    catch { throw new HttpError(500, 'Sample progress could not be saved. Please check local storage before retrying.'); }
  }
  async function locked(id, action) {
    const previous = locks.get(id) ?? Promise.resolve(); let release;
    const current = new Promise(resolve => { release = resolve; }); locks.set(id, current); await previous;
    try { return await action(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
  }
  function session(request, response) {
    const raw = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('cr_session='))?.slice('cr_session='.length);
    const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(raw || '');
    if (match && UUID.test(match[1])) { const supplied = Buffer.from(match[2]), expected = Buffer.from(sign(match[1])); if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return match[1]; }
    const id = randomUUID();
    response.setHeader('Set-Cookie', `cr_session=${id}.${sign(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${request.socket.encrypted ? '; Secure' : ''}`);
    return id;
  }
  function sourceSnapshot(state, eventId) {
    const calendar = state.sampleSources.calendar[eventId], sheet = state.sampleSources.sheet[eventId];
    if (!calendar || !sheet) throw new HttpError(409, 'This event is missing a linked sample record.');
    return clone({ calendar, sheet });
  }
  function assertReadySources(state, event) {
    const source = sourceSnapshot(state, event.id);
    if (source.calendar.start !== source.sheet.start || source.calendar.end !== source.sheet.end || source.calendar.start !== event.start || source.calendar.end !== event.end) throw new HttpError(409, 'Calendar and the schedule spreadsheet disagree. Recover the unfinished change before planning another.');
    return source;
  }
  async function checkpoint(id, state, run, step, status, detail) {
    step.status = status; step.detail = detail; step.updatedAt = time(); run.updatedAt = time();
    if (status === 'Verified') step.verifiedAt = time();
    run.status = complete(run) ? 'Completed' : run.steps.some(item => ['Failed', 'Needs checking'].includes(item.status)) ? 'Needs attention' : 'Running';
    await save(id, state);
  }
  async function checkRunSources(id, state, run) {
    const plan = run.approvedPlan, event = state.events.find(item => item.id === run.eventId);
    let problem = !plan || digest(plan) !== run.approvedHash ? 'The saved approval snapshot is invalid. Review a new change.' : !event || event.version !== run.eventVersion ? 'This event changed after this run began. Review the current records before retrying.' : null;
    for (const [index, sourceName] of ['calendar', 'sheet'].entries()) {
      if (problem) break;
      const record = state.sampleSources[sourceName][run.eventId], step = run.steps[index], before = plan.sourceSnapshot[sourceName];
      const unchanged = sameRecord(record, before), written = atTarget(record, plan) && record.revision === before.revision + 1;
      if (step.status === 'Verified' ? !sameRecord(record, step.verification?.record) : !unchanged && !written) problem = `The linked sample ${sourceName === 'calendar' ? 'Calendar' : 'spreadsheet'} record changed outside this run. Review it before retrying.`;
    }
    if (problem) {
      const step = run.steps.find(item => !['Verified', 'Skipped'].includes(item.status)) ?? run.steps[1];
      await checkpoint(id, state, run, step, 'Needs checking', problem); throw new HttpError(409, problem);
    }
  }
  async function execute(id, state, run, retry = false) {
    await checkRunSources(id, state, run);
    const plan = run.approvedPlan;
    for (const [index, sourceName] of ['calendar', 'sheet'].entries()) {
      const step = run.steps[index]; if (step.status === 'Verified') continue;
      step.attempts += 1;
      await checkpoint(id, state, run, step, 'Running', `Updating the sample ${sourceName === 'calendar' ? 'Calendar event' : 'schedule row'}…`);
      if (sourceName === 'sheet' && plan.failure && !retry) { await checkpoint(id, state, run, step, 'Failed', 'Controlled sample failure. Calendar is verified; the spreadsheet is unchanged. Retry to recover this step.'); return run; }
      const record = state.sampleSources[sourceName][run.eventId];
      if (!atTarget(record, plan)) state.sampleSources[sourceName][run.eventId] = { eventId: run.eventId, start: plan.start, end: plan.end, revision: plan.sourceSnapshot[sourceName].revision + 1 };
      await save(id, state);
      const persisted = await load(id), readBack = persisted.sampleSources[sourceName][run.eventId];
      if (!atTarget(readBack, plan)) { await checkpoint(id, state, run, step, 'Needs checking', 'The sample record could not be verified. Inspect its current state before retrying.'); return run; }
      step.verification = { checkedAt: time(), record: clone(readBack) };
      if (sourceName === 'calendar') { const event = state.events.find(item => item.id === run.eventId); event.start = plan.start; event.end = plan.end; }
      await checkpoint(id, state, run, step, 'Verified', sourceName === 'calendar' ? 'Sample Calendar record updated, saved, and read back.' : 'Sample spreadsheet record located by stable event ID, saved, and read back.');
    }
    const announcement = run.steps[2];
    if (!['Verified', 'Skipped'].includes(announcement.status)) {
      await checkRunSources(id, state, run);
      if (!plan.notify || !plan.recipients.length) await checkpoint(id, state, run, announcement, 'Skipped', plan.notify ? 'No recipients selected.' : 'Notification excluded.');
      else {
        announcement.attempts += 1; await checkpoint(id, state, run, announcement, 'Running', 'Recording the approved sample announcement…');
        for (const email of plan.recipients) if (!state.notificationOutcomes.some(outcome => outcome.runId === run.id && outcome.email === email)) state.notificationOutcomes.push({ id: randomUUID(), runId: run.id, email, message: plan.message, status: 'Sample recorded', created: time() });
        await save(id, state);
        const persisted = await load(id);
        if (!plan.recipients.every(email => persisted.notificationOutcomes.some(outcome => outcome.runId === run.id && outcome.email === email && outcome.message === plan.message))) { await checkpoint(id, state, run, announcement, 'Needs checking', 'Sample announcement recording could not be verified. No real email was sent.'); return run; }
        await checkpoint(id, state, run, announcement, 'Verified', `${plan.recipients.length} approved sample announcement${plan.recipients.length === 1 ? '' : 's'} recorded. No real email was sent or acknowledged.`);
      }
    }
    return run;
  }
  const methods = { '/api/state': 'GET', '/api/reset': 'POST', '/api/preview': 'POST', '/api/approve': 'POST', '/api/retry': 'POST' };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (await authRoutes(request, response, url)) return;
      if (await live.routes(request, response, url)) return;
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
        if (url.pathname === '/vendor/viasocket-browser.js') {
          const data = await readFile(join(root, 'node_modules/viasocket-apps/dist/esm/browser.js'));
          response.writeHead(200, { 'Content-Type': 'text/javascript', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : data); return;
        }
        const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/signin': 'auth.html', '/auth.js': 'auth.js', '/workspace':'workspace.html', '/workspace.js':'workspace.js', '/workspace.css':'workspace.css' }, file = files[url.pathname];
        if (!file) { response.writeHead(404); response.end('Not found'); return; }
        const data = await readFile(join(root, 'public', file));
        response.writeHead(200, { 'Content-Type': file.endsWith('js') ? 'text/javascript' : file.endsWith('css') ? 'text/css' : 'text/html', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
        response.end(request.method === 'HEAD' ? undefined : data); return;
      }
      const method = methods[url.pathname];
      if (!method) throw new HttpError(404, 'Operation unavailable.');
      if (request.method !== method) { response.setHeader('Allow', method); throw new HttpError(405, 'Method not allowed.'); }
      if (method !== 'GET' && request.headers.origin && ![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(request.headers.origin)) throw new HttpError(403, 'Request origin rejected.');
      const id = session(request, response); let body = {};
      if (method === 'POST') {
        let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 30000) throw new HttpError(413, 'Request too large.'); }
        try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Enter a valid request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Enter a valid request.');
      }
      const result = await locked(id, async () => {
        const state = await load(id);
        if (url.pathname === '/api/state') { await save(id, state); return { ...state, mode: 'sample', liveReady: false, sampleEphemeral: sampleEphemeral === true }; }
        if (url.pathname === '/api/reset') { await save(id, seed()); return { ok: true }; }
        if (url.pathname === '/api/preview') {
          const event = state.events.find(item => item.id === body.eventId);
          if (!event) throw new HttpError(404, 'Workshop not found.');
          if (state.runs.some(run => run.eventId === event.id && !complete(run))) throw new HttpError(409, 'This workshop has an unfinished change. Recover it in Activity before planning another.');
          const plan = proposal(event, body, now()); plan.sourceSnapshot = assertReadySources(state, event);
          state.plans.push(plan); await save(id, state); return plan;
        }
        if (url.pathname === '/api/approve') {
          const plan = state.plans.find(item => item.id === body.planId);
          if (!plan) throw new HttpError(404, 'Review your change first.');
          const existing = state.runs.find(run => run.planId === plan.id); if (existing) return existing;
          const event = state.events.find(item => item.id === plan.eventId);
          if (!event || event.version !== plan.version) throw new HttpError(409, 'This event changed since your preview. Review a fresh proposal.');
          if (state.runs.some(run => run.eventId === event.id && !complete(run))) throw new HttpError(409, 'This workshop already has an unfinished change. Recover it in Activity first.');
          const source = assertReadySources(state, event);
          if (!plan.sourceSnapshot || !sameRecord(source.calendar, plan.sourceSnapshot.calendar) || !sameRecord(source.sheet, plan.sourceSnapshot.sheet)) throw new HttpError(409, 'A linked record changed since your preview. Review a fresh proposal.');
          if (plan.conflicts.length && body.acknowledged !== true) throw new HttpError(400, 'Acknowledge the volunteer conflict before approving.');
          const approvedPlan = clone(plan), stamp = time(); event.version += 1;
          const run = { id: randomUUID(), planId: plan.id, eventId: event.id, eventVersion: event.version, title: event.title, created: stamp, approvedAt: stamp, approvedPlan, approvedHash: digest(approvedPlan), acknowledged: body.acknowledged === true, status: 'Pending', steps: ['Calendar', 'Schedule spreadsheet', 'Participant announcement'].map(name => ({ name, status: 'Pending', detail: 'Waiting for the preceding checks.', attempts: 0, updatedAt: stamp })) };
          state.runs.unshift(run); await save(id, state); return execute(id, state, run);
        }
        const run = state.runs.find(item => item.id === body.runId);
        if (!run) throw new HttpError(404, 'Run not found.'); if (complete(run)) return run;
        return execute(id, state, run, true);
      });
      json(response, 200, result);
    } catch (error) { json(response, error.status || 500, { error: error.status ? error.message : 'The sample workspace could not complete this request. Saved progress has been preserved.' }); }
  });
  server.liveService = live;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  const worker = startDurableWorker({ cycle: () => server.liveService.workerCycle() });
  server.once('close', () => worker.stop());
  server.listen(process.env.PORT || 54880, process.env.HOST || '127.0.0.1', () => console.log('ChangeRelay ready at http://localhost:' + server.address().port));
}
