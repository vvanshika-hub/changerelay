import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createCipheriv, createHash, hkdfSync } from 'node:crypto';
import { createSupabaseStore, hashStoredPlan } from './supabase-store.mjs';
import { createAuthService } from './auth.mjs';

const OWNER = '7b868a5b-0893-4135-91b0-493c069518d4';
const OTHER = '83ca7ed5-1236-43cd-93e7-152ab696cece';
const WORKSPACE = '1ac45d55-098f-4224-8950-e4a11e42ad80';
const OTHER_WORKSPACE = '625574cf-d71b-4c5a-b68c-a5171717f821';
const KEY = Buffer.alloc(32, 17);
const clone = value => structuredClone(value);

export function createStoreFixture() {
  const db = { clock: Date.UTC(2026, 9, 30, 9), state: new Map(), workspaces: new Map(), calls: [], rejectWrites: 0 };
  const client = { rpc: async (name, params) => {
    db.calls.push({ name, params: clone(params) });
    if (name === 'ensure_runtime_workspace') {
      if (!db.workspaces.has(params.p_owner_id)) db.workspaces.set(params.p_owner_id, { id: params.p_owner_id === OWNER ? WORKSPACE : OTHER_WORKSPACE, owner_id: params.p_owner_id, name: params.p_name, timezone: 'Asia/Kolkata', is_runtime_primary: true });
      return { data: clone(db.workspaces.get(params.p_owner_id)), error: null };
    }
    const parent = db.workspaces.get(params.p_owner_id);
    if (!parent || parent.id !== params.p_workspace_id || parent.deletion_requested_at) return { data: null, error: { code: '42501', message: 'private-provider-error' } };
    const key = `${params.p_owner_id}:${params.p_workspace_id}`;
    if (name === 'read_runtime_state') {
      const row = db.state.get(key);
      return { data: row ? [{ ...clone(row), server_time: new Date(db.clock).toISOString() }] : [], error: null };
    }
    if (name === 'compare_and_swap_runtime_state') {
      if (db.rejectWrites > 0) { db.rejectWrites--; return { data: false, error: null }; }
      const old = db.state.get(key);
      if ((old?.revision || 0) !== params.p_expected_revision) return { data: false, error: null };
      db.state.set(key, { revision: params.p_expected_revision + 1, ciphertext: params.p_ciphertext, key_version: params.p_key_version, updated_at: new Date(db.clock).toISOString() });
      return { data: true, error: null };
    }
    throw new Error('Unexpected RPC');
  }, from: () => {
    const filters = {};
    const query = { select: () => query, eq: (key, value) => { filters[key] = value; return query; }, is: () => query, maybeSingle: async () => {
      const row = db.workspaces.get(filters.owner_id);
      return { data: row?.id === filters.id ? clone(row) : null, error: null };
    }, order: () => query, gt: (key, value) => { filters.after = value; return query; }, limit: async count => ({ data: [...db.workspaces.values()].filter(row => row.is_runtime_primary && !row.deletion_requested_at && (!filters.after || row.owner_id > filters.after)).sort((a, b) => a.owner_id.localeCompare(b.owner_id)).slice(0, count).map(row => ({ owner_id: row.owner_id })), error: null }) }; return query;
  } };
  const store = createSupabaseStore({ client, encryptionKey: KEY, now: () => db.clock });
  return { db, client, store, scoped: store.forOwner(OWNER) };
}
const fixture = createStoreFixture;

async function eventFixture(scoped) {
  return scoped.saveEvent({ event: { stableEventId: 'AI-101', title: 'Demo AI Workshop', start: '2026-10-31T08:30:00.000Z', end: '2026-10-31T09:30:00.000Z', timezone: 'Asia/Kolkata', participants: [] }, mapping: { calendar: { calendarId: 'private-calendar-id', eventId: 'private-calendar-event' }, schedule: { spreadsheetId: 'private-spreadsheet-id', sheetId: 'private-tab-id', eventId: 'AI-101', mapping: { start: 'start', end: 'end', eventId: 'event_id' } } } });
}
async function planFixture(scoped, event, snapshot = {}) {
  const workspace = await scoped.ensureWorkspace();
  const mapping = await scoped.getEventMapping(event.id);
  const plan = { id: randomUUID(), ownerId: OWNER, workspaceId: workspace.id, eventId: event.id, version: 1, eventVersion: event.version, mappingVersion: mapping.version, snapshot: { target: { start: '2026-10-31T10:30:00.000Z', end: '2026-10-31T11:30:00.000Z' }, recipients: [], ...snapshot }, createdAt: '2026-10-30T09:00:00.000Z' };
  plan.hash = hashStoredPlan(plan); return scoped.savePlan(plan);
}
function approvalInput(plan) {
  const approvalId = randomUUID(), approvedAt = '2026-10-30T09:00:00.000Z';
  return { planId: plan.id, version: plan.version, hash: plan.hash, acknowledged: false, approvedAt, approvalId, run: { id: randomUUID(), ownerId: OWNER, workspaceId: WORKSPACE, eventId: plan.eventId, planId: plan.id, planVersion: plan.version, planHash: plan.hash, approval: { id: approvalId, approvedAt, version: plan.version, hash: plan.hash, acknowledged: false }, status: 'pending', steps: ['calendar', 'sheets', 'gmail'].map((kind, index) => ({ kind, ordinal: index + 1, required: index < 2, status: index < 2 ? 'pending' : 'skipped', attempts: 0, summary: 'Waiting.', verification: null })), createdAt: approvedAt, updatedAt: approvedAt, lastError: null } };
}

test('missing configuration is a setup state and never constructs a privileged client', async () => {
  let calls = 0; const store = createSupabaseStore({ createClientImpl: () => { calls++; throw new Error('Unexpected'); } });
  assert.equal(store.configured, false);
  await assert.rejects(store.forOwner(OWNER).ensureWorkspace(), error => error.code === 'STORAGE_SETUP_REQUIRED');
  assert.equal(calls, 0);
});

test('workspace bootstrap is stable and every runtime RPC scopes owner and workspace', async () => {
  const { scoped, db } = fixture();
  const first = await scoped.ensureWorkspace({ name: 'Goa organisers' });
  assert.equal(first.id, WORKSPACE); assert.equal((await scoped.ensureWorkspace()).id, WORKSPACE);
  await scoped.saveSetup({ chosenCalendarLabel: 'My calendar' });
  for (const call of db.calls) {
    assert.equal(call.params.p_owner_id, OWNER);
    if (call.name !== 'ensure_runtime_workspace') assert.equal(call.params.p_workspace_id, WORKSPACE);
  }
});

test('connection credentials and source references are encrypted at rest and omitted from safe overview', async () => {
  const { scoped, db } = fixture();
  const saved = await scoped.upsertConnection('google-calendar', { viaSocketUserId: OWNER, authId: 'private-auth-id', scriptId: 'private-script-id', serviceId: 'private-service', displayLabel: 'Demo Calendar' });
  assert(!JSON.stringify(saved).includes('private-auth-id'));
  assert.equal((await scoped.getConnection('google-calendar')).authId, 'private-auth-id');
  const event = await eventFixture(scoped); assert.equal((await scoped.getEventMapping(event.id)).calendar.calendarId, 'private-calendar-id');
  const raw = JSON.stringify([...db.state.values()]);
  assert(!raw.includes('private-auth-id')); assert(!raw.includes('private-calendar-id')); assert(!raw.includes('Demo AI Workshop'));
  const publicView = JSON.stringify(await scoped.overview()); assert(!publicView.includes('private-auth-id')); assert(!publicView.includes('private-calendar-id'));
});

test('test-user or cross-user connections cannot be reassigned to a live organiser', async () => {
  const { scoped } = fixture();
  await assert.rejects(scoped.upsertConnection('google-calendar', { viaSocketUserId: 'apps-api-test-user', authId: 'a', serviceId: 'b' }), error => error.status === 403);
});

test('two organisers cannot read each other’s events, plans or runs', async () => {
  const { scoped, store } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event);
  const { run } = await scoped.approvePlan(approvalInput(plan));
  const other = store.forOwner(OTHER);
  assert.deepEqual(await other.listEvents(), []);
  await assert.rejects(other.getEvent(event.id), error => error.status === 404);
  await assert.rejects(other.getPlan(plan.id), error => error.status === 404);
  await assert.rejects(other.getRun(run.id), error => error.status === 404);
  await assert.rejects(store.forOwner(OTHER, { workspaceId: WORKSPACE }).ensureWorkspace(), error => error.status === 404);
});

test('new store instances recover encrypted history with the same key', async () => {
  const { scoped, client } = fixture(), event = await eventFixture(scoped);
  const recreated = createSupabaseStore({ client, encryptionKey: KEY }).forOwner(OWNER);
  assert.equal((await recreated.getEvent(event.id)).stableEventId, 'AI-101');
});

test('tampered ciphertext and wrong encryption keys fail closed without replacing saved state', async () => {
  const { scoped, db, client } = fixture(); await eventFixture(scoped);
  const row = db.state.get(`${OWNER}:${WORKSPACE}`), original = row.ciphertext;
  row.ciphertext = original.slice(0, -1) + (original.at(-1) === '0' ? '1' : '0');
  await assert.rejects(scoped.listEvents(), error => error.code === 'STORAGE_INTEGRITY_FAILED');
  assert.equal(row.ciphertext, db.state.get(`${OWNER}:${WORKSPACE}`).ciphertext);
  row.ciphertext = original;
  const wrongKey = createSupabaseStore({ client, encryptionKey: Buffer.alloc(32, 18) }).forOwner(OWNER);
  await assert.rejects(wrongKey.listEvents(), error => error.code === 'STORAGE_INTEGRITY_FAILED');
});

test('authenticated ciphertext containing invalid JSON is rejected and preserved', async () => {
  const { scoped, db } = fixture(); await eventFixture(scoped);
  const row = db.state.get(`${OWNER}:${WORKSPACE}`);
  const key = Buffer.from(hkdfSync('sha256', KEY, Buffer.from('ChangeRelay runtime storage'), Buffer.from('private workspace aggregate runtime-v1'), 32));
  const iv = Buffer.alloc(12, 1), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`ChangeRelay|runtime-v1|${OWNER}|${WORKSPACE}`));
  const data = Buffer.concat([cipher.update('not-json'), cipher.final()]);
  row.ciphertext = '\\x' + Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]).toString('hex');
  const original = row.ciphertext;
  await assert.rejects(scoped.listEvents(), error => error.code === 'STORAGE_INTEGRITY_FAILED');
  assert.equal(db.state.get(`${OWNER}:${WORKSPACE}`).ciphertext, original);
});

test('concurrent setup changes use CAS retry without losing either change', async () => {
  const { scoped } = fixture();
  await Promise.all([scoped.saveSetup({ first: 'Calendar' }), scoped.saveSetup({ second: 'Sheets' })]);
  assert.deepEqual(await scoped.getSetup(), { first: 'Calendar', second: 'Sheets' });
});

test('concurrent owner preferences merge inside CAS and clearing onboarding preserves other saved settings', async () => {
  const { scoped, store } = fixture();
  const onboarding = { step: 'calendar', selections: { calendar: 'Workshop calendar' }, columns: {} };
  await scoped.saveSetup({ version: 1, onboarding });
  await Promise.all([scoped.saveSetup({ preferences: { displayTimezone: 'Asia/Kolkata' } }), scoped.saveSetup({ preferences: { notificationsDefault: true } })]);
  assert.deepEqual(await scoped.getSetup(), { version: 1, onboarding, preferences: { displayTimezone: 'Asia/Kolkata', notificationsDefault: true } });
  await scoped.saveSetup({ onboarding: null });
  assert.deepEqual((await scoped.getSetup()).preferences, { displayTimezone: 'Asia/Kolkata', notificationsDefault: true });
  assert.equal((await scoped.getSetup()).onboarding, null);
  assert.deepEqual(await store.forOwner(OTHER).getSetup(), {});
  await assert.rejects(scoped.saveSetup({ preferences: null }), error => error.status === 400);
});

test('confirmed event data clearing preserves login revocations and connections, removes event history, and advances the existing CAS revision', async () => {
  const { scoped, db, store } = fixture();
  await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' });
  const event = await eventFixture(scoped); await planFixture(scoped, event);
  const sid = randomUUID(); await scoped.revokeAuthSession({ sid, expiresAt: db.clock + 3600000 });
  await scoped.saveSetup({ onboarding: { step: 'calendar' }, preferences: { notificationsDefault: true } });
  const connection = await scoped.getConnection('gmail'), revision = db.state.get(`${OWNER}:${WORKSPACE}`).revision;
  await assert.rejects(scoped.clearEventData({ confirmation: 'clear' }), error => error.status === 400);
  assert.equal((await scoped.listEvents()).length, 1);
  assert.deepEqual(await scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), { cleared: true });
  assert.ok(db.state.get(`${OWNER}:${WORKSPACE}`).revision > revision);
  const view = await scoped.overview();
  assert.deepEqual(view.events, []); assert.deepEqual(view.plans, []); assert.deepEqual(view.runs, []);
  assert.deepEqual(await scoped.getSetup(), {}); assert.deepEqual(await scoped.getConnection('gmail'), connection);
  assert.equal(await scoped.isAuthSessionRevoked(sid), true);
  await assert.rejects(scoped.getEventMapping(event.id), error => error.status === 404);
  assert.deepEqual(await store.forOwner(OTHER).listEvents(), []);
});

test('clearing fences older in-flight setup/import scopes instead of letting them recreate removed data', async () => {
  const { store, scoped } = fixture();
  const event = await eventFixture(scoped), stale = store.forOwner(OWNER); await stale.captureRequest();
  await store.forOwner(OWNER).clearEventData({ confirmation: 'CLEAR EVENT DATA' });
  await assert.rejects(stale.saveSetup({ onboarding: { step: 'schedule' } }), error => error.status === 409 && /cleared/.test(error.message));
  await assert.rejects(eventFixture(stale), error => error.status === 409);
  await assert.rejects(stale.getEvent(event.id), error => error.status === 409);
  assert.deepEqual(await store.forOwner(OWNER).listEvents(), []);
  assert.equal((await eventFixture(store.forOwner(OWNER))).stableEventId, 'AI-101', 'A fresh explicit import remains available.');
});

test('a concurrent approval and event-data clear cannot both commit and lose an unfinished execution', async () => {
  for (const clearFirst of [true, false]) {
    const { store, scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event);
    const clearScope = store.forOwner(OWNER), approveScope = store.forOwner(OWNER);
    await Promise.all([clearScope.captureRequest(), approveScope.captureRequest()]);
    const clear = () => clearScope.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), approve = () => approveScope.approvePlan(approvalInput(plan));
    const results = await Promise.allSettled((clearFirst ? [clear, approve] : [approve, clear]).map(operation => operation()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const view = await store.forOwner(OWNER).overview();
    assert.ok(view.events.length === 0 && view.runs.length === 0 || view.events.length === 1 && view.runs.length === 1 && view.runs[0].status === 'pending');
  }
});

test('event data clearing rejects unfinished runs and completed work that still holds an active lease', async () => {
  for (const status of ['pending', 'failed', 'needs-checking', 'running']) {
    const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
    if (status !== 'pending') {
      const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker' });
      await scoped.checkpointStep({ runId: run.id, leaseToken: lease.token, generation: lease.generation, runPatch: { status } });
    }
    await assert.rejects(scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), error => error.status === 409);
    assert.equal((await scoped.listEvents()).length, 1);
  }
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker' }), fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
  for (const kind of ['calendar', 'sheets']) { await scoped.checkpointStep({ ...fence, kind, patch: { status: 'running', attempts: 1 } }); await scoped.checkpointStep({ ...fence, kind, patch: { status: 'verified', verification: { ...plan.snapshot.target } } }); }
  await scoped.checkpointStep({ ...fence, runPatch: { status: 'verified' } });
  await assert.rejects(scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), error => error.status === 409 && /lease/.test(error.message));
  await scoped.releaseRun(fence); assert.equal((await scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' })).cleared, true);
});

test('event data clearing checks uncertain receipts independently of an inconsistent completed run marker', async () => {
  for (const status of ['sending', 'needs-checking']) {
    const { scoped, key, outcome, fence } = await receiptFixture();
    await scoped.receiptStore.create(key, outcome);
    if (status === 'needs-checking') await scoped.receiptStore.update(key, { status });
    // Defense in depth: even a previously inconsistent completion must not hide uncertainty.
    await scoped.checkpointStep({ ...fence, kind: 'gmail', patch: { status: 'running', attempts: 1 } });
    await scoped.checkpointStep({ ...fence, kind: 'gmail', patch: { status: 'verified', verification: { outcomes: [] } } });
    await scoped.checkpointStep({ ...fence, runPatch: { status: 'verified' } });
    await scoped.releaseRun(fence);
    await assert.rejects(scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), error => error.status === 409 && /announcement/i.test(error.message));
    assert.equal((await scoped.receiptStore.get(key)).status, status);
    await scoped.receiptStore.update(key, { status: 'sent', providerMessageId: 'confirmed-private-message' });
    assert.equal((await scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' })).cleared, true);
  }
});

test('connection pause blocks dispatch and invalidates saved plans before any provider side effect', async () => {
  const { scoped } = fixture();
  await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' });
  const event = await eventFixture(scoped), plan = await planFixture(scoped, event), originalMapping = await scoped.getEventMapping(event.id);
  const { operation } = await scoped.beginConnectionState({ app: 'gmail', paused: true });
  assert.equal((await scoped.getConnection('gmail')).status, 'needs_attention');
  assert.equal((await scoped.getEventMapping(event.id)).version, originalMapping.version + 1);
  assert.equal((await scoped.getPlan(plan.id)).superseded, true);
  await assert.rejects(scoped.approvePlan(approvalInput(plan)), error => error.status === 409);
  await assert.rejects(scoped.beginConnectionState({ app: 'gmail', paused: true }), error => error.status === 409);
  await assert.rejects(scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' }), error => error.status === 409);
  await scoped.markConnectionDispatch({ app: 'gmail', operationId: operation.id });
  const summary = await scoped.finishConnectionState({ app: 'gmail', operationId: operation.id, verified: true });
  assert.equal(summary.status, 'paused'); assert.ok(!JSON.stringify(summary).includes('private-'));
  await assert.rejects(scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service' }), error => error.status === 409);
});

test('pause and approval contend through CAS so an unfinished run prevents provider access changes', async () => {
  for (const pauseFirst of [true, false]) {
    const { scoped, store } = fixture();
    await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' });
    const event = await eventFixture(scoped), plan = await planFixture(scoped, event);
    const pauseScope = store.forOwner(OWNER), approveScope = store.forOwner(OWNER);
    const pause = () => pauseScope.beginConnectionState({ app: 'gmail', paused: true }), approve = () => approveScope.approvePlan(approvalInput(plan));
    const results = await Promise.allSettled((pauseFirst ? [pause, approve] : [approve, pause]).map(operation => operation()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  }
});

test('uncertain connection mutations retain their desired state, allow read-only reconciliation, and fence late callbacks', async () => {
  const { scoped, db } = fixture();
  await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' });
  const first = await scoped.beginConnectionState({ app: 'gmail', paused: true });
  await scoped.markConnectionDispatch({ app: 'gmail', operationId: first.operation.id });
  const uncertain = await scoped.finishConnectionState({ app: 'gmail', operationId: first.operation.id, verified: false });
  assert.equal(uncertain.status, 'needs_attention'); assert.equal(uncertain.desiredPaused, true);
  await assert.rejects(scoped.beginConnectionState({ app: 'gmail', paused: false }), error => error.status === 409);
  const check = await scoped.beginConnectionState({ app: 'gmail', paused: true });
  assert.equal(check.operation.reconcileOnly, true);
  await assert.rejects(scoped.markConnectionDispatch({ app: 'gmail', operationId: check.operation.id }), error => error.status === 409);
  await assert.rejects(scoped.finishConnectionState({ app: 'gmail', operationId: first.operation.id, verified: true }), error => error.status === 409);
  await scoped.finishConnectionState({ app: 'gmail', operationId: check.operation.id, verified: true });
  const resume = await scoped.beginConnectionState({ app: 'gmail', paused: false });
  db.clock += 120001;
  await assert.rejects(scoped.finishConnectionState({ app: 'gmail', operationId: resume.operation.id, verified: true }), error => error.status === 409);
});

test('connection transitions retain an expired attempt for read-only recovery and allow reconnection only before dispatch', async () => {
  const { scoped, db } = fixture();
  await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' });
  const pause = await scoped.beginConnectionState({ app: 'gmail', paused: true });
  await assert.rejects(scoped.clearEventData({ confirmation: 'CLEAR EVENT DATA' }), error => error.status === 409);
  await scoped.markConnectionDispatch({ app: 'gmail', operationId: pause.operation.id });
  db.clock += 120001;
  const recovery = await scoped.beginConnectionState({ app: 'gmail', paused: true });
  assert.equal(recovery.operation.reconcileOnly, true);
  await assert.rejects(scoped.finishConnectionState({ app: 'gmail', operationId: recovery.operation.id, verified: false, reconnectRequired: true }), error => error.status === 409);
  await scoped.finishConnectionState({ app: 'gmail', operationId: recovery.operation.id, verified: true });
  const resume = await scoped.beginConnectionState({ app: 'gmail', paused: false });
  assert.equal((await scoped.finishConnectionState({ app: 'gmail', operationId: resume.operation.id, verified: false, reconnectRequired: true })).status, 'expired');
  assert.equal((await scoped.getConnection('gmail')).pendingOperation, undefined);
  assert.equal((await scoped.upsertConnection('gmail', { viaSocketUserId: OWNER, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow' })).status, 'connected');
});

test('CAS contention has a bounded retry limit', async () => {
  const { store, db } = fixture(); db.rejectWrites = 50;
  await assert.rejects(store.forOwner(OWNER).saveSetup({ test: true }), error => error.status === 409);
  assert.equal(db.calls.filter(call => call.name === 'compare_and_swap_runtime_state').length, 8);
});

test('plan versions are immutable and editing supersedes the previous approval target', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), first = await planFixture(scoped, event);
  const changed = { ...first, snapshot: { ...first.snapshot, recipients: ['new@example.com'] } }; changed.hash = hashStoredPlan(changed);
  await assert.rejects(scoped.savePlan(changed), error => error.status === 409);
  const second = await planFixture(scoped, event, { message: 'Changed draft' });
  assert.equal((await scoped.getPlan(first.id)).superseded, true);
  assert.equal((await scoped.getEvent(event.id)).latestPlanId, second.id);
  await assert.rejects(scoped.approvePlan(approvalInput(first)), error => error.status === 409);
});

test('duplicate concurrent approvals create exactly one durable run', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event);
  const [one, two] = await Promise.all([scoped.approvePlan(approvalInput(plan)), scoped.approvePlan(approvalInput(plan))]);
  assert.equal(one.run.id, two.run.id); assert.equal((await scoped.listRuns()).length, 1);
  await assert.rejects(planFixture(scoped, event), error => error.status === 409);
});

test('lease claims are mutually exclusive and heartbeat uses the database clock', async () => {
  const { scoped, db } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const claims = await Promise.all([scoped.claimRun({ runId: run.id, workerId: 'worker-1' }), scoped.claimRun({ runId: run.id, workerId: 'worker-2' })]);
  assert.equal(claims.filter(Boolean).length, 1);
  const lease = claims.find(Boolean).lease;
  db.clock += 1000;
  const renewed = await scoped.heartbeatRun({ runId: run.id, leaseToken: lease.token, generation: lease.generation, leaseSeconds: 90 });
  assert.equal(Date.parse(renewed.expiresAt), db.clock + 90000);
  await assert.rejects(scoped.heartbeatRun({ runId: run.id, leaseToken: randomUUID(), generation: lease.generation }), error => error.status === 409);
});

test('an expired in-flight operation becomes needs checking and the old worker is fenced out', async () => {
  const { scoped, db } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  await scoped.checkpointStep({ runId: run.id, leaseToken: lease.token, generation: lease.generation, kind: 'calendar', patch: { status: 'running', attempts: 1 } });
  db.clock += 61000;
  await assert.rejects(scoped.checkpointStep({ runId: run.id, leaseToken: lease.token, generation: lease.generation, kind: 'calendar', patch: { status: 'verified', verification: { start: 'target' } } }), error => error.status === 409);
  assert.equal(await scoped.claimRun({ runId: run.id, workerId: 'worker-2' }), null);
  assert.equal((await scoped.getRun(run.id)).steps[0].status, 'needs-checking');
});

test('verified steps cannot be rewritten and later steps wait for required predecessors', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
  await assert.rejects(scoped.checkpointStep({ ...fence, kind: 'sheets', patch: { status: 'running', attempts: 1 } }), error => error.status === 409);
  await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'running', attempts: 1 } });
  await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'verified', verification: { start: plan.snapshot.target.start, end: plan.snapshot.target.end } } });
  await assert.rejects(scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { summary: 'Rewritten' } }), error => error.status === 409);
});

test('final verified execution commits the exact target and advances the event version atomically', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
  for (const kind of ['calendar', 'sheets']) {
    await scoped.checkpointStep({ ...fence, kind, patch: { status: 'running', attempts: 1 } });
    await scoped.checkpointStep({ ...fence, kind, patch: { status: 'verified', verification: { ...plan.snapshot.target } } });
  }
  await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'verified' }, eventPatch: { start: '2026-11-01T10:30:00.000Z', end: '2026-11-01T11:30:00.000Z', version: 2 } }), error => error.status === 409);
  await scoped.checkpointStep({ ...fence, runPatch: { status: 'verified' }, eventPatch: { ...plan.snapshot.target, version: 2 } });
  await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'needs-checking', lastError: 'Late timeout' } }), error => error.status === 409);
  await scoped.releaseRun(fence);
  const changed = await scoped.getEvent(event.id);
  assert.equal(changed.start, plan.snapshot.target.start); assert.equal(changed.version, 2); assert.equal(changed.latestPlanId, null);
});

test('a fenced stale plan with no dispatch can stop while preserving its exact approval and allowing a fresh plan', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), input = approvalInput(plan), { run } = await scoped.approvePlan(input);
  const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
  const stopped = await scoped.checkpointStep({ ...fence, runPatch: { status: 'cancelled', resolution: 'source-stale-before-dispatch', lastError: 'The source changed before any operation started.' } });
  assert.equal(stopped.status, 'cancelled'); assert.deepEqual(stopped.approval, run.approval);
  assert.deepEqual(stopped.steps, run.steps); assert.equal((await scoped.getPlan(plan.id)).superseded, true);
  assert.equal((await scoped.getEvent(event.id)).start, event.start); assert.equal((await scoped.getEvent(event.id)).version, event.version);
  await scoped.releaseRun(fence);
  assert.equal((await scoped.approvePlan(input)).run.id, run.id, 'Repeated approval remains the same stopped receipt.');
  await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'running' } }), error => error.status === 409);
  const fresh = await planFixture(scoped, await scoped.getEvent(event.id));
  assert.notEqual(fresh.id, plan.id); assert.equal((await scoped.approvePlan(approvalInput(fresh))).run.status, 'pending');
});

test('stopping a stale plan requires the exact resolution, no step rewrites, and zero dispatch evidence', async () => {
  for (const state of ['not-started', 'running', 'failed', 'needs-checking', 'verified']) {
    const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
    const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
    const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
    const cancellation = { status: 'cancelled', resolution: 'source-stale-before-dispatch' };
    if (state === 'not-started') {
      await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'cancelled' } }), error => error.status === 409);
      await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'cancelled', resolution: 'ignore-uncertainty' } }), error => error.status === 400);
      await assert.rejects(scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { summary: 'Hide history' }, runPatch: cancellation }), error => error.status === 409);
      await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { resolution: cancellation.resolution } }), error => error.status === 400);
    } else {
      await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'running', attempts: 1, startedAt: '2026-10-30T09:00:00Z' } });
      if (state !== 'running') await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: state, ...(state === 'verified' ? { verification: { ...plan.snapshot.target } } : {}) } });
      const before = await scoped.getRun(run.id);
      await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: cancellation }), error => error.status === 409);
      assert.deepEqual(await scoped.getRun(run.id), before);
      await assert.rejects(planFixture(scoped, event), error => error.status === 409);
    }
  }
});

test('an expired worker cannot stop a stale plan after a new fenced lease is acquired', async () => {
  const { scoped, db } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const first = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  db.clock += 61000;
  const next = await scoped.claimRun({ runId: run.id, workerId: 'worker-2' });
  const runPatch = { status: 'cancelled', resolution: 'source-stale-before-dispatch' };
  await assert.rejects(scoped.checkpointStep({ runId: run.id, leaseToken: first.lease.token, generation: first.lease.generation, runPatch }), error => error.status === 409);
  assert.equal((await scoped.checkpointStep({ runId: run.id, leaseToken: next.lease.token, generation: next.lease.generation, runPatch })).status, 'cancelled');
});

test('a concurrent dispatch checkpoint and safe stale stop cannot both commit', async () => {
  for (const stopFirst of [true, false]) {
    const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
    const { lease } = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
    const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
    const stop = () => scoped.checkpointStep({ ...fence, runPatch: { status: 'cancelled', resolution: 'source-stale-before-dispatch' } });
    const dispatch = () => scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'running', attempts: 1 } });
    const results = await Promise.allSettled((stopFirst ? [stop, dispatch] : [dispatch, stop]).map(operation => operation()));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const saved = await scoped.getRun(run.id);
    assert.ok(saved.status === 'cancelled' && saved.steps[0].attempts === 0 || saved.status === 'running' && saved.steps[0].status === 'running' && saved.steps[0].attempts === 1);
  }
});

test('deleting workspaces and unsafe JSON inputs are rejected without plaintext errors', async () => {
  const { scoped, db } = fixture(); await scoped.ensureWorkspace();
  await assert.rejects(scoped.saveSetup(JSON.parse('{"__proto__":{"bad":true}}')), error => error.status === 400);
  db.workspaces.get(OWNER).deletion_requested_at = '2026-10-30T09:00:00Z';
  await assert.rejects(scoped.listEvents(), error => error.status === 404 && !error.message.includes('private-provider-error'));
});

test('explicit recovery acquires an attention run and can verify an already-applied operation without redispatch', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event), { run } = await scoped.approvePlan(approvalInput(plan));
  const first = await scoped.claimRun({ runId: run.id, workerId: 'worker-1' });
  const fence = { runId: run.id, leaseToken: first.lease.token, generation: first.lease.generation };
  await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'running', attempts: 1 } });
  await scoped.checkpointStep({ ...fence, kind: 'calendar', patch: { status: 'needs-checking', summary: 'Response timed out.' }, runPatch: { status: 'needs-checking' } });
  await scoped.releaseRun(fence);
  assert.equal(await scoped.claimRun({ runId: run.id, workerId: 'worker-2' }), null);
  const recovery = await scoped.claimRun({ runId: run.id, workerId: 'worker-2', recovery: true });
  assert.equal(recovery.run.steps[0].status, 'needs-checking');
  const recovered = await scoped.checkpointStep({ runId: run.id, leaseToken: recovery.lease.token, generation: recovery.lease.generation, kind: 'calendar', patch: { status: 'verified', verification: { ...plan.snapshot.target } } });
  assert.equal(recovered.steps[0].attempts, 1); assert.equal(recovered.steps[0].status, 'verified');
});

test('notification-enabled plans retain the required Gmail step and exact approval snapshot', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), plan = await planFixture(scoped, event, { notify: true, conflicts: [] });
  const input = approvalInput(plan); input.run.steps[2].required = true; input.run.steps[2].status = 'pending';
  const saved = await scoped.approvePlan(input);
  assert.equal(saved.run.steps[2].required, true);
  assert.equal(saved.approval.hash, plan.hash);
});

test('changing a connected account invalidates prior plans and cannot happen during an unfinished run', async () => {
  const { scoped } = fixture();
  await scoped.upsertConnection('google-calendar', { viaSocketUserId: OWNER, authId: 'private-old', serviceId: 'private-service', scriptId: 'old-script' });
  const event = await eventFixture(scoped), plan = await planFixture(scoped, event);
  await scoped.upsertConnection('google-calendar', { viaSocketUserId: OWNER, authId: 'private-new', serviceId: 'private-service' });
  assert.equal((await scoped.getConnection('google-calendar')).scriptId, null);
  assert.equal((await scoped.getPlan(plan.id)).superseded, true);
  const freshEvent = await scoped.getEvent(event.id), fresh = await planFixture(scoped, freshEvent);
  await scoped.approvePlan(approvalInput(fresh));
  await assert.rejects(scoped.upsertConnection('google-calendar', { viaSocketUserId: OWNER, authId: 'private-third', serviceId: 'private-service' }), error => error.status === 409);
});

async function receiptFixture({ verifySchedule = true } = {}) {
  const fixture = createStoreFixture(), { scoped } = fixture, event = await eventFixture(scoped);
  const id = randomUUID(), marker = 'CR-' + randomUUID();
  const notification = { id: `${id}:0`, recipient: 'recipient@demo.invalid', from: 'sender@demo.invalid', subject: `Workshop moved [${marker}]`, messageBody: 'The workshop starts at the approved time.', receiptMarker: marker };
  const plan = { id, ownerId: OWNER, workspaceId: WORKSPACE, eventId: event.id, version: 1, eventVersion: 1, mappingVersion: 1, snapshot: { target: { start: '2026-10-31T10:30:00.000Z', end: '2026-10-31T11:30:00.000Z' }, notify: true, notifications: [notification], recipients: [{ email: notification.recipient }], conflicts: [] }, createdAt: '2026-10-30T09:00:00.000Z' };
  plan.hash = hashStoredPlan(plan); await scoped.savePlan(plan);
  const input = approvalInput(plan); input.run.steps[2].required = true; input.run.steps[2].status = 'pending';
  const { run } = await scoped.approvePlan(input), { lease } = await scoped.claimRun({ runId: input.run.id, workerId: 'worker-1' });
  const fence = { runId: run.id, leaseToken: lease.token, generation: lease.generation };
  if (verifySchedule) for (const kind of ['calendar', 'sheets']) {
    await scoped.checkpointStep({ ...fence, kind, patch: { status: 'running', attempts: 1 } });
    await scoped.checkpointStep({ ...fence, kind, patch: { status: 'verified', verification: { ...plan.snapshot.target } } });
  }
  const payload = { recipient: notification.recipient, from: notification.from, subject: notification.subject, messageBody: notification.messageBody, receiptMarker: marker };
  const outcome = { ownerId: OWNER, receiptId: marker, approvalId: notification.id, approvalVersion: plan.version, approvalHash: plan.hash, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), status: 'sending', acknowledged: false, createdAt: plan.createdAt };
  return { ...fixture, run, plan, marker, key: `${OWNER}:${marker}`, outcome, fence };
}

test('announcement receipt creation is atomic and permits only one dispatch claim', async () => {
  const { scoped, key, outcome } = await receiptFixture();
  const values = await Promise.all([scoped.receiptStore.create(key, outcome), scoped.receiptStore.create(key, outcome)]);
  assert.equal(values.filter(Boolean).length, 1);
  assert.equal((await scoped.receiptStore.get(key)).status, 'sending');
});

test('a dispatching, uncertain or sent announcement receipt cannot be discarded by stopping its run', async () => {
  for (const status of ['sending', 'needs-checking', 'sent']) {
    const { scoped, key, outcome, run, fence } = await receiptFixture();
    await scoped.receiptStore.create(key, outcome);
    if (status !== 'sending') await scoped.receiptStore.update(key, { status, ...(status === 'sent' ? { providerMessageId: 'private-confirmed-message' } : {}) });
    const before = await scoped.getRun(run.id), receipt = await scoped.receiptStore.get(key);
    await assert.rejects(scoped.checkpointStep({ ...fence, runPatch: { status: 'cancelled', resolution: 'source-stale-before-dispatch' } }), error => error.status === 409);
    assert.deepEqual(await scoped.getRun(run.id), before);
    assert.deepEqual(await scoped.receiptStore.get(key), receipt);
  }
});

test('receipts require approved payloads, exact owner and verified schedule before dispatch', async () => {
  const unverified = await receiptFixture({ verifySchedule: false });
  await assert.rejects(unverified.scoped.receiptStore.create(unverified.key, unverified.outcome), error => error.status === 409);
  const good = await receiptFixture();
  await assert.rejects(good.scoped.receiptStore.create(good.key, { ...good.outcome, payloadHash: '0'.repeat(64) }), error => error.status === 409);
  await assert.rejects(good.scoped.receiptStore.get(`${OTHER}:${good.marker}`), error => error.status === 403);
  await good.scoped.receiptStore.create(good.key, good.outcome);
  await assert.rejects(good.scoped.receiptStore.update(good.key, { approvalId: 'different' }), error => error.status === 400);
});

test('Sent is terminal, acknowledgement remains distinct and provider references stay encrypted', async () => {
  const { scoped, db, key, outcome } = await receiptFixture();
  await scoped.receiptStore.create(key, outcome);
  await scoped.receiptStore.update(key, { status: 'sent', providerMessageId: 'private-message-reference', providerThreadId: 'private-thread-reference', acknowledged: false });
  await scoped.receiptStore.update(key, { status: 'needs-checking', reason: 'Late timeout response' });
  const saved = await scoped.receiptStore.get(key);
  assert.equal(saved.status, 'sent'); assert.equal(saved.acknowledged, false);
  await assert.rejects(scoped.receiptStore.update(key, { acknowledged: true }), error => error.status === 400);
  assert(!JSON.stringify([...db.state.values()]).includes('private-message-reference'));
  assert(!JSON.stringify(await scoped.overview()).includes('private-message-reference'));
});

test('worker discovery returns only active runtime workspace owners', async () => {
  const { scoped, store, db } = fixture(); await scoped.ensureWorkspace(); await store.forOwner(OTHER).ensureWorkspace();
  assert.deepEqual((await store.listRuntimeOwners()).sort(), [OWNER, OTHER].sort());
  const firstPage = await store.listRuntimeOwners({ limit: 1 });
  assert.equal(firstPage.length, 1);
  const secondPage = await store.listRuntimeOwners({ limit: 1, afterOwnerId: firstPage[0] });
  assert.equal(secondPage.length, 1);
  assert.notEqual(secondPage[0], firstPage[0]);
  assert.deepEqual(await store.listRuntimeOwners({ afterOwnerId: secondPage[0] }), []);
  db.workspaces.get(OTHER).deletion_requested_at = '2026-10-30T09:00:00Z';
  assert.deepEqual(await store.listRuntimeOwners(), [OWNER]);
});

test('concurrent product events cannot link the same external Calendar event', async () => {
  const { scoped } = fixture();
  const input = stableId => ({ event: { stableEventId: stableId, title: stableId, start: '2026-10-31T08:30:00Z', end: '2026-10-31T09:30:00Z', timezone: 'Asia/Kolkata' }, mapping: { calendar: { calendarId: 'same-calendar', eventId: 'same-provider-event' }, schedule: { spreadsheetId: 'workbook', sheetId: 'events', eventId: stableId, mapping: { eventId: 'event_id', start: 'start', end: 'end' } } } });
  const results = await Promise.allSettled([scoped.saveEvent(input('AI-101')), scoped.saveEvent(input('AI-102'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await scoped.listEvents()).length, 1);
});

test('remapping the same product event preserves identity but increments mapping version', async () => {
  const { scoped } = fixture(), event = await eventFixture(scoped), mapping = await scoped.getEventMapping(event.id);
  const saved = await scoped.saveEvent({ event, mapping });
  assert.equal(saved.id, event.id);
  assert.equal((await scoped.getEventMapping(event.id)).version, mapping.version + 1);
});

test('a previous worker generation cannot claim a send after takeover of the same run', async () => {
  const { scoped, db, run, key, outcome, fence } = await receiptFixture();
  const stale = scoped.receiptStore.withFence(fence);
  db.clock += 61000;
  const taken = await scoped.claimRun({ runId: run.id, workerId: 'new-worker', recovery: true });
  assert.equal(taken.lease.generation, fence.generation + 1);
  await assert.rejects(stale.create(key, outcome), error => error.status === 409);
  assert.equal(await scoped.receiptStore.get(key), null);
  const fresh = scoped.receiptStore.withFence({ runId: run.id, leaseToken: taken.lease.token, generation: taken.lease.generation });
  assert.equal(await fresh.create(key, outcome), true);
  // A real provider result may arrive after the dispatching worker lost its lease.
  // Its immutable receipt evidence is safe to save; Sent can never be downgraded.
  await stale.update(key, { providerMessageId: 'private-late-message', status: 'sent', acknowledged: false });
  assert.equal((await fresh.get(key)).status, 'sent');
});

test('durable account revocations survive store recreation, remain owner-scoped and prune expired sessions', async () => {
  const { store, client, db } = fixture(), first = randomUUID(), second = randomUUID();
  const registry = store.authSessionRegistry;
  await Promise.all([
    registry.revoke({ sid: first, userId: OWNER, expiresAt: db.clock + 1000 }),
    registry.revoke({ sid: second, userId: OWNER, expiresAt: db.clock + 10000 }),
  ]);
  const recreated = createSupabaseStore({ client, encryptionKey: KEY }).authSessionRegistry;
  assert.equal(await recreated.isRevoked({ sid: first, userId: OWNER }), true);
  assert.equal(await recreated.isRevoked({ sid: first, userId: OTHER }), false);
  assert(!JSON.stringify([...db.state.values()]).includes(first));
  db.clock += 2000;
  assert.equal(await recreated.isRevoked({ sid: first, userId: OWNER }), false);
  assert.equal(await recreated.isRevoked({ sid: second, userId: OWNER }), true);
});

test('auth rejects a logged-out cookie after both auth service and encrypted store are recreated', async () => {
  const { store, client, db } = fixture(); let getUserCalls = 0, durablyRevoked = false, providerLogout = false;
  const providerUser = { id: OWNER, email: 'organiser@example.com', email_confirmed_at: '2026-10-01T00:00:00Z', is_anonymous: false, user_metadata: {} };
  const session = { access_token: 'private-auth-access', refresh_token: 'private-auth-refresh', expires_at: Math.floor(db.clock / 1000) + 3600 };
  const config = { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_fixture', sessionKey: KEY, appUrl: 'https://changerelay.example', now: () => db.clock, createClientImpl: () => ({ auth: {
    signInWithPassword: async () => ({ data: { session }, error: null }),
    getUser: async () => { getUserCalls++; return { data: { user: providerUser }, error: null }; },
    setSession: async () => { assert.equal(durablyRevoked, true); return { data: { session }, error: null }; },
    signOut: async () => { providerLogout = true; return { error: null }; },
  } }) };
  const initial = createAuthService({ ...config, sessionRegistry: { isRevoked: store.authSessionRegistry.isRevoked, revoke: async value => { const result = await store.authSessionRegistry.revoke(value); durablyRevoked = result; return result; } } });
  const signed = (await initial.signIn({ email: providerUser.email, password: 'fixture-password' })).setCookie.split(';')[0];
  await initial.signOut(signed); assert.equal(providerLogout, true);
  const providerCalls = getUserCalls;
  const recreatedStore = createSupabaseStore({ client, encryptionKey: KEY });
  const restartedAuth = createAuthService({ ...config, sessionRegistry: recreatedStore.authSessionRegistry });
  assert.equal((await restartedAuth.currentUser(signed)).user, null);
  await assert.rejects(restartedAuth.requireUser(signed), error => error.status === 401);
  assert.equal(getUserCalls, providerCalls);
});
