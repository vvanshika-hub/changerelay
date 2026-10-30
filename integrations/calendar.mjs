/** Server-only Calendar actions. Never return connection or execution credentials to a browser. */
const ACTIONS = Object.freeze({
  calendars: ['rowpr775r260', 'V5'],
  events: ['rowk78n47s6v', 'V12'],
  read: ['rowf3g5zquop', 'V7'],
  update: ['rowo9a3brirh', 'V14'],
});

export class CalendarSetupError extends Error {
  constructor(message = 'Connect your Google Calendar account before continuing.') {
    super(message); this.name = 'CalendarSetupError'; this.code = 'CALENDAR_SETUP_REQUIRED';
  }
}
export class CalendarInputError extends Error {
  constructor(message) { super(message); this.name = 'CalendarInputError'; this.code = 'INVALID_CALENDAR_CHANGE'; }
}
export class CalendarConflictError extends Error {
  constructor() {
    super('This Calendar event changed after your preview. Refresh and review the change again.');
    this.name = 'CalendarConflictError'; this.code = 'CALENDAR_SOURCE_CHANGED';
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new CalendarInputError(`Choose a valid ${label}.`);
  }
  return value;
}

function instant(value, label) {
  requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new CalendarInputError(`${label} must include an exact date, time and UTC offset.`);
  const [, year, month, day, hour, minute, second, fraction = '', offset] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, se] = parts;
  const validDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const offsetParts = offset === 'Z' ? [0, 0] : offset.slice(1).split(':').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > validDay || h > 23 || mi > 59 || se > 59 ||
      offsetParts[0] > 23 || offsetParts[1] > 59) {
    throw new CalendarInputError(`${label} is not a valid date and time.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new CalendarInputError(`${label} is not a valid date and time.`);
  if (se !== 0 || /[1-9]/.test(fraction)) {
    throw new CalendarInputError('This Calendar connection supports whole-minute schedules only. Choose an event and start time without seconds.');
  }
  return ms;
}

function zoneName(timeZone) {
  requiredString(timeZone, 'event timezone');
  try { return new Intl.DateTimeFormat('en-GB', { timeZone }).resolvedOptions().timeZone; }
  catch { throw new CalendarInputError('Confirm a valid IANA timezone for this event.'); }
}

function assertOneOff(event) {
  if (!event || typeof event !== 'object' || !event.id || !event.start || !event.end) {
    throw new CalendarInputError('The connected Calendar did not return a complete event.');
  }
  if (event.start.date || event.end.date || !event.start.dateTime || !event.end.dateTime) {
    throw new CalendarInputError('All-day events cannot be rescheduled with this workflow. Choose a timed event.');
  }
  if ((Array.isArray(event.recurrence) && event.recurrence.length) || event.recurringEventId || event.originalStartTime) {
    throw new CalendarInputError('Recurring events cannot be rescheduled with this workflow. Choose a one-off event.');
  }
  if (event.status === 'cancelled') throw new CalendarInputError('This event is cancelled. Choose an active event.');
}

export function snapshotCalendarEvent(event, linkedTimeZone) {
  assertOneOff(event);
  const start = instant(event.start.dateTime, 'Current start');
  const end = instant(event.end.dateTime, 'Current end');
  if (end <= start || (end - start) % 60000) throw new CalendarInputError('The event must have a positive whole-minute duration.');
  const timeZone = event.start.timeZone || event.end.timeZone || linkedTimeZone;
  zoneName(timeZone);
  if (typeof event.etag !== 'string' || !event.etag) {
    throw new CalendarInputError('The connected Calendar did not return a source version. Refresh the event before approving.');
  }
  return { eventId: event.id, etag: event.etag, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone };
}

export function buildCalendarUpdate(event, { calendarId, eventId, start, expected, timeZone }) {
  requiredString(calendarId, 'linked calendar'); requiredString(eventId, 'linked event');
  const source = snapshotCalendarEvent(event, timeZone);
  if (!expected || typeof expected !== 'object') throw new CalendarInputError('Review and save a proposal before updating the Calendar.');
  const expectedStart = instant(expected.start, 'Reviewed start');
  const expectedEnd = instant(expected.end, 'Reviewed end');
  if (event.id !== eventId || expected.etag !== source.etag || expectedStart !== Date.parse(source.start) ||
      expectedEnd !== Date.parse(source.end) || (expected.timeZone && zoneName(expected.timeZone) !== zoneName(source.timeZone))) {
    throw new CalendarConflictError();
  }
  const proposedStart = instant(start, 'Proposed start');
  const durationMinutes = (Date.parse(source.end) - Date.parse(source.start)) / 60000;
  // HH:MM is the provider's documented duration format; no silent rounding of seconds.
  if (durationMinutes >= 100 * 60) throw new CalendarInputError('This event exceeds the supported Calendar duration.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: source.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(proposedStart)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    inputData: {
      calendar_id: calendarId, eventId, timeZone: source.timeZone,
      startdate: `${parts.day}-${parts.month}-${parts.year}`, starttime: `${parts.hour}:${parts.minute}`,
      meeting_duration: `${String(Math.floor(durationMinutes / 60)).padStart(2, '0')}:${String(durationMinutes % 60).padStart(2, '0')}`,
      // Disclosed in the approval plan: custom announcements are a separate, approved step.
      sendUpdates: 'none',
    },
    source,
    target: { start: new Date(proposedStart).toISOString(), end: new Date(proposedStart + durationMinutes * 60000).toISOString(), timeZone: source.timeZone },
  };
}

function preservedDetails(event) {
  return {
    summary: event.summary ?? '', description: event.description ?? '', location: event.location ?? '',
    attendeeEmails: (event.attendees || []).map(person => person.email).filter(Boolean).sort(),
  };
}

function readbackMatches(event, target, eventId, before) {
  try {
    const actual = snapshotCalendarEvent(event, target.timeZone);
    return actual.eventId === eventId && actual.start === target.start && actual.end === target.end &&
      zoneName(actual.timeZone) === zoneName(target.timeZone) &&
      JSON.stringify(preservedDetails(event)) === JSON.stringify(preservedDetails(before));
  } catch { return false; }
}

/**
 * The caller must obtain userId from its authenticated session, and authId from its server-side
 * connection record. Calendar/event IDs are explicit saved choices from account pickers.
 */
export function createCalendarAdapter({ viasocket, userId, authId } = {}) {
  if (!viasocket || typeof viasocket.user !== 'function' || !viasocket.catalog ||
      typeof userId !== 'string' || !userId.trim() || typeof authId !== 'string' || !authId.trim()) {
    throw new CalendarSetupError();
  }
  const user = viasocket.user(userId);
  let servicePromise;
  const serviceId = () => servicePromise ??= viasocket.catalog.serviceIdFor('google-calendar').catch(error => { servicePromise = undefined; throw error; });
  const version = async key => viasocket.catalog.versionIdFor(await serviceId(), ...ACTIONS[key]);

  async function ownedConnection() {
    const service = await serviceId();
    const connections = await user.listConnections();
    const connection = Array.isArray(connections) && connections.find(item => item && item.id === authId && item.service_id === service);
    if (!connection) throw new CalendarSetupError('Reconnect the Google Calendar account linked to this workspace.');
    if (connection.isExpired === true) throw new CalendarSetupError('Your Google Calendar connection expired. Reconnect it before continuing.');
    return connection;
  }

  async function executionId() {
    await ownedConnection();
    const service = await serviceId();
    // findEnabled prevents duplicate runnable flows. Confirm its connection before using the credential.
    const existing = await user.findEnabled(service);
    if (existing) {
      const flows = await user.listFlows();
      const flow = flows.find(item => item.id === existing && item.serviceId === service && item.authId === authId && item.status !== 'deleted');
      if (!flow) throw new CalendarSetupError('The enabled Calendar account differs from this event’s saved connection. Reconnect the selected account.');
      if (flow.status === 'paused') throw new CalendarSetupError('This Calendar connection is paused. Resume it in connection settings before continuing.');
      return existing;
    }
    const enabled = await user.enable(service, authId);
    if (!enabled || !enabled.scriptId || enabled.authId !== authId || enabled.serviceId !== service) {
      throw new CalendarSetupError('The Calendar connection could not be enabled for this workspace.');
    }
    return enabled.scriptId;
  }

  async function run(key, inputData) {
    const script = await executionId();
    return viasocket.runAction(script, await version(key), inputData);
  }

  async function readEvent({ calendarId, eventId }) {
    requiredString(calendarId, 'linked calendar'); requiredString(eventId, 'linked event');
    const event = await run('read', { calendarId, eventId });
    if (!event || event.id !== eventId) throw new CalendarInputError('The linked event was not returned by Calendar. Review its mapping.');
    return event;
  }

  return Object.freeze({
    async connection() { await ownedConnection(); return { connected: true, app: 'Google Calendar', expired: false }; },
    async listCalendars({ pageToken } = {}) {
      if (pageToken !== undefined) requiredString(pageToken, 'calendar page');
      return run('calendars', { maxResults: 250, minAccessRole: 'writer', showDeleted: false, showHidden: false, ...(pageToken ? { pageToken } : {}) });
    },
    async calendarOptions() {
      await ownedConnection();
      return user.listOptions(await version('read'), { authId, fieldKey: 'calendarId', existingFields: {} });
    },
    async eventOptions({ calendarId, search = '' }) {
      requiredString(calendarId, 'linked calendar');
      if (typeof search !== 'string' || search.length > 256) throw new CalendarInputError('Use a shorter event search.');
      await ownedConnection();
      return user.listOptions(await version('update'), { authId, fieldKey: 'eventId', existingFields: { calendar_id: calendarId, ...(search ? { _searchText: search } : {}) } });
    },
    async listEvents({ calendarId, relativeDays = 90, search = '' }) {
      requiredString(calendarId, 'linked calendar');
      if (!Number.isInteger(relativeDays) || relativeDays < 1 || relativeDays > 366) throw new CalendarInputError('Choose an event window of 1–366 days.');
      if (typeof search !== 'string' || search.length > 256) throw new CalendarInputError('Use a shorter event search.');
      const result = await run('events', { calendarId, date_mode: 'relative', relative_days: relativeDays, show_deleted: false, show_hidden_invitations: false, maxResults: 250, ...(search ? { search_query: search } : {}) });
      if (!result || !Array.isArray(result.events)) throw new CalendarInputError('Calendar did not return a readable event list.');
      return result;
    },
    readEvent,
    async reschedule(input) {
      if (!input || typeof input !== 'object') throw new CalendarInputError('Review a valid Calendar proposal first.');
      const before = await readEvent(input);
      const change = buildCalendarUpdate(before, input);
      let updateUncertain = false;
      try { await run('update', change.inputData); }
      catch { updateUncertain = true; }
      // An update timeout is uncertain, not proof of failure. Reconcile by reading the saved event.
      try {
        const after = await readEvent(input);
        if (readbackMatches(after, change.target, input.eventId, before)) {
          return { status: 'verified', target: change.target, event: after, reconciledAfterUncertainUpdate: updateUncertain, notifications: 'Calendar invitation updates suppressed; Gmail is a separate approved step.' };
        }
        return { status: 'needs-checking', target: change.target, event: after, reason: 'Calendar’s current values do not match the approved change. Refresh the sources before retrying.' };
      } catch {
        return { status: 'needs-checking', target: change.target, reason: 'The update may have reached Calendar, but its result could not be verified. Check the event before retrying.' };
      }
    },
  });
}
