import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveEngine, hashLivePlan, LiveAccessError, LiveConflictError, LiveInputError, LiveLeaseLostError } from './live-engine.mjs';
import { buildCalendarUpdate, snapshotCalendarEvent } from './integrations/calendar.mjs';
import { snapshotSheetRow } from './integrations/sheets.mjs';
import { createSupabaseStore } from './supabase-store.mjs';
import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const ownerId = 'owner-a';
const currentTime = Date.parse('2026-10-30T10:00:00Z');
const columns = { eventId: 'event_id', title: 'title', start: 'start', end: 'end', timezone: 'timezone', location: 'location' };
function harness(options = {}) {
  let counter = 0, lease = null, generation = 0, calendarWrites = 0, sheetWrites = 0, sends = 0, reconciles = 0;
  let sheetFailures = options.sheetFailures || 0;
  const plans = new Map(), runs = new Map(), trace = [], gmailApprovalRecords = [];
  const event = { id: 'event-a', ownerId, workspaceId: 'workspace-a', title: 'AI Workshop', version: 1, timezone: 'Asia/Kolkata' };
  const mapping = { ownerId, version: 1, calendar: { calendarId: 'linked-calendar', eventId: 'linked-provider-event' }, schedule: { spreadsheetId: 'linked-workbook', sheetId: 'events-tab', eventId: 'AI-101', mapping: columns }, roster: { spreadsheetId: 'linked-workbook', sheetId: 'people-tab', mapping: { eventId: 'event_id', name: 'name', email: 'email', role: 'role' } }, ...(options.assignments ? { assignments: { spreadsheetId: 'linked-workbook', sheetId: 'assignments-tab', mapping: { person: 'person', eventId: 'event_id', start: 'start', end: 'end' } } } : {}) };
  let calendar = { id: mapping.calendar.eventId, etag: 'original-etag', summary: event.title, description: 'Confirmed workshop details', location: 'Room A', start: { dateTime: '2026-10-31T14:00:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-10-31T15:00:00+05:30', timeZone: 'Asia/Kolkata' }, attendees: [] };
  let sheet = { _rowNumber: 2, event_id: 'AI-101', title: event.title, start: '2026-10-31T14:00:00+05:30', end: '2026-10-31T15:00:00+05:30', timezone: 'Asia/Kolkata', location: 'Room A' };
  let roster = [{ name: 'Attendee', email: 'attendee@team.dev', role: 'participant' }, { name: 'Volunteer', email: 'volunteer@team.dev', role: 'volunteer' }];
  let otherEvents = options.otherEvents || [];
  const fenced = input => lease && input.runId === lease.runId && input.leaseToken === lease.token && input.generation === lease.generation;
  const store = {
    getEvent: async id => id === event.id ? clone(event) : null,
    getEventMapping: async id => id === event.id ? clone(mapping) : null,
    savePlan: async plan => { for (const old of plans.values()) if (old.eventId === plan.eventId) old.superseded = true; plans.set(plan.id, clone(plan)); event.latestPlanId = plan.id; return clone(plan); },
    getPlan: async id => plans.has(id) ? clone(plans.get(id)) : null,
    listRuns: async () => [...runs.values()].map(clone),
    approvePlan: async input => {
      const saved = plans.get(input.planId);
      if (!saved || saved.superseded || event.latestPlanId !== saved.id || saved.hash !== input.hash || saved.version !== input.version || event.version !== saved.eventVersion || mapping.version !== saved.mappingVersion) throw new LiveConflictError();
      const previous = [...runs.values()].find(run => run.planId === saved.id);
      if (previous) return { approval: clone(previous.approval), run: clone(previous) };
      if ([...runs.values()].some(run => run.eventId === saved.eventId && run.status !== 'verified' && run.status !== 'cancelled')) throw new LiveConflictError();
      runs.set(input.run.id, clone(input.run)); return { approval: clone(input.run.approval), run: clone(input.run) };
    },
    getRun: async id => runs.has(id) ? clone(runs.get(id)) : null,
    claimRun: async ({ runId, workerId }) => { if (options.busy || lease) return null; lease = { runId, workerId, token: 'lease-' + (++generation), generation, expiresAt: '2026-10-30T10:01:00Z' }; return { run: clone(runs.get(runId)), lease: clone(lease) }; },
    heartbeatRun: async input => fenced(input) ? clone(lease) : null,
    checkpointStep: async input => {
      if (!fenced(input)) return null;
      const run = runs.get(input.runId);
      if (input.kind) Object.assign(run.steps.find(step => step.kind === input.kind), clone(input.patch));
      Object.assign(run, clone(input.runPatch));
      if (run.status === 'cancelled') { event.latestPlanId = null; plans.get(run.planId).superseded = true; }
      if (input.eventPatch) { assert.equal(run.status, 'verified'); assert.ok(run.steps.filter(step => step.required).every(step => step.status === 'verified')); Object.assign(event, clone(input.eventPatch)); event.latestPlanId = null; for (const savedPlan of plans.values()) if (savedPlan.eventId === run.eventId) savedPlan.superseded = true; }
      trace.push({ type: 'checkpoint', kind: input.kind, status: input.patch?.status, runStatus: run.status });
      return clone(run);
    },
    releaseRun: async input => { if (!fenced(input)) return false; lease = null; return true; },
  };
  function assertRunning(kind) { assert.equal([...runs.values()][0].steps.find(step => step.kind === kind).status, 'running', 'Running must be durably stored before the provider action'); }
  const adaptersFor = async context => { trace.push({ type: 'adapter-context', fence: clone(context.fence), hasRun: !!context.run }); return ({
    calendar: {
      readEvent: async () => { trace.push({ type: 'calendar-read' }); return clone(calendar); },
      listEvents: async () => ({ events: [clone(calendar), ...clone(otherEvents)] }),
      reschedule: async input => {
        assertRunning('calendar'); calendarWrites++;
        const update = buildCalendarUpdate(calendar, input);
        calendar = { ...calendar, etag: 'updated-etag-' + calendarWrites, start: { dateTime: update.target.start, timeZone: update.target.timeZone }, end: { dateTime: update.target.end, timeZone: update.target.timeZone } };
        trace.push({ type: 'calendar-write' });
        if (options.loseLeaseDuringCalendar) lease = { ...lease, generation: lease.generation + 1, token: 'new-worker-token' };
        if (options.calendarUncertainOnce && calendarWrites === 1) return { status: 'needs-checking' };
        return { status: 'verified', event: clone(calendar) };
      },
    },
    sheets: {
      lookupEvent: async () => { trace.push({ type: 'sheet-read' }); return clone(sheet); },
      listRoster: async () => clone(roster),
      listAssignments: async () => clone(options.assignments || []),
      updateSchedule: async input => {
        assertRunning('sheets'); sheetWrites++; trace.push({ type: 'sheet-write' });
        if (sheetFailures-- > 0) return { status: 'needs-checking' };
        assert.deepEqual(snapshotSheetRow(sheet, columns), input.expected);
        sheet = { ...sheet, start: input.start, end: input.end };
        if (options.mutateRosterBeforeSend) roster[0].email = 'changed@team.dev';
        return { status: 'verified', row: clone(sheet) };
      },
    },
    gmail: {
      senderOptions: async () => ({ options: [{ label: 'Organiser', value: 'organiser@team.dev' }] }),
      sendApproved: async input => {
        assertRunning('gmail'); sends++;
        assert.equal(input.scheduleVerified, true);
        const record = await context.loadApproval({ id: input.approvalId, version: input.version, hash: input.hash, userId: ownerId });
        assert.ok(record); gmailApprovalRecords.push(clone(record));
        trace.push({ type: 'gmail-send' });
        return { status: options.gmailUncertain ? 'needs-checking' : 'sent', acknowledged: false, receiptId: record.receiptMarker };
      },
      reconcile: async () => { reconciles++; trace.push({ type: 'gmail-reconcile' }); return { status: 'sent', acknowledged: false }; },
    },
  }); };
  const engine = () => createLiveEngine({ ownerId, store, adaptersFor, now: () => currentTime, uuid: () => 'generated-' + String(++counter).padStart(4, '0') });
  const input = { eventId: event.id, start: '2026-10-31T16:00:00+05:30', notify: true, from: 'organiser@team.dev', subject: 'Workshop schedule update', messageBody: 'The workshop is moving to 4 pm IST.', recipients: ['attendee@team.dev'] };
  async function approvedRun(overrides = {}) { const plan = await engine().prepare({ ...input, ...overrides }); const { run } = await engine().approve({ planId: plan.id, version: plan.version, hash: plan.hash, acknowledged: true }); return { plan, run }; }
  return { engine, store, plans, runs, event, mapping, trace, input, approvedRun, mutateCalendar: patch => Object.assign(calendar, patch), mutateSheet: patch => Object.assign(sheet, patch), mutateRoster: patch => Object.assign(roster[0], patch), otherEvents: events => { otherEvents = events; }, counters: () => ({ calendarWrites, sheetWrites, sends, reconciles }), gmailApprovalRecords };
}

test('A full live plan persists exact approval, verifies both schedule steps before individual Gmail, and survives engine recreation', async () => {
  const h = harness(), { plan, run } = await h.approvedRun();
  assert.equal(plan.hash, hashLivePlan(plan));
  assert.ok(plan.snapshot.notifications[0].subject.includes(plan.snapshot.notifications[0].receiptMarker));
  assert.equal('calendarId' in plan.snapshot, false);
  const completed = await h.engine().execute({ runId: run.id, workerId: 'worker-a' });
  assert.equal(completed.status, 'verified');
  assert.deepEqual(completed.steps.map(step => step.status), ['verified', 'verified', 'verified']);
  assert.deepEqual(h.counters(), { calendarWrites: 1, sheetWrites: 1, sends: 1, reconciles: 0 });
  assert.ok(h.trace.findIndex(item => item.type === 'gmail-send') > h.trace.findIndex(item => item.type === 'sheet-write'));
  assert.equal(h.gmailApprovalRecords[0].subject, plan.snapshot.notifications[0].subject);
  assert.equal(h.gmailApprovalRecords[0].messageBody, plan.snapshot.notifications[0].messageBody);
  assert.equal((await h.engine().run(run.id)).status, 'verified');
  assert.equal(h.event.version, 2);
});

test('Double approving the exact plan creates one run and the completed run does not execute twice', async () => {
  const h = harness(), plan = await h.engine().prepare(h.input);
  const reference = { planId: plan.id, version: plan.version, hash: plan.hash, acknowledged: true };
  const first = await h.engine().approve(reference), second = await h.engine().approve(reference);
  assert.equal(first.run.id, second.run.id);
  await h.engine().execute({ runId: first.run.id });
  const before = clone(h.counters()), readsBefore = h.trace.filter(item => item.type.endsWith('-read')).length;
  const completedDuplicate = await h.engine().approve(reference);
  assert.equal(completedDuplicate.run.id, first.run.id);
  assert.equal(completedDuplicate.run.status, 'verified');
  assert.deepEqual(h.counters(), before);
  assert.equal(h.trace.filter(item => item.type.endsWith('-read')).length, readsBefore, 'Duplicate approval returns its receipt without rereading providers');
  await h.engine().execute({ runId: first.run.id });
  assert.equal(h.counters().sends, 1);
});

test('Source changes before dispatch retire the exact stale plan and allow a fresh review without external writes', async () => {
  for (const mutate of [h => h.mutateCalendar({ etag: 'edited-in-calendar' }), h => h.mutateCalendar({ description: 'Revised workshop details' }), h => h.mutateSheet({ location: 'Changed room' }), h => h.mutateRoster({ name: 'Updated attendee' })]) {
    const h = harness(), { plan, run } = await h.approvedRun(); mutate(h);
    const result = await h.engine().execute({ runId: run.id });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.resolution, 'source-stale-before-dispatch');
    assert.match(result.lastError, /before any update or announcement was attempted/);
    assert.ok(result.steps.every(step => step.attempts === 0));
    assert.deepEqual(h.counters(), { calendarWrites: 0, sheetWrites: 0, sends: 0, reconciles: 0 });
    const duplicate = await h.engine().approve({ planId: plan.id, version: plan.version, hash: plan.hash, acknowledged: true });
    assert.equal(duplicate.run.id, run.id); assert.equal(duplicate.run.status, 'cancelled');
    assert.equal((await h.engine().execute({ runId: run.id, retry: true })).status, 'cancelled');
    const fresh = await h.engine().prepare(h.input);
    assert.notEqual(fresh.id, plan.id); assert.equal(h.runs.get(run.id).status, 'cancelled');
    assert.deepEqual(h.counters(), { calendarWrites: 0, sheetWrites: 0, sends: 0, reconciles: 0 });
  }
});

test('A newly recorded Calendar overlap after preview requires a refreshed review', async () => {
  const h = harness(), { run } = await h.approvedRun();
  h.otherEvents([{ id: 'another-event', summary: 'New booking', start: { dateTime: '2026-10-31T16:30:00+05:30' }, end: { dateTime: '2026-10-31T17:00:00+05:30' } }]);
  assert.equal((await h.engine().execute({ runId: run.id })).status, 'cancelled');
  assert.equal(h.counters().calendarWrites, 0);
  assert.ok((await h.engine().prepare(h.input)).snapshot.conflicts.some(conflict => conflict.kind === 'calendar-overlap'));
});

test('An earlier stale failure with zero attempts can stop only through explicit recovery', async () => {
  const h = harness(), { run } = await h.approvedRun();
  Object.assign(h.runs.get(run.id), { status: 'failed', lastError: 'The source changed.' });
  Object.assign(h.runs.get(run.id).steps[0], { status: 'failed', summary: 'The source changed.', finishedAt: new Date(currentTime).toISOString() });
  h.mutateCalendar({ etag: 'edited-in-calendar' });
  assert.equal((await h.engine().execute({ runId: run.id })).status, 'failed');
  await assert.rejects(h.engine().prepare(h.input), LiveConflictError);
  assert.equal((await h.engine().execute({ runId: run.id, retry: true })).status, 'cancelled');
  await h.engine().prepare(h.input);
  assert.deepEqual(h.counters(), { calendarWrites: 0, sheetWrites: 0, sends: 0, reconciles: 0 });
});

test('Source drift after an attempted or verified update never retires the run or permits overlapping plans', async () => {
  for (const options of [{ sheetFailures: 1 }, { calendarUncertainOnce: true }, { gmailUncertain: true }]) {
    const h = harness(options), { run } = await h.approvedRun();
    const partial = await h.engine().execute({ runId: run.id });
    assert.equal(partial.status, 'needs-checking');
    const before = clone(h.counters()), savedSteps = clone(partial.steps);
    h.mutateRoster({ name: 'Changed after dispatch' });
    const blocked = await h.engine().execute({ runId: run.id, retry: true });
    assert.equal(blocked.status, 'failed'); assert.equal(blocked.resolution, undefined);
    assert.deepEqual(blocked.steps, savedSteps); assert.deepEqual(h.counters(), before);
    await assert.rejects(h.engine().prepare(h.input), LiveConflictError);
  }
});

test('Partial Sheet failure preserves Calendar work; targeted retry only reruns the unfinished step', async () => {
  const h = harness({ sheetFailures: 1 }), { run } = await h.approvedRun();
  const partial = await h.engine().execute({ runId: run.id });
  assert.equal(partial.status, 'needs-checking');
  assert.deepEqual(partial.steps.map(step => step.status), ['verified', 'needs-checking', 'pending']);
  assert.equal(h.counters().sends, 0);
  await h.engine().execute({ runId: run.id });
  assert.equal(h.counters().sheetWrites, 1, 'Attention runs require an explicit retry');
  const recovered = await h.engine().execute({ runId: run.id, retry: true });
  assert.equal(recovered.status, 'verified');
  assert.deepEqual(h.counters(), { calendarWrites: 1, sheetWrites: 2, sends: 1, reconciles: 0 });
});

test('An uncertain Calendar write is reconciled from the intended source state rather than repeated', async () => {
  const h = harness({ calendarUncertainOnce: true }), { run } = await h.approvedRun();
  assert.equal((await h.engine().execute({ runId: run.id })).status, 'needs-checking');
  assert.equal(h.counters().sheetWrites, 0);
  assert.equal((await h.engine().execute({ runId: run.id, retry: true })).status, 'verified');
  assert.equal(h.counters().calendarWrites, 1);
});

test('Uncertain Gmail is reconciled on explicit retry and never blindly sent twice', async () => {
  const h = harness({ gmailUncertain: true }), { run } = await h.approvedRun();
  assert.equal((await h.engine().execute({ runId: run.id })).status, 'needs-checking');
  assert.equal((await h.engine().execute({ runId: run.id, retry: true })).status, 'verified');
  assert.deepEqual(h.counters(), { calendarWrites: 1, sheetWrites: 1, sends: 1, reconciles: 1 });
});

test('A roster change between required schedule verification and announcement blocks Gmail', async () => {
  const h = harness({ mutateRosterBeforeSend: true }), { run } = await h.approvedRun();
  const result = await h.engine().execute({ runId: run.id });
  assert.equal(result.status, 'needs-checking');
  assert.equal(h.counters().sends, 0);
});

test('An event lease excludes another worker and an expired fencing token cannot advance later steps', async () => {
  const busy = harness({ busy: true }), { run: busyRun } = await busy.approvedRun();
  assert.equal((await busy.engine().execute({ runId: busyRun.id })).busy, true);
  assert.equal(busy.counters().calendarWrites, 0);
  const stolen = harness({ loseLeaseDuringCalendar: true }), { run } = await stolen.approvedRun();
  await assert.rejects(stolen.engine().execute({ runId: run.id }), LiveLeaseLostError);
  assert.equal(stolen.counters().sheetWrites, 0);
  assert.equal(stolen.counters().sends, 0);
  assert.equal(stolen.runs.get(run.id).steps[0].status, 'running', 'Stale worker cannot persist a false verified checkpoint');
});

test('Preparation has no dispatch fence; execution adapters receive the exact claimed run token and generation', async () => {
  const h = harness(), { run } = await h.approvedRun();
  const preparing = h.trace.find(item => item.type === 'adapter-context');
  assert.equal(preparing.fence, null);
  assert.equal(preparing.hasRun, false);
  await h.engine().execute({ runId: run.id, workerId: 'worker-with-fenced-receipts' });
  const executing = h.trace.find(item => item.type === 'adapter-context' && item.hasRun);
  assert.deepEqual(executing.fence, { runId: run.id, leaseToken: 'lease-1', generation: 1 });
});

test('Editing creates a new immutable preview and invalidates the earlier approval reference', async () => {
  const h = harness(), old = await h.engine().prepare(h.input), next = await h.engine().prepare({ ...h.input, start: '2026-10-31T17:00:00+05:30' });
  await assert.rejects(h.engine().approve({ planId: old.id, version: old.version, hash: old.hash }), LiveConflictError);
  await assert.rejects(h.engine().approve({ planId: next.id, version: 99, hash: next.hash }), LiveConflictError);
  const tampered = h.plans.get(next.id); tampered.snapshot.notifications[0].recipient = 'different@team.dev';
  await assert.rejects(h.engine().approve({ planId: next.id, version: next.version, hash: next.hash }), LiveConflictError);
});

test('Known volunteer overlap must be acknowledged and unknown availability is disclosed', async () => {
  const h = harness({ assignments: [{ name: 'Volunteer', eventId: 'other-workshop', start: '2026-10-31T16:00:00+05:30', end: '2026-10-31T17:00:00+05:30' }] });
  const plan = await h.engine().prepare(h.input);
  assert.ok(plan.snapshot.conflicts.some(conflict => conflict.kind === 'volunteer-overlap'));
  assert.ok(plan.snapshot.unavailableChecks.some(check => check.includes('Participant availability')));
  await assert.rejects(h.engine().approve({ planId: plan.id, version: plan.version, hash: plan.hash }), LiveInputError);
});

test('Cross-owner access, unlinked recipients and overlapping unfinished changes are rejected', async () => {
  const h = harness();
  const other = createLiveEngine({ ownerId: 'owner-b', store: h.store, adaptersFor: async () => ({}) });
  await assert.rejects(other.prepare(h.input), LiveAccessError);
  await assert.rejects(h.engine().prepare({ ...h.input, recipients: ['outsider@team.dev'] }), LiveInputError);
  const { run } = await h.approvedRun();
  await assert.rejects(other.run(run.id), LiveAccessError);
  await assert.rejects(h.engine().prepare(h.input), LiveConflictError);
});

test('Excluding Gmail remains a complete reviewed two-source update without any send', async () => {
  const h = harness(), { run, plan } = await h.approvedRun({ notify: false, recipients: [] });
  assert.equal(plan.snapshot.notifications.length, 0);
  const result = await h.engine().execute({ runId: run.id });
  assert.equal(result.status, 'verified');
  assert.equal(result.steps[2].status, 'skipped');
  assert.equal(h.counters().sends, 0);
});

test('A duplicate completed approval returns the same receipt through the real encrypted CAS store without provider calls', async () => {
  const verifiedOwner = '7b868a5b-0893-4135-91b0-493c069518d4', workspaceId = '1ac45d55-098f-4224-8950-e4a11e42ad80';
  let saved = null, providerCalls = 0;
  const client = { rpc: async (name, parameters) => {
    assert.equal(parameters.p_owner_id, verifiedOwner);
    if (name === 'ensure_runtime_workspace') return { data: { id: workspaceId, owner_id: verifiedOwner, name: 'Organisers', timezone: 'Asia/Kolkata' }, error: null };
    assert.equal(parameters.p_workspace_id, workspaceId);
    if (name === 'read_runtime_state') return { data: saved ? [{ ...clone(saved), server_time: new Date(currentTime).toISOString() }] : [], error: null };
    if (name === 'compare_and_swap_runtime_state') {
      if ((saved?.revision || 0) !== parameters.p_expected_revision) return { data: false, error: null };
      saved = { revision: parameters.p_expected_revision + 1, ciphertext: parameters.p_ciphertext, key_version: parameters.p_key_version };
      return { data: true, error: null };
    }
    throw Error('Unexpected storage RPC');
  } };
  const store = createSupabaseStore({ client, encryptionKey: Buffer.alloc(32, 19), now: () => currentTime }).forOwner(verifiedOwner);
  const linked = await store.saveEvent({ event: { stableEventId: 'AI-101', title: 'Workshop', start: '2026-10-31T08:30:00Z', end: '2026-10-31T09:30:00Z', timezone: 'Asia/Kolkata', location: 'Room A', participants: [] }, mapping: { calendar: { calendarId: 'calendar-reference', eventId: 'provider-event-reference' }, schedule: { spreadsheetId: 'sheet-reference', sheetId: 'events-tab', eventId: 'AI-101', mapping: columns } } });
  const mapping = await store.getEventMapping(linked.id);
  const plan = { id: randomUUID(), ownerId: verifiedOwner, workspaceId, eventId: linked.id, version: 1, eventVersion: linked.version, mappingVersion: mapping.version, snapshot: { title: linked.title, target: { start: '2026-10-31T10:30:00.000Z', end: '2026-10-31T11:30:00.000Z', timeZone: 'Asia/Kolkata' }, notify: false, notifications: [], conflicts: [], recipients: [] }, createdAt: new Date(currentTime).toISOString() };
  plan.hash = hashLivePlan(plan); await store.savePlan(plan);
  const engine = createLiveEngine({ ownerId: verifiedOwner, store, adaptersFor: async () => { providerCalls++; throw Error('Approval must not call providers'); }, now: () => currentTime });
  const reference = { planId: plan.id, version: plan.version, hash: plan.hash, acknowledged: false };
  const first = await engine.approve(reference);
  const claimed = await store.claimRun({ runId: first.run.id, workerId: 'store-engine-test', leaseSeconds: 60 });
  const fence = { runId: first.run.id, leaseToken: claimed.lease.token, generation: claimed.lease.generation };
  for (const kind of ['calendar', 'sheets']) {
    await store.checkpointStep({ ...fence, kind, patch: { status: 'running', attempts: 1, summary: 'Updating selected record.', startedAt: new Date(currentTime).toISOString() }, runPatch: { status: 'running' } });
    await store.checkpointStep({ ...fence, kind, patch: { status: 'verified', summary: 'Read back and verified.', verification: { start: plan.snapshot.target.start, end: plan.snapshot.target.end }, finishedAt: new Date(currentTime).toISOString() }, runPatch: {} });
  }
  await store.checkpointStep({ ...fence, kind: null, patch: {}, runPatch: { status: 'verified', completedAt: new Date(currentTime).toISOString() }, eventPatch: { start: plan.snapshot.target.start, end: plan.snapshot.target.end, version: linked.version + 1 } });
  await store.releaseRun(fence);
  assert.equal((await store.getPlan(plan.id)).superseded, true, 'Completing the real store run clears its latest-plan pointer');
  const repeated = await engine.approve(reference);
  assert.equal(repeated.run.id, first.run.id);
  assert.equal(repeated.run.status, 'verified');
  assert.equal((await store.listRuns()).length, 1);
  assert.equal(providerCalls, 0);
});
