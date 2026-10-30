/** Server-only Google Sheets actions. Connections and runnable flow IDs never leave this module. */
const ACTIONS = Object.freeze({
  spreadsheets: ['rowju3dxf5ss', 'V3'], tabs: ['rowtc0ud5uci', 'V3'], rows: ['rowlpijbo5k1', 'V31'],
  lookup: ['rowetjd2kmog', 'V19'], update: ['row1qvdf0nuc', 'V26'], read: ['rowioybw3c8a', 'V3'],
});
const BUSINESS_FIELDS = Object.freeze(['eventId', 'title', 'start', 'end', 'timezone', 'location']);
const ROW_LIMIT = 100;

export class SheetsSetupError extends Error {
  constructor(message = 'Connect your Google Sheets account before continuing.') {
    super(message); this.name = 'SheetsSetupError'; this.code = 'SHEETS_SETUP_REQUIRED';
  }
}
export class SheetsInputError extends Error {
  constructor(message) { super(message); this.name = 'SheetsInputError'; this.code = 'INVALID_SHEET_CHANGE'; }
}
export class SheetsConflictError extends Error {
  constructor(message = 'This schedule row changed after your preview. Refresh and review the change again.') {
    super(message); this.name = 'SheetsConflictError'; this.code = 'SHEETS_SOURCE_CHANGED';
  }
}
export class SheetsIncompleteError extends Error {
  constructor() {
    super('This tab reached the checked 100-row limit. Its roster or assignments may be incomplete; choose a smaller event-specific tab before executing.');
    this.name = 'SheetsIncompleteError'; this.code = 'SHEETS_DATA_INCOMPLETE';
  }
}

function text(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 10000) throw new SheetsInputError(`Choose a valid ${label}.`);
  return value;
}
function column(value, label) {
  text(value, label);
  if (['__proto__', 'prototype', 'constructor'].includes(value)) throw new SheetsInputError(`Choose another ${label}.`);
  return value;
}
function instant(value, label) {
  text(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new SheetsInputError(`${label} must include an exact date, time and UTC offset.`);
  const [, year, month, day, hour, minute, second, , offset] = match;
  const [y, mo, d, h, mi, se] = [year, month, day, hour, minute, second].map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const offsetParts = offset === 'Z' ? [0, 0] : offset.slice(1).split(':').map(Number);
  const ms = Date.parse(value);
  if (mo < 1 || mo > 12 || d < 1 || d > lastDay || h > 23 || mi > 59 || se > 59 ||
      offsetParts[0] > 23 || offsetParts[1] > 59 || !Number.isFinite(ms)) throw new SheetsInputError(`${label} is not a valid date and time.`);
  return ms;
}
function timezone(value) {
  text(value, 'IANA event timezone');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(); }
  catch { throw new SheetsInputError('Confirm a valid IANA timezone for the schedule row.'); }
  return value;
}
function checkedMapping(mapping, fields) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new SheetsInputError('Confirm the column mappings before continuing.');
  const names = fields.map(field => column(mapping[field], `${field} column`));
  if (new Set(names).size !== names.length) throw new SheetsInputError('Map each field to a different spreadsheet column.');
  return mapping;
}
function cell(row, name, label, allowEmpty = false) {
  if (!row || typeof row !== 'object' || !Object.hasOwn(row, name)) throw new SheetsInputError(`The mapped ${label} column is missing from this row.`);
  return text(row[name], `${label} value`, { empty: allowEmpty });
}
function rowNumber(row) {
  if (!Number.isInteger(row?._rowNumber) || row._rowNumber < 2) throw new SheetsInputError('The connected spreadsheet did not return a usable data-row number.');
  return row._rowNumber;
}
function link(input) {
  text(input?.spreadsheetId, 'linked spreadsheet'); text(input?.sheetId, 'linked sheet tab');
  return input;
}
function expectedSnapshot(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new SheetsInputError('Review and save a schedule proposal before updating Sheets.');
  const result = Object.fromEntries(BUSINESS_FIELDS.map(field => [field, text(expected[field], `reviewed ${field}`, { empty: field === 'location' })]));
  if (instant(result.end, 'Reviewed end') <= instant(result.start, 'Reviewed start')) throw new SheetsInputError('The reviewed schedule must have a positive duration.');
  timezone(result.timezone);
  return result;
}

/** Exact mapped source values; row position is deliberately excluded so sorting does not stale a plan. */
export function snapshotSheetRow(row, mapping) {
  checkedMapping(mapping, BUSINESS_FIELDS);
  const result = Object.fromEntries(BUSINESS_FIELDS.map(field => [field, cell(row, mapping[field], field, field === 'location')]));
  if (instant(result.end, 'Current end') <= instant(result.start, 'Current start')) throw new SheetsInputError('The current schedule row must have a positive duration.');
  timezone(result.timezone);
  return result;
}
function sameSnapshot(left, right) {
  return BUSINESS_FIELDS.every(field => left[field] === right[field]);
}

/** Caller supplies authenticated owner identity and server-side connection reference, never browser credentials. */
export function createSheetsAdapter({ viasocket, userId, authId } = {}) {
  if (!viasocket || typeof viasocket.user !== 'function' || !viasocket.catalog ||
      typeof userId !== 'string' || !userId.trim() || typeof authId !== 'string' || !authId.trim()) throw new SheetsSetupError();
  const user = viasocket.user(userId);
  let servicePromise;
  const serviceId = () => servicePromise ??= viasocket.catalog.serviceIdFor('google-sheets').catch(error => { servicePromise = undefined; throw error; });
  const version = async action => viasocket.catalog.versionIdFor(await serviceId(), ...ACTIONS[action]);

  async function ownedConnection() {
    const service = await serviceId();
    const connections = await user.listConnections();
    const connection = Array.isArray(connections) && connections.find(item => item && item.id === authId && item.service_id === service);
    if (!connection) throw new SheetsSetupError('Reconnect the Google Sheets account linked to this workspace.');
    if (connection.isExpired === true) throw new SheetsSetupError('Your Google Sheets connection expired. Reconnect it before continuing.');
    return connection;
  }
  async function executionId() {
    await ownedConnection();
    const service = await serviceId();
    const existing = await user.findEnabled(service);
    if (existing) {
      const flows = await user.listFlows();
      const flow = flows.find(item => item.id === existing && item.authId === authId && item.serviceId === service && item.status !== 'deleted');
      if (!flow) throw new SheetsSetupError('The enabled spreadsheet account differs from the saved connection. Reconnect the selected account.');
      if (flow.status === 'paused') throw new SheetsSetupError('This spreadsheet connection is paused. Resume it in connection settings before continuing.');
      return existing;
    }
    const enabled = await user.enable(service, authId);
    if (!enabled?.scriptId || enabled.authId !== authId || enabled.serviceId !== service) throw new SheetsSetupError('The spreadsheet connection could not be enabled for this workspace.');
    return enabled.scriptId;
  }
  async function run(action, inputData) {
    return viasocket.runAction(await executionId(), await version(action), inputData);
  }
  async function options(action, fieldKey, existingFields) {
    await ownedConnection();
    return user.listOptions(await version(action), { authId, fieldKey, existingFields });
  }
  async function listRows(input) {
    link(input);
    const rows = await run('rows', {
      spreadSheet_id: input.spreadsheetId, sheet_id: input.sheetId, column_key: true,
      sorting_limit: { row_count: ROW_LIMIT, is_last_row: false, offset_row: 0 },
    });
    if (!Array.isArray(rows)) throw new SheetsInputError('The spreadsheet did not return a readable row list.');
    if (rows.length >= ROW_LIMIT) throw new SheetsIncompleteError();
    return rows;
  }
  async function readRow(input) {
    link(input);
    if (!Number.isInteger(input.rowNumber) || input.rowNumber < 2) throw new SheetsInputError('Choose a valid linked data row.');
    const row = await run('read', { spreadSheet_id: input.spreadsheetId, sheet_id: input.sheetId, column_key: true, row_number: input.rowNumber });
    rowNumber(row);
    return row;
  }
  async function lookupEvent(input) {
    link(input); text(input.eventId, 'stable event ID');
    checkedMapping(input.mapping, ['eventId']);
    const rows = await run('lookup', {
      spreadsheet_Id: input.spreadsheetId, sheet_Id: input.sheetId,
      search_filter: { column_key: true, type_search_filter: 'basic', lookupColumn: input.mapping.eventId, lookupValue: input.eventId },
      sorting: { row_count: 2, is_last_row: false },
    });
    if (!Array.isArray(rows)) throw new SheetsInputError('The spreadsheet did not return a readable event lookup.');
    if (!rows.length) throw new SheetsConflictError('The stable event ID is missing from this schedule tab. Review its mapping.');
    if (rows.length !== 1) throw new SheetsConflictError('This schedule contains duplicate event IDs. Resolve them before approving a change.');
    if (cell(rows[0], input.mapping.eventId, 'event ID') !== input.eventId) throw new SheetsConflictError('The spreadsheet lookup did not return the exact linked event ID. Review its mapping.');
    rowNumber(rows[0]);
    return rows[0];
  }

  return Object.freeze({
    async connection() { await ownedConnection(); return { connected: true, app: 'Google Sheets', expired: false }; },
    async listSpreadsheets({ search = '', pageToken } = {}) {
      text(search, 'spreadsheet search', { empty: true });
      if (pageToken !== undefined) text(pageToken, 'spreadsheet page');
      const result = await run('spreadsheets', {
        fetch_mode: search ? 'search' : 'all', ...(search ? { search_keyword: search } : {}),
        owner_filter: 'any', sort_by: 'name', sort_order: 'asc', max_results: ROW_LIMIT,
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      if (!result || !Array.isArray(result.spreadsheets)) throw new SheetsInputError('The account did not return a readable spreadsheet list.');
      return result;
    },
    async listTabs({ spreadsheetId }) {
      text(spreadsheetId, 'linked spreadsheet');
      const result = await run('tabs', { spreadSheet_id: spreadsheetId });
      if (!result || !Array.isArray(result.sheets)) throw new SheetsInputError('The spreadsheet did not return a readable tab list.');
      return result;
    },
    async spreadsheetOptions({ search = '' } = {}) {
      text(search, 'spreadsheet search', { empty: true });
      return options('tabs', 'spreadSheet_id', search ? { _searchText: search } : {});
    },
    async sheetOptions({ spreadsheetId }) {
      text(spreadsheetId, 'linked spreadsheet');
      return options('rows', 'sheet_id', { spreadSheet_id: spreadsheetId });
    },
    async lookupColumnOptions(input) {
      link(input);
      return options('lookup', 'search_filter.lookupColumn', { spreadsheet_Id: input.spreadsheetId, sheet_Id: input.sheetId, search_filter: { column_key: true } });
    },
    async scheduleColumnOptions(input) {
      link(input);
      return options('update', 'column_selected', { spreadsheet_Id: input.spreadsheetId, grid_Id: input.sheetId, column_key: true });
    },
    async columnValueOptions(input) {
      link(input); checkedMapping(input.mapping, ['start', 'end']);
      // The tested result uses entry.key (not entry.value) for these generated value fields.
      return options('update', 'column_name', { spreadsheet_Id: input.spreadsheetId, grid_Id: input.sheetId, column_key: true, column_selected: [input.mapping.start, input.mapping.end] });
    },
    listRows,
    lookupEvent,
    readRow,
    async listRoster(input) {
      link(input); text(input.eventId, 'stable event ID');
      checkedMapping(input.mapping, ['eventId', 'name', 'email', 'role']);
      const rows = await listRows(input);
      return rows.filter(row => cell(row, input.mapping.eventId, 'event ID') === input.eventId).map(row => {
        const email = cell(row, input.mapping.email, 'participant email');
        if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) throw new SheetsInputError('Correct an invalid email address in the linked roster before approving a notification.');
        return { name: cell(row, input.mapping.name, 'participant name'), email, role: cell(row, input.mapping.role, 'participant role') };
      });
    },
    async listAssignments(input) {
      link(input);
      checkedMapping(input.mapping, ['person', 'eventId', 'start', 'end']);
      const rows = await listRows(input);
      return rows.map(row => {
        const assignment = { name: cell(row, input.mapping.person, 'volunteer name'), eventId: cell(row, input.mapping.eventId, 'assignment event ID'), start: cell(row, input.mapping.start, 'assignment start'), end: cell(row, input.mapping.end, 'assignment end') };
        if (instant(assignment.end, 'Assignment end') <= instant(assignment.start, 'Assignment start')) throw new SheetsInputError('Correct an assignment with an invalid duration before checking conflicts.');
        return assignment;
      });
    },
    async updateSchedule(input) {
      link(input); text(input.eventId, 'stable event ID'); checkedMapping(input.mapping, BUSINESS_FIELDS);
      const expected = expectedSnapshot(input.expected);
      if (expected.eventId !== input.eventId) throw new SheetsConflictError('The reviewed row does not match the linked stable event ID.');
      const targetStart = instant(input.start, 'Proposed start');
      const targetEnd = instant(input.end, 'Proposed end');
      if (targetEnd <= targetStart) throw new SheetsInputError('The proposed end must follow the proposed start.');
      const target = { ...expected, start: input.start, end: input.end };
      const source = await lookupEvent(input);
      let before = snapshotSheetRow(source, input.mapping);
      // Reconcile an earlier uncertain write by its intended values; do not write the same change twice.
      if (sameSnapshot(before, target)) {
        const current = await readRow({ ...input, rowNumber: rowNumber(source) });
        if (!sameSnapshot(snapshotSheetRow(current, input.mapping), target)) throw new SheetsConflictError();
        return { status: 'verified', row: current, target, alreadyAligned: true };
      }
      if (!sameSnapshot(before, expected)) throw new SheetsConflictError();
      const current = await readRow({ ...input, rowNumber: rowNumber(source) });
      before = snapshotSheetRow(current, input.mapping);
      if (!sameSnapshot(before, expected)) throw new SheetsConflictError();
      // Locate the stable ID afresh after the read; sorting may have moved its row number.
      const latest = await lookupEvent(input);
      if (!sameSnapshot(snapshotSheetRow(latest, input.mapping), expected)) throw new SheetsConflictError();
      const rowAtWrite = await readRow({ ...input, rowNumber: rowNumber(latest) });
      if (!sameSnapshot(snapshotSheetRow(rowAtWrite, input.mapping), expected)) throw new SheetsConflictError();
      let updateUncertain = false;
      try {
        await run('update', {
          spreadsheet_Id: input.spreadsheetId, grid_Id: input.sheetId, record: rowNumber(latest), column_key: true,
          valueInputOption: 'RAW', column_selected: [input.mapping.start, input.mapping.end],
          column_name: Object.fromEntries([[input.mapping.start, input.start], [input.mapping.end, input.end]]),
        });
      } catch { updateUncertain = true; }
      try {
        const afterLookup = await lookupEvent(input);
        const after = await readRow({ ...input, rowNumber: rowNumber(afterLookup) });
        if (sameSnapshot(snapshotSheetRow(afterLookup, input.mapping), target) && sameSnapshot(snapshotSheetRow(after, input.mapping), target)) {
          return { status: 'verified', row: after, target, alreadyAligned: false, reconciledAfterUncertainUpdate: updateUncertain };
        }
        return { status: 'needs-checking', row: after, target, reason: 'The schedule row does not match the approved change. Refresh the sources before retrying.' };
      } catch {
        return { status: 'needs-checking', target, reason: 'The schedule update may have reached Sheets, but its result could not be verified. Check the stable event ID before retrying.' };
      }
    },
  });
}
