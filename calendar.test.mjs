import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarUpdate, createCalendarAdapter, snapshotCalendarEvent, CalendarConflictError, CalendarSetupError } from './integrations/calendar.mjs';

const event = (overrides = {}) => ({
  id: 'chosen-event', etag: 'source-v1', summary: 'Workshop', description: 'Confirmed details', location: 'Room A',
  start: { dateTime: '2027-01-01T14:00:00+05:30', timeZone: 'Asia/Kolkata' },
  end: { dateTime: '2027-01-01T15:30:00+05:30', timeZone: 'Asia/Kolkata' },
  attendees: [{ email: 'fictional@example.com' }], ...overrides,
});
const proposal = source => ({ calendarId: 'chosen-calendar', eventId: source.id, start: '2027-01-01T21:00:00Z', expected: snapshotCalendarEvent(source) });

function fakeSDK({ before = event(), after, updateError = false, connections, flows } = {}) {
  let writes = 0;
  const calls = [];
  const user = {
    listConnections: async () => connections ?? [{ id: 'opaque-auth', service_id: 'resolved-calendar-service', isExpired: false }],
    findEnabled: async () => 'opaque-script',
    listFlows: async () => flows ?? [{ id: 'opaque-script', serviceId: 'resolved-calendar-service', authId: 'opaque-auth', status: 'active' }],
    enable: async () => { throw Error('Existing connection must not be enabled again'); },
    listOptions: async (version, parameters) => { calls.push({ version, parameters }); return { options: [{ label: 'Chosen calendar', value: 'chosen-calendar' }] }; },
  };
  const sdk = {
    user: id => { assert.equal(id, 'product-user'); return user; },
    catalog: { serviceIdFor: async slug => { assert.equal(slug, 'google-calendar'); return 'resolved-calendar-service'; }, versionIdFor: async (_service, action, version) => { calls.push({ action, version }); return action; } },
    runAction: async (_script, action, input) => {
      calls.push({ action, input });
      if (action === 'rowf3g5zquop') {
        if (writes && after === 'unavailable') throw Error('read failed');
        return structuredClone(writes ? (after ?? before) : before);
      }
      if (action === 'rowo9a3brirh') { writes++; if (updateError) throw Error('timed out'); return { success: true }; }
      if (action === 'rowk78n47s6v') return { events: [before] };
      if (action === 'rowpr775r260') return { items: [{ id: 'chosen-calendar' }] };
      throw Error('Unexpected action');
    },
  };
  return { adapter: createCalendarAdapter({ viasocket: sdk, userId: 'product-user', authId: 'opaque-auth' }), calls, writes: () => writes };
}

test('Calendar update uses event timezone across a UTC date rollover and preserves 90-minute duration', () => {
  const source = event();
  const update = buildCalendarUpdate(source, proposal(source));
  assert.deepEqual(update.inputData, { calendar_id: 'chosen-calendar', eventId: 'chosen-event', timeZone: 'Asia/Kolkata', startdate: '02-01-2027', starttime: '02:30', meeting_duration: '01:30', sendUpdates: 'none' });
  assert.equal(update.target.end, '2027-01-01T22:30:00.000Z');
});

test('Calendar update respects a DST timezone and preserves elapsed duration', () => {
  const source = event({ start: { dateTime: '2027-03-13T14:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2027-03-13T15:30:00-05:00', timeZone: 'America/New_York' } });
  const update = buildCalendarUpdate(source, { ...proposal(source), start: '2027-03-14T14:00:00Z' });
  assert.equal(update.inputData.starttime, '10:00');
  assert.equal(update.inputData.startdate, '14-03-2027');
  assert.equal(update.inputData.meeting_duration, '01:30');
});

test('Rejects sub-minute times, invalid dates, all-day events and recurring instances', () => {
  const source = event();
  assert.throws(() => buildCalendarUpdate(source, { ...proposal(source), start: '2027-02-30T10:00:00Z' }), /valid date/);
  assert.throws(() => buildCalendarUpdate(source, { ...proposal(source), start: '2027-01-01T10:00:01Z' }), /whole-minute/);
  assert.throws(() => buildCalendarUpdate(source, { ...proposal(source), start: '2027-01-01T10:00:00.001Z' }), /whole-minute/);
  assert.throws(() => snapshotCalendarEvent(event({ start: { date: '2027-01-01' } })), /All-day/);
  assert.throws(() => snapshotCalendarEvent(event({ recurrence: ['RRULE:FREQ=DAILY'] })), /Recurring/);
  assert.throws(() => snapshotCalendarEvent(event({ recurringEventId: 'series' })), /Recurring/);
});

test('A stale source etag or schedule blocks the write', async () => {
  const source = event();
  const fake = fakeSDK();
  await assert.rejects(fake.adapter.reschedule({ ...proposal(source), expected: { ...snapshotCalendarEvent(source), etag: 'older' } }), CalendarConflictError);
  assert.equal(fake.writes(), 0);
  assert.throws(() => buildCalendarUpdate(source, { ...proposal(source), expected: { ...snapshotCalendarEvent(source), start: '2027-01-01T07:00:00Z' } }), CalendarConflictError);
});

test('A disconnected, expired or mismatched flow never executes an action', async () => {
  for (const options of [
    { connections: [] },
    { connections: [{ id: 'opaque-auth', service_id: 'resolved-calendar-service', isExpired: true }] },
    { flows: [{ id: 'opaque-script', serviceId: 'resolved-calendar-service', authId: 'some-other-account', status: 'active' }] },
    { flows: [{ id: 'opaque-script', serviceId: 'resolved-calendar-service', authId: 'opaque-auth', status: 'paused' }] },
  ]) {
    const fake = fakeSDK(options);
    await assert.rejects(fake.adapter.readEvent({ calendarId: 'chosen-calendar', eventId: 'chosen-event' }), CalendarSetupError);
    assert.equal(fake.calls.filter(call => call.input).length, 0);
  }
});

test('A provider success response is not verification when readback differs', async () => {
  const source = event();
  const fake = fakeSDK({ after: source });
  const result = await fake.adapter.reschedule(proposal(source));
  assert.equal(result.status, 'needs-checking');
  assert.equal(fake.writes(), 1);
});

test('A matching readback verifies and an uncertain update can be reconciled without resending', async () => {
  const source = event();
  const after = event({ etag: 'source-v2', start: { dateTime: '2027-01-02T02:30:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2027-01-02T04:00:00+05:30', timeZone: 'Asia/Kolkata' } });
  const fake = fakeSDK({ after, updateError: true });
  const result = await fake.adapter.reschedule(proposal(source));
  assert.equal(result.status, 'verified');
  assert.equal(result.reconciledAfterUncertainUpdate, true);
  assert.equal(fake.writes(), 1);
  assert.equal('authId' in result, false);
  assert.equal('scriptId' in result, false);
});

test('Failed verification returns needs-checking and does not blindly retry', async () => {
  const source = event();
  const fake = fakeSDK({ after: 'unavailable' });
  assert.equal((await fake.adapter.reschedule(proposal(source))).status, 'needs-checking');
  assert.equal(fake.writes(), 1);
});

test('An unexpected title or recipient change cannot appear as verified', async () => {
  const source = event();
  const after = event({ etag: 'source-v2', summary: 'Changed by another organiser', start: { dateTime: '2027-01-02T02:30:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2027-01-02T04:00:00+05:30', timeZone: 'Asia/Kolkata' } });
  assert.equal((await fakeSDK({ after }).adapter.reschedule(proposal(source))).status, 'needs-checking');
});

test('Picker calls use exact documented fields and do not expose credential results', async () => {
  const fake = fakeSDK();
  const state = await fake.adapter.connection();
  assert.deepEqual(state, { connected: true, app: 'Google Calendar', expired: false });
  await fake.adapter.calendarOptions();
  await fake.adapter.eventOptions({ calendarId: 'chosen-calendar', search: 'Workshop' });
  const pickers = fake.calls.filter(call => call.parameters);
  assert.deepEqual(pickers.map(call => call.parameters.fieldKey), ['calendarId', 'eventId']);
  assert.deepEqual(pickers[1].parameters.existingFields, { calendar_id: 'chosen-calendar', _searchText: 'Workshop' });
});
