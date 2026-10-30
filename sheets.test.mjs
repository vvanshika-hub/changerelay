import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsAdapter, snapshotSheetRow, SheetsConflictError, SheetsIncompleteError, SheetsSetupError } from './integrations/sheets.mjs';

const mapping = { eventId: 'event_id', title: 'title', start: 'start', end: 'end', timezone: 'timezone', location: 'location' };
const row = (extra = {}) => ({ _rowNumber: 2, event_id: 'stable-event', title: 'Workshop', start: '2027-01-01T14:00:00+05:30', end: '2027-01-01T15:00:00+05:30', timezone: 'Asia/Kolkata', location: 'Room A', ...extra });
const change = original => ({ spreadsheetId: 'picked-spreadsheet', sheetId: 'picked-tab', eventId: 'stable-event', mapping, expected: snapshotSheetRow(original, mapping), start: '2027-01-01T10:30:00.000Z', end: '2027-01-01T11:30:00.000Z' });

function fakeSDK({ original = row(), duplicate = false, missing = false, noWrite = false, updateError = false, verifyError = false, sorted = false, listRows, connections, flows } = {}) {
  let stored = structuredClone(original), writes = 0, lookups = 0;
  const calls = [];
  const user = {
    listConnections: async () => connections ?? [{ id: 'owned-auth', service_id: 'resolved-sheets', isExpired: false }],
    findEnabled: async () => 'owned-script',
    listFlows: async () => flows ?? [{ id: 'owned-script', serviceId: 'resolved-sheets', authId: 'owned-auth', status: 'active' }],
    enable: async () => { throw Error('Should not enable an existing flow again'); },
    listOptions: async (action, parameters) => { calls.push({ action, parameters }); return { options: parameters.fieldKey === 'column_name' ? [{ key: 'start', label: 'start', type: 'string' }, { key: 'end', label: 'end', type: 'string' }] : [{ value: 'start', label: 'start' }], offset: null }; },
  };
  const sdk = {
    user: id => { assert.equal(id, 'authenticated-owner'); return user; },
    catalog: { serviceIdFor: async slug => { assert.equal(slug, 'google-sheets'); return 'resolved-sheets'; }, versionIdFor: async (_service, action) => action },
    runAction: async (_script, action, input) => {
      calls.push({ action, input });
      if (action === 'rowetjd2kmog') {
        lookups++;
        if (verifyError && writes) throw Error('Unknown update result');
        if (missing) return [];
        if (sorted && lookups > 1) stored._rowNumber = 8;
        return duplicate ? [structuredClone(stored), structuredClone(stored)] : [structuredClone(stored)];
      }
      if (action === 'rowioybw3c8a') {
        assert.equal(input.row_number, stored._rowNumber, 'Row read should follow the stable-ID lookup, including after a sort');
        return structuredClone(stored);
      }
      if (action === 'row1qvdf0nuc') {
        writes++;
        assert.equal(input.record, stored._rowNumber, 'Write must use the freshly resolved row, not the original row number');
        if (!noWrite) Object.assign(stored, input.column_name);
        if (updateError) throw Error('Timed out after commit');
        return { data: { updated: true } };
      }
      if (action === 'rowlpijbo5k1') return listRows ?? [structuredClone(stored)];
      if (action === 'rowtc0ud5uci') return { spreadsheetId: 'picked-spreadsheet', totalSheets: 1, sheets: [{ properties: { sheetId: 123, title: 'Events' } }] };
      if (action === 'rowju3dxf5ss') return { hasfound: true, spreadsheets: [{ id: 'picked-spreadsheet', name: 'Chosen schedule' }], hasMorePages: false, fetchedCount: 1 };
      throw Error('Unexpected action');
    },
  };
  return { adapter: createSheetsAdapter({ viasocket: sdk, userId: 'authenticated-owner', authId: 'owned-auth' }), calls, writes: () => writes };
}

test('Stable-ID reschedule follows a row that moves after a sort and changes only approved RAW fields', async () => {
  const original = row();
  const fake = fakeSDK({ sorted: true });
  const result = await fake.adapter.updateSchedule(change(original));
  assert.equal(result.status, 'verified');
  assert.equal(result.row._rowNumber, 8);
  const write = fake.calls.find(call => call.action === 'row1qvdf0nuc');
  assert.deepEqual(write.input, { spreadsheet_Id: 'picked-spreadsheet', grid_Id: 'picked-tab', record: 8, column_key: true, valueInputOption: 'RAW', column_selected: ['start', 'end'], column_name: { start: change(original).start, end: change(original).end } });
  assert.equal(result.row.title, original.title);
  assert.equal(result.row.location, original.location);
});

test('Missing or duplicate stable IDs block the write', async () => {
  for (const options of [{ duplicate: true }, { missing: true }]) {
    const fake = fakeSDK(options);
    await assert.rejects(fake.adapter.updateSchedule(change(row())), SheetsConflictError);
    assert.equal(fake.writes(), 0);
  }
});

test('Any mapped source drift, including title and location, invalidates the reviewed snapshot', async () => {
  const original = row();
  for (const override of [{ start: '2027-01-01T13:00:00+05:30' }, { title: 'Changed title' }, { location: 'Room B' }]) {
    const fake = fakeSDK({ original: row(override) });
    await assert.rejects(fake.adapter.updateSchedule(change(original)), SheetsConflictError);
    assert.equal(fake.writes(), 0);
  }
});

test('A provider success response with old source values remains needs-checking', async () => {
  const fake = fakeSDK({ noWrite: true });
  const result = await fake.adapter.updateSchedule(change(row()));
  assert.equal(result.status, 'needs-checking');
  assert.equal(fake.writes(), 1);
});

test('A send timeout can reconcile through stable ID readback without repeating the write', async () => {
  const fake = fakeSDK({ updateError: true });
  const result = await fake.adapter.updateSchedule(change(row()));
  assert.equal(result.status, 'verified');
  assert.equal(result.reconciledAfterUncertainUpdate, true);
  assert.equal(fake.writes(), 1);
});

test('A verification failure never triggers a blind second update', async () => {
  const fake = fakeSDK({ verifyError: true });
  const result = await fake.adapter.updateSchedule(change(row()));
  assert.equal(result.status, 'needs-checking');
  assert.equal(fake.writes(), 1);
});

test('An already aligned row verifies an earlier uncertain result without any write', async () => {
  const input = change(row());
  const fake = fakeSDK({ original: row({ start: input.start, end: input.end }) });
  const result = await fake.adapter.updateSchedule(input);
  assert.equal(result.status, 'verified');
  assert.equal(result.alreadyAligned, true);
  assert.equal(fake.writes(), 0);
});

test('Read window reaching 100 rows is explicitly incomplete rather than silently truncated', async () => {
  const fake = fakeSDK({ listRows: Array.from({ length: 100 }, (_, index) => row({ _rowNumber: index + 2 })) });
  await assert.rejects(fake.adapter.listRows({ spreadsheetId: 'picked-spreadsheet', sheetId: 'picked-tab' }), SheetsIncompleteError);
});

test('Invalid dates, row numbers, mappings and missing reviewed values block changes', async () => {
  const fake = fakeSDK();
  await assert.rejects(fake.adapter.updateSchedule({ ...change(row()), start: '2027-02-30T10:00:00Z' }), /valid date/);
  await assert.rejects(fake.adapter.updateSchedule({ ...change(row()), expected: undefined }), /Review and save/);
  await assert.rejects(fake.adapter.readRow({ spreadsheetId: 'picked-spreadsheet', sheetId: 'picked-tab', rowNumber: 1 }), /valid linked data row/);
  assert.throws(() => snapshotSheetRow(row(), { ...mapping, end: 'start' }), /different spreadsheet column/);
  assert.equal(fake.writes(), 0);
});

test('Unowned, expired or paused connections cannot execute spreadsheet actions', async () => {
  for (const options of [
    { connections: [] },
    { connections: [{ id: 'owned-auth', service_id: 'resolved-sheets', isExpired: true }] },
    { flows: [{ id: 'owned-script', serviceId: 'resolved-sheets', authId: 'different-account', status: 'active' }] },
    { flows: [{ id: 'owned-script', serviceId: 'resolved-sheets', authId: 'owned-auth', status: 'paused' }] },
  ]) {
    const fake = fakeSDK(options);
    await assert.rejects(fake.adapter.listTabs({ spreadsheetId: 'picked-spreadsheet' }), SheetsSetupError);
    assert.equal(fake.calls.filter(call => call.input).length, 0);
  }
});

test('Picker dependencies and generated column field keys follow the real tested response', async () => {
  const fake = fakeSDK();
  const input = { spreadsheetId: 'picked-spreadsheet', sheetId: 'picked-tab', mapping };
  await fake.adapter.spreadsheetOptions({ search: 'Schedule' });
  await fake.adapter.sheetOptions(input);
  await fake.adapter.lookupColumnOptions(input);
  await fake.adapter.scheduleColumnOptions(input);
  const values = await fake.adapter.columnValueOptions(input);
  assert.deepEqual(values.options.map(option => option.key), ['start', 'end']);
  const pickers = fake.calls.filter(call => call.parameters).map(call => call.parameters);
  assert.deepEqual(pickers.map(parameters => parameters.fieldKey), ['spreadSheet_id', 'sheet_id', 'search_filter.lookupColumn', 'column_selected', 'column_name']);
  assert.deepEqual(pickers[2].existingFields, { spreadsheet_Id: 'picked-spreadsheet', sheet_Id: 'picked-tab', search_filter: { column_key: true } });
  assert.deepEqual(pickers[4].existingFields.column_selected, ['start', 'end']);
});

test('Roster is scoped to linked event and assignments keep explicit recorded times', async () => {
  const roster = fakeSDK({ listRows: [
    { event_id: 'stable-event', name: 'Fictional person', email: 'fictional@example.com', role: 'Participant' },
    { event_id: 'another-event', name: 'Other person', email: 'other@example.com', role: 'Participant' },
  ] });
  const people = await roster.adapter.listRoster({ spreadsheetId: 'picked-spreadsheet', sheetId: 'roster-tab', eventId: 'stable-event', mapping: { eventId: 'event_id', name: 'name', email: 'email', role: 'role' } });
  assert.equal(people.length, 1);
  assert.equal(people[0].email, 'fictional@example.com');
  const assignments = fakeSDK({ listRows: [{ person: 'Fictional volunteer', event_id: 'another-event', start: '2027-01-01T16:00:00+05:30', end: '2027-01-01T17:00:00+05:30' }] });
  assert.equal((await assignments.adapter.listAssignments({ spreadsheetId: 'picked-spreadsheet', sheetId: 'assignment-tab', mapping: { person: 'person', eventId: 'event_id', start: 'start', end: 'end' } }))[0].eventId, 'another-event');
});
