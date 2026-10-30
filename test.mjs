import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, proposal } from './server.mjs';

const fixedNow = Date.parse('2026-10-30T00:00:00Z');
const event = { id: 'AI', version: 1, start: '2027-01-01T08:30:00Z', end: '2027-01-01T09:30:00Z', participants: [{ email: 'test@example.com' }], assignments: [{ start: '2027-01-01T10:30:00Z', end: '2027-01-01T11:30:00Z' }] };
const input = { start: '2027-01-01T16:00:00+05:30', recipients: ['test@example.com'], message: 'Updated schedule', notify: true };
const sampleInput = { eventId: 'AI-101', start: '2026-10-31T16:00:00+05:30', recipients: ['aarav@example.com'], message: 'The workshop has moved to 4 pm IST.', notify: true, failure: false };

test('preserves duration and resolves IST', () => { const plan = proposal(event, input, fixedNow); assert.equal(plan.start, '2027-01-01T10:30:00.000Z'); assert.equal(plan.end, '2027-01-01T11:30:00.000Z'); });
test('detects a recorded volunteer overlap', () => assert.equal(proposal(event, input, fixedNow).conflicts.length, 1));
test('rejects unlinked recipients and deduplicates linked ones', () => { assert.throws(() => proposal(event, { ...input, recipients: ['stranger@example.com'] }, fixedNow)); assert.deepEqual(proposal(event, { ...input, recipients: ['test@example.com', 'test@example.com'] }, fixedNow).recipients, ['test@example.com']); });
test('rejects invalid or past dates and invalid source durations', () => { assert.throws(() => proposal(event, { ...input, start: 'bad' }, fixedNow)); assert.throws(() => proposal(event, { ...input, start: '2001-01-01' }, fixedNow)); assert.throws(() => proposal({ ...event, end: event.start }, input, fixedNow)); });
test('adjacent assignments do not overlap', () => assert.equal(proposal(event, { ...input, start: '2027-01-01T11:30:00Z' }, fixedNow).conflicts.length, 0));
test('rejects ambiguous boolean values and empty announcements', () => { assert.throws(() => proposal(event, { ...input, notify: 'false' }, fixedNow)); assert.throws(() => proposal(event, { ...input, message: '  ' }, fixedNow)); });

async function fixture(t) {
  const temporaryRoot = fileURLToPath(new URL('../../work/sample-reliability/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'test-'));
  let server;
  async function start() { server = await createApp({ dataDir: directory, now: () => fixedNow }); }
  async function stop() { if (server?.listening) await new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); }
  await start();
  t.after(async () => { await stop(); const target = resolve(directory); assert.ok(target.startsWith(resolve(temporaryRoot) + '\\') || target.startsWith(resolve(temporaryRoot) + '/')); await rm(target, { recursive: true, force: true }); });
  function client(initialCookie = '') {
    let cookie = initialCookie;
    return { get cookie() { return cookie; }, async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      // Invoke the real HTTP request handler in-process: no network access is needed,
      // while routing, authentication, disk writes, read-back, and retries are unchanged.
      const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
      Object.assign(request, { method, url: '/api/' + path, headers: { host: 'localhost', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, socket: {} });
      const headers = new Map(); let status, output;
      const response = { setHeader(name, value) { headers.set(name.toLowerCase(), value); }, writeHead(value, values) { status = value; Object.entries(values || {}).forEach(([name, item]) => headers.set(name.toLowerCase(), item)); }, end(value) { output = value; } };
      await server.listeners('request')[0](request, response);
      const setCookie = headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      return { status, data: JSON.parse(output), headers };
    } };
  }
  const owner = client(); await owner.request('state');
  const file = () => join(directory, owner.cookie.match(/^cr_session=([a-f0-9-]{36})\./)[1] + '.json');
  async function changeStored(fn) { const state = JSON.parse(await readFile(file(), 'utf8')); fn(state); await writeFile(file(), JSON.stringify(state)); }
  return { owner, client, start, stop, file, changeStored };
}
const preview = async (client, body = {}) => { const result = await client.request('preview', { ...sampleInput, ...body }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const approve = (client, plan) => client.request('approve', { planId: plan.id, acknowledged: true });

test('successful approval persists distinct source records and immutable approval', async t => {
  const { owner } = await fixture(t), plan = await preview(owner), result = await approve(owner, plan);
  assert.equal(result.status, 200); assert.deepEqual(result.data.steps.map(step => step.status), ['Verified', 'Verified', 'Verified']);
  assert.equal(result.data.approvedPlan.id, plan.id); assert.equal(result.data.approvedPlan.message, sampleInput.message); assert.equal(result.data.approvedHash.length, 64);
  const { data: state } = await owner.request('state');
  assert.equal(state.sampleSources.calendar['AI-101'].start, plan.start); assert.equal(state.sampleSources.sheet['AI-101'].start, plan.start);
  assert.notEqual(state.sampleSources.calendar['AI-101'], state.sampleSources.sheet['AI-101']);
  assert.equal(state.notificationOutcomes.length, 1); assert.equal(state.notificationOutcomes[0].status, 'Sample recorded');
  assert.deepEqual(result.data.steps[0].verification.record, state.sampleSources.calendar['AI-101']);
});

test('concurrent duplicate approvals share one run and one announcement outcome', async t => {
  const { owner } = await fixture(t), plan = await preview(owner);
  const [first, second] = await Promise.all([approve(owner, plan), approve(owner, plan)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.data.id, second.data.id);
  const { data: state } = await owner.request('state'); assert.equal(state.runs.length, 1); assert.equal(state.notificationOutcomes.length, 1); assert.equal(state.sampleSources.calendar['AI-101'].revision, 2);
});

test('partial failure preserves old Sheet data and targeted retry skips verified Calendar', async t => {
  const { owner } = await fixture(t), plan = await preview(owner, { failure: true }), { data: run } = await approve(owner, plan);
  assert.deepEqual(run.steps.map(step => step.status), ['Verified', 'Failed', 'Pending']);
  const { data: partial } = await owner.request('state'); assert.equal(partial.sampleSources.calendar['AI-101'].start, plan.start); assert.equal(partial.sampleSources.sheet['AI-101'].start, plan.before.start); assert.equal(partial.notificationOutcomes.length, 0);
  assert.equal((await owner.request('preview', sampleInput)).status, 409);
  const retry = await owner.request('retry', { runId: run.id }); assert.equal(retry.status, 200); assert.deepEqual(retry.data.steps.map(step => step.status), ['Verified', 'Verified', 'Verified']);
  assert.equal(retry.data.steps[0].attempts, 1); assert.equal(retry.data.steps[0].verifiedAt, run.steps[0].verifiedAt); assert.equal(retry.data.steps[1].attempts, 2);
  await owner.request('retry', { runId: run.id }); const { data: state } = await owner.request('state'); assert.equal(state.notificationOutcomes.length, 1);
});

test('signed session and unfinished run survive a server restart', async t => {
  const { owner, stop, start } = await fixture(t), plan = await preview(owner, { failure: true }), { data: run } = await approve(owner, plan);
  const originalCookie = owner.cookie; await stop(); await start();
  const refreshed = await owner.request('state'); assert.equal(refreshed.status, 200); assert.equal(owner.cookie, originalCookie); assert.equal(refreshed.data.runs[0].id, run.id);
  const recovered = await owner.request('retry', { runId: run.id }); assert.equal(recovered.status, 200); assert.equal(recovered.data.status, 'Completed');
});

test('source change after preview blocks approval even if event version did not change', async t => {
  const { owner, changeStored } = await fixture(t), plan = await preview(owner);
  await changeStored(state => { state.sampleSources.sheet['AI-101'].revision += 1; });
  const result = await approve(owner, plan); assert.equal(result.status, 409); assert.match(result.data.error, /changed since your preview/);
  const { data: state } = await owner.request('state'); assert.equal(state.runs.length, 0);
});

test('retry refuses divergent source records without repeating verified steps', async t => {
  const { owner, changeStored } = await fixture(t), plan = await preview(owner, { failure: true }), { data: run } = await approve(owner, plan);
  await changeStored(state => { state.sampleSources.sheet['AI-101'].start = '2026-10-31T12:00:00.000Z'; state.sampleSources.sheet['AI-101'].revision += 1; });
  const result = await owner.request('retry', { runId: run.id }); assert.equal(result.status, 409);
  const { data: state } = await owner.request('state'); assert.equal(state.runs[0].steps[1].status, 'Needs checking'); assert.equal(state.runs[0].steps[0].attempts, 1); assert.equal(state.notificationOutcomes.length, 0);
});

test('retry uses the saved approved announcement rather than a subsequently edited proposal', async t => {
  const { owner, changeStored } = await fixture(t), plan = await preview(owner, { failure: true }), { data: run } = await approve(owner, plan);
  await changeStored(state => { state.plans[0].message = 'Unapproved replacement'; state.plans[0].recipients = []; });
  assert.equal((await owner.request('retry', { runId: run.id })).status, 200);
  const { data: state } = await owner.request('state'); assert.equal(state.notificationOutcomes[0].message, sampleInput.message);
});

test('an interrupted source write is read back on recovery rather than blindly repeated', async t => {
  const { owner, changeStored } = await fixture(t), plan = await preview(owner, { failure: true }), { data: run } = await approve(owner, plan);
  await changeStored(state => { state.sampleSources.sheet['AI-101'] = { eventId: 'AI-101', start: plan.start, end: plan.end, revision: 2 }; state.runs[0].steps[1].status = 'Running'; });
  const result = await owner.request('retry', { runId: run.id }); assert.equal(result.status, 200);
  const { data: state } = await owner.request('state'); assert.equal(state.sampleSources.sheet['AI-101'].revision, 2); assert.equal(state.runs[0].steps[1].verification.record.revision, 2);
});

test('cross-session run and plan access fails; forged cookies create an isolated workspace', async t => {
  const { owner, client } = await fixture(t), plan = await preview(owner), { data: run } = await approve(owner, plan), stranger = client();
  assert.equal((await approve(stranger, plan)).status, 404); assert.equal((await stranger.request('retry', { runId: run.id })).status, 404);
  const forged = client(owner.cookie.replace(/.$/, owner.cookie.endsWith('a') ? 'b' : 'a')); const result = await forged.request('state'); assert.equal(result.status, 200); assert.equal(result.data.runs.length, 0); assert.notEqual(forged.cookie, owner.cookie);
  const malformed = client('cr_session=../../.session-key'); assert.equal((await malformed.request('state')).data.runs.length, 0);
});

test('GET reset is rejected and malformed saved JSON is preserved', async t => {
  const { owner, file } = await fixture(t), plan = await preview(owner); await approve(owner, plan);
  assert.equal((await owner.request('reset')).status, 405); assert.equal((await owner.request('state')).data.runs.length, 1);
  await writeFile(file(), '{broken json'); const result = await owner.request('state'); assert.equal(result.status, 500); assert.equal(await readFile(file(), 'utf8'), '{broken json');
});
