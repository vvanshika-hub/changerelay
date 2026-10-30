import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { snapshotCalendarEvent, buildCalendarUpdate } from './integrations/calendar.mjs';
import { snapshotSheetRow } from './integrations/sheets.mjs';

const UNFINISHED = new Set(['pending', 'running', 'failed', 'needs-checking']);
const REQUIRED_STORE = ['getEvent', 'getEventMapping', 'savePlan', 'getPlan', 'approvePlan', 'getRun', 'listRuns', 'claimRun', 'heartbeatRun', 'checkpointStep', 'releaseRun'];
export class LiveInputError extends Error {
  constructor(message) { super(message); this.name = 'LiveInputError'; this.code = 'INVALID_LIVE_CHANGE'; }
}
export class LiveConflictError extends Error {
  constructor(message = 'A source changed after this preview. Refresh the event and review a new plan.') { super(message); this.name = 'LiveConflictError'; this.code = 'LIVE_SOURCE_CHANGED'; }
}
export class LiveAccessError extends Error {
  constructor() { super('This event or change is not available in your workspace.'); this.name = 'LiveAccessError'; this.code = 'LIVE_ACCESS_DENIED'; }
}
export class LiveLeaseLostError extends Error {
  constructor() { super('Another worker owns this update. Refresh its saved status before taking further action.'); this.name = 'LiveLeaseLostError'; this.code = 'LIVE_LEASE_LOST'; }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const copy = value => structuredClone(value);
const same = (left, right) => canonical(left) === canonical(right);
const normalInstant = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const normalizedRole = role => String(role || '').toLowerCase();
function string(value, label, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new LiveInputError(`Choose a valid ${label}.`);
  return value;
}
function safeMail(value, label, allowSample = false) {
  string(value, label, 320);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) throw new LiveInputError(`Choose one ${label} from the linked account or roster.`);
  if (!allowSample && /@(?:example\.(?:com|org|net)|[^@]*\.(?:invalid|test|local|example))$/i.test(value)) throw new LiveInputError('Sample addresses cannot be selected in the live workspace.');
  return value;
}
function businessDetails(event) {
  return { title: event.summary ?? '', description: event.description ?? '', location: event.location ?? '', attendees: (event.attendees || []).map(person => person.email).filter(Boolean).sort() };
}
function calendarBefore(event, timezone) {
  const { etag, start, end, timeZone } = snapshotCalendarEvent(event, timezone);
  return { etag, start, end, timeZone };
}
function rosterHash(roster) { return hash([...roster].sort((a, b) => canonical(a).localeCompare(canonical(b)))); }
function assignmentsHash(assignments) { return hash([...assignments].sort((a, b) => canonical(a).localeCompare(canonical(b)))); }
function calendarTargetMatches(event, target, timezone, detailsHash) {
  try {
    const snapshot = snapshotCalendarEvent(event, timezone);
    return snapshot.start === target.start && snapshot.end === target.end && hash(businessDetails(event)) === detailsHash;
  } catch { return false; }
}
function sheetTarget(before, target) { return { ...before, start: target.start, end: target.end }; }
function sheetMatches(snapshot, expected) { return Object.keys(expected).every(key => snapshot[key] === expected[key]); }

/** The hash covers identity, versions, source fingerprints, exact recipients and message payloads. */
export function hashLivePlan(plan) {
  return hash({ id: plan.id, ownerId: plan.ownerId, workspaceId: plan.workspaceId, eventId: plan.eventId, version: plan.version, eventVersion: plan.eventVersion, mappingVersion: plan.mappingVersion, snapshot: plan.snapshot });
}

function conflictsFor({ event, mapping, calendarEvent, calendarEvents, assignments, roster, target, sheetBefore: sheet, now }) {
  const conflicts = [], unavailableChecks = ['Participant availability is not checked.', 'Calendars outside the selected connected calendar are not checked.'];
  if (normalInstant(sheet.start) !== normalInstant(calendarEvent.start.dateTime) || normalInstant(sheet.end) !== normalInstant(calendarEvent.end.dateTime)) {
    conflicts.push({ kind: 'source-disagreement', message: 'The linked Calendar event and schedule row currently disagree. Both will be aligned to the proposed schedule.' });
  }
  const start = Date.parse(target.start), end = Date.parse(target.end);
  for (const other of calendarEvents) {
    if (other.id === mapping.calendar.eventId || other.status === 'cancelled') continue;
    const otherStart = Date.parse(other.start?.dateTime), otherEnd = Date.parse(other.end?.dateTime);
    if (Number.isFinite(otherStart) && Number.isFinite(otherEnd) && otherStart < end && otherEnd > start) {
      conflicts.push({ kind: 'calendar-overlap', title: String(other.summary || 'Another connected event'), start: new Date(otherStart).toISOString(), end: new Date(otherEnd).toISOString() });
    }
  }
  const volunteers = new Set(roster.filter(person => normalizedRole(person.role) === 'volunteer').map(person => person.name));
  for (const assignment of assignments) {
    if (assignment.eventId !== mapping.schedule.eventId && volunteers.has(assignment.name) && Date.parse(assignment.start) < end && Date.parse(assignment.end) > start) {
      conflicts.push({ kind: 'volunteer-overlap', name: assignment.name, event: assignment.eventId, start: assignment.start, end: assignment.end });
    }
  }
  if (!mapping.assignments) unavailableChecks.push('No volunteer assignment tab is linked.');
  else unavailableChecks.push('Volunteer assignment times are shown for coordination; this change updates the event schedule row only.');
  const distance = (Date.parse(target.start) - now) / 86400000;
  if (distance < 0 || distance > 90 || calendarEvents.length >= 250) unavailableChecks.push('The connected-calendar check is limited to its returned 90-day, 250-event window.');
  return { conflicts, unavailableChecks };
}

/**
 * Pure Node orchestration for a durable scheduler. No unawaited background jobs are created.
 * The owner-scoped store must implement atomic immutable plans/approvals and fenced event leases.
 * Provider APIs do not support fencing tokens; lease checks bracket calls, schedule writes are
 * reconciled by intended values, and Gmail uses its independent atomic durable send claim.
 */
export function createLiveEngine({ ownerId, store, adaptersFor, now = () => Date.now(), uuid = randomUUID, leaseSeconds = 60 } = {}) {
  string(ownerId, 'signed-in owner', 256);
  if (!store || REQUIRED_STORE.some(method => typeof store[method] !== 'function') || typeof adaptersFor !== 'function') throw new LiveInputError('Durable live-workspace storage and integration adapters are required.');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) throw new LiveInputError('Choose a worker lease between 15 and 300 seconds.');
  const timestamp = () => new Date(now()).toISOString();
  const own = record => { if (!record || record.ownerId !== ownerId) throw new LiveAccessError(); return record; };
  const readEvent = async id => own(await store.getEvent(string(id, 'linked event', 256)));
  async function mappingFor(event) {
    const mapping = await store.getEventMapping(event.id);
    if (!mapping || (mapping.ownerId && mapping.ownerId !== ownerId) || !Number.isInteger(mapping.version) || mapping.version < 1 || !mapping.calendar || !mapping.schedule) throw new LiveInputError('Confirm the event’s Calendar and spreadsheet mappings first.');
    return mapping;
  }
  function checkedPlan(plan, { allowSuperseded = false } = {}) {
    own(plan);
    if (plan.hash !== hashLivePlan(plan)) throw new LiveConflictError('The saved proposal failed its integrity check. Create a fresh review.');
    if (plan.superseded && !allowSuperseded) throw new LiveConflictError('This proposal was edited. Review and approve its newest version.');
    return plan;
  }
  async function contextFor(event, mapping, plan, run, fence = null) {
    const loadApproval = async reference => {
      if (!run || !plan || reference.userId !== ownerId || reference.version !== plan.version || reference.hash !== plan.hash) return null;
      const notification = plan.snapshot.notifications.find(item => item.id === reference.id);
      if (!notification || run.approval?.hash !== plan.hash || run.approval?.version !== plan.version) return null;
      return { ...copy(notification), userId: ownerId, version: plan.version, hash: plan.hash, approvedAt: run.approval.approvedAt };
    };
    const adapters = await adaptersFor({ ownerId, event: copy(event), mapping: copy(mapping), plan: plan ? copy(plan) : null, run: run ? copy(run) : null, fence: fence ? copy(fence) : null, loadApproval });
    if (!adapters?.calendar || !adapters?.sheets) throw new LiveInputError('Connect Calendar and Sheets before planning a live change.');
    return adapters;
  }
  async function sourceData(adapters, mapping) {
    const [calendar, sheet, roster, assignments, calendarList] = await Promise.all([
      adapters.calendar.readEvent(mapping.calendar), adapters.sheets.lookupEvent(mapping.schedule),
      mapping.roster ? adapters.sheets.listRoster({ ...mapping.roster, eventId: mapping.schedule.eventId }) : [],
      mapping.assignments ? adapters.sheets.listAssignments(mapping.assignments) : [],
      adapters.calendar.listEvents({ calendarId: mapping.calendar.calendarId, relativeDays: 90 }),
    ]);
    if (!Array.isArray(calendarList?.events)) throw new LiveInputError('The connected Calendar could not provide a conflict-check event list.');
    return { calendar, sheet, roster, assignments, calendarEvents: calendarList.events };
  }

  return Object.freeze({
    async prepare(input) {
      if (!input || typeof input !== 'object') throw new LiveInputError('Choose an event and proposed start time.');
      const event = await readEvent(input.eventId), mapping = await mappingFor(event);
      const runs = await store.listRuns();
      if (runs.some(run => run.ownerId === ownerId && run.eventId === event.id && UNFINISHED.has(run.status))) throw new LiveConflictError('Finish or recover this event’s existing update before preparing another change.');
      if (!Number.isInteger(event.version) || event.version < 1) throw new LiveInputError('Refresh the event’s current saved version.');
      if (typeof input.notify !== 'boolean') throw new LiveInputError('Choose whether to send an announcement.');
      const adapters = await contextFor(event, mapping);
      const sources = await sourceData(adapters, mapping);
      const before = calendarBefore(sources.calendar, event.timezone);
      const update = buildCalendarUpdate(sources.calendar, { ...mapping.calendar, start: input.start, expected: before, timeZone: event.timezone });
      if (Date.parse(update.target.start) <= now()) throw new LiveInputError('Choose a future date and time.');
      const sheetBefore = snapshotSheetRow(sources.sheet, mapping.schedule.mapping);
      if (sheetBefore.eventId !== mapping.schedule.eventId) throw new LiveConflictError('The schedule row does not match its linked event ID.');
      if (!Array.isArray(input.recipients)) throw new LiveInputError('Choose recipients explicitly from the linked roster.');
      const chosen = new Set(input.recipients.map(email => safeMail(email, 'recipient', !input.notify).toLowerCase()));
      const rosterByEmail = new Map();
      for (const person of sources.roster) {
        const email = safeMail(person.email, 'linked participant email', true);
        if (rosterByEmail.has(email.toLowerCase())) throw new LiveInputError('Resolve duplicate email addresses in the linked roster before reviewing this change.');
        rosterByEmail.set(email.toLowerCase(), person);
      }
      if ([...chosen].some(email => !rosterByEmail.has(email))) throw new LiveInputError('Choose recipients only from this event’s linked roster.');
      if (input.notify && (!mapping.roster || !chosen.size)) throw new LiveInputError('Link a roster and choose at least one recipient before preparing an announcement.');
      let from = null, subject = null, body = null;
      if (input.notify) {
        from = safeMail(input.from, 'sender');
        subject = string(input.subject, 'announcement subject', 800);
        body = string(input.messageBody, 'announcement message');
        if (/[\r\n\x00-\x1f]/.test(subject) || /<\/?[a-z][^>]*>/i.test(body)) throw new LiveInputError('Review a plain-text announcement with a single-line subject.');
        if (!adapters.gmail) throw new LiveInputError('Connect Gmail before preparing a live announcement.');
        const senders = await adapters.gmail.senderOptions();
        if (!senders.options?.some(option => typeof option.value === 'string' && option.value.toLowerCase() === from.toLowerCase())) throw new LiveInputError('Choose the sender from the connected Gmail account.');
      }
      const id = uuid(), version = 1;
      const notifications = input.notify ? [...chosen].map((email, index) => {
        const receiptMarker = 'CR-' + uuid();
        return { id: `${id}:${index}`, recipient: rosterByEmail.get(email).email, from, subject: `${subject} [${receiptMarker}]`, messageBody: body, receiptMarker };
      }) : [];
      const impact = conflictsFor({ event, mapping, calendarEvent: sources.calendar, calendarEvents: sources.calendarEvents, assignments: sources.assignments, roster: sources.roster, target: update.target, sheetBefore, now: now() });
      const snapshot = {
        title: sources.calendar.summary || event.title, timezone: before.timeZone, calendarBefore: before, calendarDetailsHash: hash(businessDetails(sources.calendar)),
        sheetBefore, target: update.target, notify: input.notify, notifications,
        recipients: [...chosen].map(email => ({ name: rosterByEmail.get(email).name, email: rosterByEmail.get(email).email, role: rosterByEmail.get(email).role })),
        rosterHash: rosterHash(sources.roster), assignmentsHash: assignmentsHash(sources.assignments),
        conflicts: impact.conflicts, unavailableChecks: impact.unavailableChecks,
        calendarConflictsHash: hash(impact.conflicts.filter(conflict => conflict.kind === 'calendar-overlap').sort((a, b) => canonical(a).localeCompare(canonical(b)))),
        calendarInvitationUpdates: 'none',
      };
      const plan = { id, ownerId, workspaceId: event.workspaceId, eventId: event.id, version, eventVersion: event.version, mappingVersion: mapping.version, snapshot, createdAt: timestamp() };
      plan.hash = hashLivePlan(plan);
      const saved = await store.savePlan(copy(plan));
      return copy(checkedPlan(saved || plan));
    },

    async approve({ planId, version, hash: reviewedHash, acknowledged = false }) {
      const plan = checkedPlan(await store.getPlan(string(planId, 'saved proposal', 256)), { allowSuperseded: true });
      if (plan.version !== version || plan.hash !== reviewedHash) throw new LiveConflictError('This approval does not match the exact saved proposal version.');
      // A repeated POST refers to the same immutable approval, even after completion cleared the
      // event's latest-plan pointer. Return its receipt before freshness checks or any provider reads.
      const existing = (await store.listRuns()).filter(run => run.ownerId === ownerId && run.planId === plan.id);
      if (existing.length) {
        if (existing.length !== 1 || existing[0].planVersion !== version || existing[0].planHash !== reviewedHash ||
            existing[0].approval?.version !== version || existing[0].approval?.hash !== reviewedHash) {
          throw new LiveConflictError('The existing execution does not match this exact approval.');
        }
        return { approval: copy(existing[0].approval), run: copy(existing[0]) };
      }
      if (plan.superseded) throw new LiveConflictError('This proposal was edited. Review and approve its newest version.');
      if (plan.snapshot.conflicts.length && acknowledged !== true) throw new LiveInputError('Review and acknowledge the known conflicts before approving.');
      const event = await readEvent(plan.eventId), mapping = await mappingFor(event);
      if (event.version !== plan.eventVersion || mapping.version !== plan.mappingVersion || (event.latestPlanId && event.latestPlanId !== plan.id)) throw new LiveConflictError();
      const approvedAt = timestamp(), approvalId = uuid();
      const run = {
        id: uuid(), ownerId, workspaceId: plan.workspaceId, eventId: plan.eventId, planId: plan.id, planVersion: plan.version, planHash: plan.hash,
        approval: { id: approvalId, approvedAt, version: plan.version, hash: plan.hash, acknowledged: acknowledged === true },
        status: 'pending',
        steps: ['calendar', 'sheets', 'gmail'].map((kind, index) => ({ kind, ordinal: index + 1, required: kind !== 'gmail' || plan.snapshot.notify, status: kind === 'gmail' && !plan.snapshot.notify ? 'skipped' : 'pending', attempts: 0, summary: kind === 'gmail' && !plan.snapshot.notify ? 'Announcement excluded from the approved plan.' : 'Waiting to run.', verification: null })),
        createdAt: approvedAt, updatedAt: approvedAt, lastError: null,
      };
      return store.approvePlan({ planId: plan.id, version, hash: reviewedHash, acknowledged: acknowledged === true, approvedAt, approvalId, run });
    },

    async run(runId) { return copy(own(await store.getRun(string(runId, 'saved execution', 256)))); },

    async execute({ runId, workerId = uuid(), retry = false }) {
      let run = own(await store.getRun(string(runId, 'saved execution', 256)));
      if (run.status === 'verified' || run.status === 'cancelled') return copy(run);
      if ((run.status === 'failed' || run.status === 'needs-checking') && retry !== true) return copy(run);
      const plan = checkedPlan(await store.getPlan(run.planId));
      if (run.planHash !== plan.hash || run.planVersion !== plan.version || run.approval?.hash !== plan.hash || run.approval?.version !== plan.version) throw new LiveConflictError('The execution does not match its saved approval.');
      const event = await readEvent(run.eventId), mapping = await mappingFor(event);
      const claimed = await store.claimRun({ runId: run.id, workerId: string(workerId, 'worker identity', 128), leaseSeconds, recovery: retry === true });
      if (!claimed?.lease) return { ...copy(run), busy: true };
      run = own(claimed.run);
      let lease = claimed.lease, lost = false;
      const fencing = () => ({ runId: run.id, leaseToken: lease.token, generation: lease.generation });
      async function touch() {
        if (lost) throw new LiveLeaseLostError();
        const next = await store.heartbeatRun({ ...fencing(), leaseSeconds });
        if (!next || next.token !== lease.token || next.generation !== lease.generation) { lost = true; throw new LiveLeaseLostError(); }
        lease = next;
      }
      async function checkpoint(kind, patch, runPatch = {}, eventPatch) {
        await touch();
        const saved = await store.checkpointStep({ ...fencing(), kind, patch, runPatch: { ...runPatch, updatedAt: timestamp() }, ...(eventPatch ? { eventPatch } : {}) });
        if (!saved) { lost = true; throw new LiveLeaseLostError(); }
        run = own(saved.run || saved);
        return run;
      }
      async function external(operation) {
        await touch();
        const stop = new AbortController();
        let finished = false;
        const action = (async () => { try { return await operation(); } finally { finished = true; stop.abort(); } })();
        const renewal = (async () => {
          while (!finished) {
            try { await sleep(Math.floor(leaseSeconds * 1000 / 3), undefined, { signal: stop.signal }); }
            catch (error) { if (error.name === 'AbortError') break; throw error; }
            if (!finished) await touch();
          }
        })();
        const [result, renewed] = await Promise.allSettled([action, renewal]);
        if (renewed.status === 'rejected' || lost) { lost = true; throw new LiveLeaseLostError(); }
        await touch();
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      }
      const step = kind => run.steps.find(item => item.kind === kind);
      async function attention(kind, status, summary, verification = null) {
        await checkpoint(kind, { status, summary, verification, finishedAt: timestamp() }, { status, lastError: summary });
        return copy(run);
      }
      async function staleSource(kind, summary) {
        // Every consequential action records its attempt before dispatch. A stale review may
        // be retired only when none has ever started; attempted/uncertain work stays blocked.
        const untouched = run.steps.every(item => item.attempts === 0 && ['pending', 'failed', 'skipped'].includes(item.status) && !item.startedAt && item.verification == null);
        if (!untouched) return attention(kind, 'failed', summary);
        await checkpoint(null, {}, { status: 'cancelled', resolution: 'source-stale-before-dispatch', completedAt: timestamp(), lastError: `${summary} This plan was stopped before any update or announcement was attempted. Prepare a fresh review using the current records.` });
        return copy(run);
      }
      try {
        if (event.version !== plan.eventVersion || mapping.version !== plan.mappingVersion || (event.latestPlanId && event.latestPlanId !== plan.id)) return await staleSource(null, 'The saved event or mappings changed.');
        const adapters = await contextFor(event, mapping, plan, run, fencing());
        const current = await external(() => sourceData(adapters, mapping));
        if (rosterHash(current.roster) !== plan.snapshot.rosterHash || assignmentsHash(current.assignments) !== plan.snapshot.assignmentsHash) return await staleSource(null, 'The linked roster or volunteer assignments changed. Review the recipients and impact again.');
        const calendarAligned = calendarTargetMatches(current.calendar, plan.snapshot.target, event.timezone, plan.snapshot.calendarDetailsHash);
        const currentCalendar = calendarBefore(current.calendar, event.timezone);
        const currentSheet = snapshotSheetRow(current.sheet, mapping.schedule.mapping), expectedSheetTarget = sheetTarget(plan.snapshot.sheetBefore, plan.snapshot.target);
        const calendarConflictsHash = sources => hash(conflictsFor({ event, mapping, calendarEvent: sources.calendar, calendarEvents: sources.calendarEvents, assignments: sources.assignments, roster: sources.roster, target: plan.snapshot.target, sheetBefore: snapshotSheetRow(sources.sheet, mapping.schedule.mapping), now: now() }).conflicts.filter(conflict => conflict.kind === 'calendar-overlap').sort((a, b) => canonical(a).localeCompare(canonical(b))));
        if (calendarConflictsHash(current) !== plan.snapshot.calendarConflictsHash) return await staleSource(null, 'A connected Calendar conflict changed after preview. Review the impact again before executing.');
        const calendarWasAttempted = step('calendar').attempts > 0 || step('calendar').status === 'verified';
        const sheetWasAttempted = step('sheets').attempts > 0 || step('sheets').status === 'verified';
        if (!same(currentCalendar, plan.snapshot.calendarBefore) && !(calendarWasAttempted && calendarAligned)) return await staleSource('calendar', 'The Calendar event changed after preview. Refresh and review before continuing.');
        if (hash(businessDetails(current.calendar)) !== plan.snapshot.calendarDetailsHash) return await staleSource('calendar', 'Important Calendar details changed after preview. Review the event again.');
        if (!sheetMatches(currentSheet, plan.snapshot.sheetBefore) && !(sheetWasAttempted && sheetMatches(currentSheet, expectedSheetTarget))) return await staleSource('sheets', 'The schedule row changed after preview. Refresh and review before continuing.');
        await checkpoint(null, {}, { status: 'running', lastError: null });
        if (calendarWasAttempted && calendarAligned) {
          if (step('calendar').status !== 'verified') await checkpoint('calendar', { status: 'verified', summary: 'The intended Calendar schedule was read back and reconciled.', verification: { ...plan.snapshot.target, etag: currentCalendar.etag }, finishedAt: timestamp() });
        } else {
          await checkpoint('calendar', { status: 'running', attempts: step('calendar').attempts + 1, summary: 'Updating the connected Calendar event.', startedAt: timestamp() });
          let result;
          try { result = await external(() => adapters.calendar.reschedule({ ...mapping.calendar, start: plan.snapshot.target.start, expected: plan.snapshot.calendarBefore, timeZone: event.timezone })); }
          catch (error) {
            if (error instanceof LiveLeaseLostError) throw error;
            return await attention('calendar', error.code === 'CALENDAR_SOURCE_CHANGED' || error.code === 'CALENDAR_SETUP_REQUIRED' ? 'failed' : 'needs-checking', 'The Calendar update could not be confirmed. Check its saved source before retrying.');
          }
          if (result.status !== 'verified') return await attention('calendar', 'needs-checking', 'The Calendar result needs checking before the schedule or announcement can continue.');
          await checkpoint('calendar', { status: 'verified', summary: 'Calendar schedule updated and read back.', verification: { ...plan.snapshot.target, ...(result.event?.etag ? { etag: result.event.etag } : {}) }, finishedAt: timestamp() });
        }
        if (sheetWasAttempted && sheetMatches(currentSheet, expectedSheetTarget)) {
          if (step('sheets').status !== 'verified') await checkpoint('sheets', { status: 'verified', summary: 'The intended spreadsheet row was read back and reconciled.', verification: { ...plan.snapshot.target }, finishedAt: timestamp() });
        } else {
          await checkpoint('sheets', { status: 'running', attempts: step('sheets').attempts + 1, summary: 'Updating the linked schedule row by stable event ID.', startedAt: timestamp() });
          let result;
          try { result = await external(() => adapters.sheets.updateSchedule({ ...mapping.schedule, start: plan.snapshot.target.start, end: plan.snapshot.target.end, expected: plan.snapshot.sheetBefore })); }
          catch (error) {
            if (error instanceof LiveLeaseLostError) throw error;
            return await attention('sheets', error.code === 'SHEETS_SOURCE_CHANGED' || error.code === 'SHEETS_SETUP_REQUIRED' ? 'failed' : 'needs-checking', 'The spreadsheet update could not be confirmed. Completed Calendar work is preserved.');
          }
          if (result.status !== 'verified') return await attention('sheets', 'needs-checking', 'The schedule row needs checking. Calendar is preserved and no announcement has been sent.');
          await checkpoint('sheets', { status: 'verified', summary: 'Schedule row updated and read back by stable event ID.', verification: { ...plan.snapshot.target }, finishedAt: timestamp() });
        }
        // Re-read both required sources immediately before allowing any Gmail action, including on recovery.
        const finalSources = await external(() => sourceData(adapters, mapping));
        if (!calendarTargetMatches(finalSources.calendar, plan.snapshot.target, event.timezone, plan.snapshot.calendarDetailsHash) ||
            !sheetMatches(snapshotSheetRow(finalSources.sheet, mapping.schedule.mapping), expectedSheetTarget) ||
            calendarConflictsHash(finalSources) !== plan.snapshot.calendarConflictsHash ||
            rosterHash(finalSources.roster) !== plan.snapshot.rosterHash || assignmentsHash(finalSources.assignments) !== plan.snapshot.assignmentsHash) {
          return await attention(null, 'needs-checking', 'Connected data changed before announcement. No further messages will be sent until the sources are reviewed.');
        }
        if (plan.snapshot.notify) {
          if (!adapters.gmail) return await attention('gmail', 'failed', 'Connect the approved Gmail sender to finish this announcement.');
          const outcomes = copy(step('gmail').verification?.outcomes || []);
          await checkpoint('gmail', { status: 'running', attempts: step('gmail').attempts + 1, startedAt: timestamp(), summary: 'Sending the exact approved announcements individually.', verification: { outcomes } });
          for (const notification of plan.snapshot.notifications) {
            let outcome = outcomes.find(item => item.receiptId === notification.receiptMarker);
            if (outcome?.status === 'sent') continue;
            let result;
            try {
              result = await external(() => outcome?.status === 'needs-checking' ? adapters.gmail.reconcile({ receiptId: notification.receiptMarker }) : adapters.gmail.sendApproved({ approvalId: notification.id, version: plan.version, hash: plan.hash, scheduleVerified: step('calendar').status === 'verified' && step('sheets').status === 'verified' }));
            } catch (error) {
              if (error instanceof LiveLeaseLostError) throw error;
              result = { status: 'needs-checking', acknowledged: false };
            }
            const saved = { receiptId: notification.receiptMarker, status: result.status === 'sent' ? 'sent' : 'needs-checking', acknowledged: false };
            if (outcome) Object.assign(outcome, saved); else { outcome = saved; outcomes.push(outcome); }
            await checkpoint('gmail', { status: result.status === 'sent' ? 'running' : 'needs-checking', verification: { outcomes }, summary: result.status === 'sent' ? 'An approved announcement is sent; acknowledgement is not checked.' : 'An announcement result needs checking. It will not be resent blindly.' });
            if (result.status !== 'sent') return await attention('gmail', 'needs-checking', 'An announcement result needs checking. Use receipt reconciliation before any resend.', { outcomes });
          }
          await checkpoint('gmail', { status: 'verified', summary: 'Every approved announcement was verified as sent. Receipt acknowledgements are not checked.', verification: { outcomes }, finishedAt: timestamp() });
        }
        await checkpoint(null, {}, { status: 'verified', completedAt: timestamp(), lastError: null }, { start: plan.snapshot.target.start, end: plan.snapshot.target.end, version: event.version + 1 });
        return copy(run);
      } catch (error) {
        if (error instanceof LiveLeaseLostError) throw error;
        await checkpoint(null, {}, { status: 'needs-checking', lastError: 'The saved execution was interrupted. Check its persisted steps before retrying.' });
        return copy(run);
      } finally {
        try { await store.releaseRun(fencing()); } catch { /* The durable lease expires; no fire-and-forget work is left running. */ }
      }
    },
  });
}

