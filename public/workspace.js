import { connect, loadConnectScript } from '/vendor/viasocket-browser.js';

const root = document.querySelector('#live-app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const APPS = [
  { slug: 'google-calendar', title: 'Google Calendar', icon: '31', cls: 'calendar', description: 'Read the workshop you choose, update its schedule, and verify it by reading it back.' },
  { slug: 'google-sheets', title: 'Google Sheets', icon: '▤', cls: 'sheets', description: 'Link your event schedule, participants, and recorded volunteer assignments.' },
  { slug: 'gmail', title: 'Gmail', icon: 'M', cls: 'gmail', description: 'Send your exact approved announcement individually after the schedule is verified.' },
];
let user = null, state = null, busy = false, route = parseRoute(), selectedEvent = '', search = '', activePlan = null, mapMode = 'map', impact = 'calendar', acknowledged = false, toastTimer, polling = false, connectReady = false, preparationStarted = false, preparationRunning = false;
let connectOperation = null, connectSequence = 0, connectionNotice = '';
const latestConnectByApp = new Map(), reloadBeforeRetry = new Set();
const tokenCache = new Map(), tokenErrors = new Map(), draftMemory = new Map();
const aiFeedback = new Map(), invalidatedPlanIds = new Set();
const connectionAccessNotices = new Map();
const wizard = { calendarChoice: '', calendarEventChoice: '', spreadsheetChoice: '', scheduleTabChoice: '', scheduleRowChoice: '', rosterTabChoice: '', assignmentsTabChoice: '', mappings: { schedule: {}, roster: {}, assignments: {} } };
const options = { calendars: [], calendarEvents: [], spreadsheets: [], tabs: [], scheduleColumns: [], scheduleRows: [], rosterColumns: [], assignmentsColumns: [], senders: [] };
const columnFields = { schedule: [['eventId', 'Event reference'], ['title', 'Event title'], ['start', 'Start time'], ['end', 'End time'], ['timezone', 'Timezone'], ['location', 'Location']], roster: [['eventId', 'Event reference'], ['name', 'Person’s name'], ['email', 'Email address'], ['role', 'Participant or volunteer role']], assignments: [['person', 'Volunteer’s name'], ['eventId', 'Event reference'], ['start', 'Assignment start'], ['end', 'Assignment end']] };
const setupSelections = {
  calendarChoice: ['calendar', 'calendars', 'Calendar'], calendarEventChoice: ['calendarEvent', 'calendarEvents', 'Workshop'],
  spreadsheetChoice: ['spreadsheet', 'spreadsheets', 'Spreadsheet'], scheduleTabChoice: ['scheduleTab', 'tabs', 'Schedule tab'],
  scheduleRowChoice: ['scheduleRow', 'scheduleRows', 'Event row'], rosterTabChoice: ['rosterTab', 'tabs', 'Participant tab'], assignmentsTabChoice: ['assignmentsTab', 'tabs', 'Assignment tab'],
};
let setupLabels = { step: 'accounts', selections: {}, columns: {} }, setupInitialized = false, setupDirty = false, setupRevision = 0, setupSaveTimer, setupSaveChain = Promise.resolve(), setupSaveMessage = '', setupResumeIssues = [], setupResuming = false, reloadSetupDraft = null;
if (route.page === 'change') selectedEvent = route.id;

function parseRoute() { const [page = 'overview', id = ''] = location.hash.slice(1).split('/'); let decoded = ''; try { decoded = decodeURIComponent(id); } catch { /* An invalid URL fragment is not a saved record reference. */ } return { page: ['overview', 'events', 'event', 'connections', 'change', 'preview', 'activity', 'settings'].includes(page) ? page : 'overview', id: decoded }; }
function go(page, id = '') { route = { page, id }; location.hash = page + (id ? '/' + encodeURIComponent(id) : ''); render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
function eventById(id = selectedEvent) { return state?.events?.find(event => event.id === id); }
function planById(id = route.id) { const plan = state?.plans?.find(plan => plan.id === id) || (activePlan?.id === id ? activePlan : null); const stopped = state?.runs?.some(run => run.planId === id && run.status === 'cancelled'); let invalidated = invalidatedPlanIds.has(id) || stopped; try { invalidated ||= sessionStorage.getItem('changerelay-live-invalid-plan-' + id) === '1'; } catch {} return plan && invalidated ? { ...plan, superseded: true, stopped } : plan; }
function connectionFor(app) { const list = Array.isArray(state?.connections) ? state.connections : Object.values(state?.connections || {}); return list.find(connection => (connection.app || connection.appSlug || connection.app_slug) === app); }
function connectionStatus(app) { const saved = connectionFor(app)?.status; return ['paused', 'needs_attention'].includes(saved) ? saved : tokenCache.get(app)?.reconnectAuthId ? 'expired' : saved || 'disconnected'; }
function connected(app) { return connectionStatus(app) === 'connected'; }
function titleOfRun(run) { return eventById(run.eventId)?.title || run.title || 'Saved event change'; }
function scheduleStart(event) { return event?.start || event?.startsAt || event?.starts_at; }
function scheduleEnd(event) { return event?.end || event?.endsAt || event?.ends_at; }
function zone(event) { return event?.timezone || event?.timeZone || state?.workspace?.timezone || 'UTC'; }
function format(value, timeZone, short = false) { try { return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return 'Schedule unavailable'; } }
function statusLabel(status) { return ({ pending: 'Queued', running: 'In progress', verified: 'Verified', failed: 'Needs attention', 'needs-checking': 'Needs checking', needs_checking: 'Needs checking', skipped: 'Not included', sent: 'Sent', connected: 'Connected', paused: 'Paused', expired: 'Reconnect', disconnected: 'Not connected', setup_required: 'Setup needed', needs_attention: 'Needs attention', cancelled: 'Stopped — review current records' })[status] || 'Not connected'; }
function attention(status) { return ['failed', 'needs-checking', 'needs_checking', 'needs_attention', 'expired'].includes(status); }
const badge = (status, fallback) => `<span class="badge ${attention(status) || status === 'setup_required' ? 'warn' : ''} ${status === 'running' ? 'running' : ['cancelled', 'paused'].includes(status) ? 'stopped' : ''}">${esc(fallback || statusLabel(status))}</span>`;
function toolIcon(app, tiny = false) { return `<span class="tool-icon ${app.cls} ${tiny ? 'tiny-tool' : ''}" aria-hidden="true">${app.icon}</span>`; }
function notify(message) { clearTimeout(toastTimer); const toast = document.querySelector('#live-toast'); toast.textContent = message; toast.style.display = 'block'; toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 6500); }
function setBusy(value, message = '') { busy = value; root.setAttribute('aria-busy', String(value)); root.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.action === 'cancel-connection' ? !connectOperation?.waiting : value || button.dataset.unready === 'true' || button.dataset.baseDisabled === 'true'; }); const status = root.querySelector('#global-status'); if (status) status.textContent = message || (value && connectOperation?.waiting ? 'Waiting for your account approval…' : ''); }
async function api(path, body, method) {
  const response = await fetch('/api/' + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let result; try { result = await response.json(); } catch { throw new Error('The workspace could not read the response. Your input is preserved.'); }
  if (response.status === 401) { location.assign('/signin?returnTo=%2Fworkspace'); throw new Error('Sign in to continue.'); }
  if (!response.ok) throw new Error(result.error || 'This update could not be completed. Please try again.');
  return result;
}
async function act(message, action) { if (busy) return; setBusy(true, message); try { await action(); } catch (error) { notify(error.message); } finally { setBusy(false); } }
function acceptState(value) { state = value; state.events ||= []; state.runs ||= []; state.plans ||= []; state.events.sort((a, b) => (Date.parse(scheduleStart(a)) || 0) - (Date.parse(scheduleStart(b)) || 0)); state.runs.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)); initializeSetup(); }
async function refreshState({ renderPage = true } = {}) { acceptState(await api('live/state')); if (renderPage) render(); }
function generatedAnnouncement(event, local, instantChoice = '') {
  const timeZone = zone(event), duration = Date.parse(scheduleEnd(event)) - Date.parse(scheduleStart(event));
  const minutes = duration / 60000;
  let proposed = null, candidates = [];
  try { candidates = localCandidates(local, timeZone); proposed = candidates.find(candidate => candidate.value === instantChoice) || (candidates.length === 1 ? candidates[0] : null); } catch { /* An incomplete local input stays unconfirmed until the form is valid. */ }
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  const durationText = Number.isInteger(minutes) && minutes > 0 ? [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', remainder ? `${remainder} ${remainder === 1 ? 'minute' : 'minutes'}` : ''].filter(Boolean).join(' ') : 'Confirmed in the review';
  const before = `${format(scheduleStart(event), timeZone)} – ${format(scheduleEnd(event), timeZone)}`;
  const after = proposed && Number.isFinite(duration) && duration > 0 ? `${format(proposed.value, timeZone)} – ${format(new Date(Date.parse(proposed.value) + duration).toISOString(), timeZone)}` : candidates.length > 1 ? `${local.replace('T', ' ')} · choose its UTC offset before previewing; the end time will be confirmed in review` : 'Choose a valid new date and time in the form';
  return `Hi everyone,\n\nPlease review the schedule for ${event.title}.\n\nPrevious schedule: ${before}\nUpdated schedule: ${after}\nTimezone: ${timeZone}\nDuration: ${durationText} (unchanged)\nLocation: ${event.location || 'Please confirm with the organiser'}\n\nThank you!`;
}
function initialDraft(event) { const local = localInput(scheduleStart(event), zone(event)); return { local, notify: preferences().notificationsDefault, from: '', subject: `${event.title} · updated schedule`, messageBody: generatedAnnouncement(event, local), autoGenerated: true, recipients: [], instantChoice: '', aiRequest: '' }; }
function draftFor(event) { if (!event) return null; if (draftMemory.has(event.id)) return draftMemory.get(event.id); let saved; try { saved = JSON.parse(sessionStorage.getItem('changerelay-live-draft-' + event.id) || 'null'); } catch { /* Private browsing may disable session storage. */ } const draft = saved && typeof saved === 'object' ? { ...initialDraft(event), ...saved, autoGenerated: saved.autoGenerated === true } : initialDraft(event); draftMemory.set(event.id, draft); return draft; }
function saveDraft(eventId, draft) { draftMemory.set(eventId, draft); try { sessionStorage.setItem('changerelay-live-draft-' + eventId, JSON.stringify(draft)); } catch { /* The in-memory draft remains available. */ } }
function localParts(date, timeZone) { return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value])); }
function localInput(value, timeZone) { try { const part = localParts(new Date(value), timeZone); return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`; } catch { return ''; } }
/** Resolve a wall-clock time in the event's IANA zone, independent of the browser's timezone. */
function localCandidates(local, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error('Choose a complete date and time.');
  const [, year, month, day, hour, minute] = match.map(String), naive = Date.UTC(+year, +month - 1, +day, +hour, +minute);
  const dateCheck = new Date(naive); if (dateCheck.getUTCFullYear() !== +year || dateCheck.getUTCMonth() !== +month - 1 || dateCheck.getUTCDate() !== +day || +hour > 23 || +minute > 59) throw new Error('Choose a valid date and time.');
  const offsets = new Set();
  for (let step = -36; step <= 36; step += 6) { const stamp = naive + step * 3600000, part = localParts(new Date(stamp), timeZone); offsets.add(Date.UTC(+part.year, +part.month - 1, +part.day, +part.hour, +part.minute, +part.second) - stamp); }
  return [...offsets].map(offset => new Date(naive - offset)).filter(date => localInput(date.toISOString(), timeZone) === local).sort((a, b) => a - b).map(date => ({ value: date.toISOString(), label: new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'longOffset', hourCycle: 'h23' }).format(date) }));
}

function validTimezone(value) { try { return typeof value === 'string' && value.length <= 100 && !!new Intl.DateTimeFormat('en', { timeZone: value }).format(0); } catch { return false; } }
function preferences() { const saved = state?.setup?.preferences || {}; return { displayTimezone: validTimezone(saved.displayTimezone) ? saved.displayTimezone : validTimezone(state?.workspace?.timezone) ? state.workspace.timezone : 'UTC', notificationsDefault: saved.notificationsDefault === true }; }
function secondarySchedule(start, end, eventZone) { const displayZone = preferences().displayTimezone; return displayZone === eventZone ? '' : `<p class="hint secondary-time">Also in your display timezone · ${esc(displayZone)}<br>${format(start, displayZone)}${end ? ' – ' + format(end, displayZone) : ''}</p>`; }
function cleanSetupLabel(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 600 && !/[\x00-\x1f\x7f]/.test(value) ? value : ''; }
function safeSetupLabels(draft) {
  const clean = { step: ['accounts', 'calendar', 'schedule', 'people', 'review'].includes(draft?.step) ? draft.step : 'accounts', selections: {}, columns: {} };
  for (const [key] of Object.values(setupSelections)) { const label = cleanSetupLabel(draft?.selections?.[key]); if (label) clean.selections[key] = label; }
  for (const [kind, fields] of Object.entries(columnFields)) for (const [key] of fields) { const label = cleanSetupLabel(draft?.columns?.[kind]?.[key]); if (label) { clean.columns[kind] ||= {}; clean.columns[kind][key] = label; } }
  return clean;
}
function hasSetupLabels() { return Object.keys(setupLabels.selections).length > 0 || Object.values(setupLabels.columns).some(columns => Object.keys(columns).length); }
function initializeSetup() {
  state.setup ||= { version: 1, onboarding: null, preferences: { displayTimezone: validTimezone(state.workspace?.timezone) ? state.workspace.timezone : 'UTC', notificationsDefault: false }, updatedAt: null };
  if (setupInitialized) return;
  const useReload = reloadSetupDraft && reloadSetupDraft.savedAt > (Date.parse(state.setup.updatedAt) || 0);
  setupLabels = safeSetupLabels(useReload ? reloadSetupDraft.onboarding : state.setup.onboarding);
  setupDirty = !!useReload; setupInitialized = true; reloadSetupDraft = null;
  setupSaveMessage = hasSetupLabels() ? useReload ? 'Restored from this browser. Save to keep these choices in your account.' : 'Setup saved to your account. Resume to check fresh choices.' : 'Choices save to your account as you make them.';
}
function chosenLabel(list, value) { return cleanSetupLabel((options[list] || []).find(item => item.value === value)?.label); }
function forgetSetupSelection(key) { const spec = setupSelections[key]; if (spec) delete setupLabels.selections[spec[0]]; }
function updateSetupLabels(key) {
  const spec = setupSelections[key]; if (!spec) return;
  const label = chosenLabel(spec[1], wizard[key]);
  if (label) setupLabels.selections[spec[0]] = label; else forgetSetupSelection(key);
  if (key === 'calendarChoice') forgetSetupSelection('calendarEventChoice');
  if (key === 'spreadsheetChoice') {
    for (const child of ['scheduleTabChoice', 'scheduleRowChoice', 'rosterTabChoice', 'assignmentsTabChoice']) forgetSetupSelection(child);
    setupLabels.columns = {};
  }
  if (key.endsWith('TabChoice')) { const role = key.replace('TabChoice', ''); delete setupLabels.columns[role]; if (role === 'schedule') forgetSetupSelection('scheduleRowChoice'); }
  setupLabels.step = key.startsWith('calendar') ? 'calendar' : key.startsWith('roster') || key.startsWith('assignments') ? 'people' : 'schedule';
  setupResumeIssues = []; scheduleSetupSave();
}
function updateSetupColumn(kind, key, value) {
  if (!columnFields[kind]?.some(([field]) => field === key)) return;
  setupLabels.columns[kind] ||= {};
  const label = chosenLabel(kind + 'Columns', value);
  if (label) setupLabels.columns[kind][key] = label; else delete setupLabels.columns[kind][key];
  setupLabels.step = kind === 'schedule' ? 'schedule' : 'people';
  if (wizard.scheduleRowChoice && mappingReady('schedule') && (!wizard.rosterTabChoice || mappingReady('roster')) && (!wizard.assignmentsTabChoice || mappingReady('assignments'))) setupLabels.step = 'review';
  setupResumeIssues = []; scheduleSetupSave();
}
function setupStatus(message = setupSaveMessage) { setupSaveMessage = message; const status = document.querySelector('#setup-save-status'); if (status) status.textContent = message; }
function scheduleSetupSave() {
  setupDirty = true; setupRevision++; clearTimeout(setupSaveTimer); setupStatus('Changes waiting to save…');
  setupSaveTimer = setTimeout(() => { void persistSetupDraft().catch(() => {}); }, 750);
}
function persistSetupDraft({ clear = false } = {}) {
  clearTimeout(setupSaveTimer);
  const ownerId = user?.id, revision = setupRevision, onboarding = clear ? null : safeSetupLabels(setupLabels);
  const task = setupSaveChain.catch(() => {}).then(async () => {
    if (!ownerId || user?.id !== ownerId) return;
    setupStatus('Saving setup…');
    try {
      const result = await api('live/setup', { version: 1, onboarding });
      if (!result?.setup || result.setup.version !== 1) throw new Error('Setup could not be saved. Please retry.');
      if (user?.id !== ownerId) return;
      state.setup = result.setup;
      if (revision === setupRevision) { setupDirty = false; setupStatus(clear ? 'Setup is complete. Your confirmed event links are saved.' : 'Setup saved to your account. You can finish later.'); }
      try { sessionStorage.removeItem('changerelay-live-setup-' + ownerId); } catch {}
      return result.setup;
    } catch (error) { if (revision === setupRevision && user?.id === ownerId) { setupDirty = true; setupStatus('Setup is not saved yet. Use Save setup to retry.'); } throw error; }
  });
  setupSaveChain = task; return task;
}
function resetWizardChoices() { for (const key of Object.keys(setupSelections)) wizard[key] = ''; wizard.mappings = { schedule: {}, roster: {}, assignments: {} }; for (const key of Object.keys(options)) if (key !== 'senders') options[key] = []; }
async function clearSavedSetup() { clearTimeout(setupSaveTimer); setupRevision++; await persistSetupDraft({ clear: true }); setupLabels = safeSetupLabels(null); setupResumeIssues = []; resetWizardChoices(); render(); notify('The unfinished setup draft was cleared. Your connections and linked events are unchanged.'); }
async function resumeSetup() {
  const saved = safeSetupLabels(setupLabels); if (!hasSetupLabels()) throw new Error('There is no unfinished setup to resume.');
  clearTimeout(setupSaveTimer); setupResuming = true; setupResumeIssues = []; resetWizardChoices();
  const choose = (list, label, description) => {
    if (!label) return '';
    const matches = (options[list] || []).filter(option => option.label === label);
    if (matches.length === 1) return matches[0].value;
    setupResumeIssues.push(`${description}: “${label}” ${matches.length ? 'matches more than one record' : 'was not found in the fresh choices'}. Choose it again.`); return '';
  };
  const load = async kind => { try { await loadOptions(kind, { quiet: true }); return true; } catch (error) { setupResumeIssues.push(error.message); return false; } };
  try {
    if (saved.selections.calendar) {
      if (!connected('google-calendar')) setupResumeIssues.push('Connect Google Calendar before restoring its saved choices.');
      else if (await load('calendars')) { wizard.calendarChoice = choose('calendars', saved.selections.calendar, 'Calendar'); if (wizard.calendarChoice && saved.selections.calendarEvent && await load('calendarEvents')) wizard.calendarEventChoice = choose('calendarEvents', saved.selections.calendarEvent, 'Workshop'); }
    }
    if (saved.selections.spreadsheet) {
      if (!connected('google-sheets')) setupResumeIssues.push('Connect Google Sheets before restoring its saved choices.');
      else if (await load('spreadsheets')) {
        wizard.spreadsheetChoice = choose('spreadsheets', saved.selections.spreadsheet, 'Spreadsheet');
        if (wizard.spreadsheetChoice && await load('tabs')) {
          for (const role of ['schedule', 'roster', 'assignments']) {
            const key = role + 'TabChoice', labelKey = setupSelections[key][0]; wizard[key] = choose('tabs', saved.selections[labelKey], setupSelections[key][2]);
            if (!wizard[key]) continue;
            if (await load(role + 'Columns')) for (const [field, description] of columnFields[role]) { const label = saved.columns[role]?.[field]; if (label) wizard.mappings[role][field] = choose(role + 'Columns', label, description); }
            if (role === 'schedule' && saved.selections.scheduleRow && await load('scheduleRows')) wizard.scheduleRowChoice = choose('scheduleRows', saved.selections.scheduleRow, 'Event row');
          }
        }
      }
    }
    setupStatus(setupResumeIssues.length ? 'Some saved choices need your attention. Nothing was linked automatically.' : 'Fresh choices restored. Review every selection before confirming the event.');
  } finally { setupResuming = false; render(); }
}
function setupSavePanel() {
  const hasDraft = hasSetupLabels(), selected = Object.keys(setupSelections).some(key => wizard[key]);
  return `<section class="card setup-save-panel"><div class="row"><div><h2>Finish setup at your pace.</h2><p class="hint" id="setup-save-status" role="status" aria-live="polite">${esc(setupSaveMessage || 'Choices save to your account as you make them.')}</p></div><div class="row">${hasDraft && !selected ? '<button class="primary" data-action="resume-setup">Resume saved setup →</button>' : ''}<button data-action="save-setup-later">Save setup and finish later</button></div></div><p class="hint">Saved setup contains record and column names. On resume, fresh choices must match each name uniquely; account approval and confirmed links remain separate.</p>${hasDraft ? `<details><summary>Saved choices${setupDirty ? ' · changes not saved yet' : ''}</summary><dl class="saved-choice-list">${Object.values(setupSelections).filter(([key]) => setupLabels.selections[key]).map(([key, , label]) => `<div><dt>${label}</dt><dd>${esc(setupLabels.selections[key])}</dd></div>`).join('')}</dl><button class="text-button" data-action="clear-setup">Clear unfinished setup draft</button></details>` : ''}${setupResumeIssues.length ? `<div class="notice"><strong>Choose these records again</strong><ul>${setupResumeIssues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul></div>` : ''}</section>`;
}
async function savePreferences() {
  const form = document.querySelector('#live-preferences-form'), displayTimezone = form?.querySelector('#display-timezone')?.value?.trim(), notificationsDefault = form?.querySelector('#notifications-default')?.checked === true;
  if (!validTimezone(displayTimezone)) throw new Error('Enter a valid timezone, such as Asia/Kolkata, Europe/London or America/New_York.');
  const ownerId = user?.id;
  // All setup responses share one queue, including a draft waiting for its debounce.
  if (setupDirty) await persistSetupDraft();
  const task = setupSaveChain.catch(() => {}).then(async () => {
    if (!ownerId || user?.id !== ownerId) return;
    const result = await api('live/setup', { version: 1, preferences: { displayTimezone, notificationsDefault } });
    if (!result?.setup || result.setup.version !== 1) throw new Error('Preferences could not be saved. Please retry.');
    if (user?.id !== ownerId) return;
    state.setup = result.setup; render(); notify('Preferences saved. Existing drafts and approved plans are unchanged.');
  });
  setupSaveChain = task; return task;
}

function connectionWaitPanel() {
  if (connectOperation?.waiting) {
    const title = APPS.find(app => app.slug === connectOperation.app)?.title || 'your Google account';
    return `<section class="notice connection-wait-panel" role="status"><strong>Waiting for ${esc(title)} approval</strong><p>Look for a separate sign-in window. If no window opens, you can stop waiting and continue using the workspace.</p><button type="button" data-action="cancel-connection">Stop waiting</button><p class="hint">Stopping only releases this screen. It does not revoke permissions you may have granted. A later result is still checked before saving.</p></section>`;
  }
  return connectionNotice && route.page === 'connections' ? `<section class="notice" role="status">${esc(connectionNotice)}<div style="margin-top:12px"><button type="button" data-action="reload-connections">Reload connection setup</button></div></section>` : '';
}
function shell(content) {
  const labels = { overview: 'Overview', events: 'Events', event: 'Event details', connections: 'Connections & setup', change: 'Plan a change', preview: 'Review and approve', activity: 'Activity', settings: 'Settings' };
  return `<div class="live-shell"><aside class="sidebar"><a href="/" class="brand"><span class="logo">↗↗</span>ChangeRelay.</a><div class="workspace"><strong>${esc(state.workspace?.name || 'Your organiser workspace')}</strong><span class="badge">● Live workspace</span></div><nav class="nav" aria-label="Workspace">${[['overview', '◫', 'Overview'], ['events', '▤', 'Events'], ['activity', '↺', 'Activity'], ['connections', '⌘', 'Connections'], ['settings', '⚙', 'Settings']].map(([page, icon, label]) => `<a href="#${page}" class="${(route.page === page || (page === 'events' && route.page === 'event')) ? 'active' : ''}" ${(route.page === page || (page === 'events' && route.page === 'event')) ? 'aria-current="page"' : ''}>${icon} &nbsp; ${label}</a>`).join('')}</nav><div class="sidefoot"><strong>One change. Everything aligned.</strong><br>Review first. Follow every update.<div class="divider"></div><a href="/#dashboard">Explore sample workspace ↗</a><br>Sample data stays separate.</div></aside><div class="main"><header class="topbar"><span>Workspace <span style="color:#a2afa5"> / </span> ${labels[route.page]}</span><span class="row"><span class="badge">● Live workspace</span><span class="account-line">${esc(user.email)}</span><span class="avatar" aria-label="Your account">${esc((user.name || user.email || 'O').slice(0, 1).toUpperCase())}</span></span></header><main class="content" id="workspace-main" tabindex="-1"><div id="global-status" role="status" aria-live="polite"></div>${connectionWaitPanel()}${content}<footer class="footer">ChangeRelay &nbsp; · &nbsp; Real connections. Reviewed changes. A clear trail.</footer></main></div></div>`;
}
function eventCard(event) { return `<article class="card event"><div class="row"><span class="eyebrow">LINKED EVENT</span>${badge('verified', 'Ready to review')}</div><h3>${esc(event.title)}</h3><div class="meta">◷ &nbsp; ${format(scheduleStart(event), zone(event))} – ${format(scheduleEnd(event), zone(event), true)}<br>⌖ &nbsp; ${esc(event.location || 'Location not specified')}<br>${esc(zone(event))}</div>${secondarySchedule(scheduleStart(event), scheduleEnd(event), zone(event))}<div class="divider"></div><div class="row"><span class="meta">Calendar + schedule spreadsheet</span><button class="primary" data-action="plan-event" data-event="${esc(event.id)}">Plan a change ↗</button></div><a class="text-button event-details-link" href="#event/${encodeURIComponent(event.id)}">View event details →</a></article>`; }
function overview() {
  const ready = APPS.filter(app => connected(app.slug)).length, attentionRuns = state.runs.filter(run => attention(run.status));
  return `<div class="row intro"><div><div class="eyebrow">YOUR PLANS, CONNECTED</div><h1>A clear way through every change.</h1><p>Review the impact, keep the details aligned, and know where every update stands.</p></div><button class="primary" data-action="go" data-page="events">＋ Plan a change</button></div><section class="hero"><div><div class="eyebrow">A SMALL CHANGE SHOULDN’T LEAVE A BIG GAP.</div><h2>Change the plan once.<br>Bring everyone with it.</h2><p>${state.events.length ? 'Your connected event is ready. Choose a new time and review the exact Calendar, schedule, and announcement updates.' : 'Start by connecting your tools and confirming the workshop records that belong together.'}</p><button class="primary" data-action="go" data-page="${state.events.length ? 'events' : 'connections'}">${state.events.length ? 'Choose your workshop' : 'Set up your first event'} &nbsp; →</button></div><div class="hero-art">${toolIcon(APPS[0])}<span>···</span><span class="appicon">↗</span><span>···</span>${toolIcon(APPS[1])}</div></section><div class="stats"><div class="stat"><span>Linked events</span><strong>${String(state.events.length).padStart(2, '0')}</strong><small>Records you have confirmed</small></div><div class="stat"><span>Connected tools</span><strong>${String(ready).padStart(2, '0')} <span>/ 3</span></strong><small>Accounts connected in this workspace</small></div><div class="stat"><span>Needs attention</span><strong>${String(attentionRuns.length).padStart(2, '0')}</strong><small>${attentionRuns.length ? 'Review saved steps before recovery' : 'No saved updates need checking'}</small></div></div><div class="grid"><section><div class="row section-head"><h2>Your events</h2><a href="#events" class="text-button">View all →</a></div><div class="events">${state.events.length ? state.events.slice(0, 3).map(eventCard).join('') : emptyEvents()}</div></section><aside><div class="card"><h2>Your connected tools</h2>${APPS.map(app => `<div class="connected">${toolIcon(app, true)}<div><strong>${app.title}</strong><br><small>${esc(connectionFor(app.slug)?.displayLabel || 'Your account')}</small></div>${badge(connectionStatus(app.slug))}</div>`).join('')}<div class="divider"></div><a href="#connections" class="text-button">Manage connections →</a></div><div class="card setup-section"><h2>Recent changes</h2>${state.runs.length ? state.runs.slice(0, 3).map(run => `<div class="divider"></div><strong style="font-size:13px">${esc(titleOfRun(run))}</strong><p class="hint">${format(run.createdAt || run.created, zone(eventById(run.eventId)))} · ${statusLabel(run.status)}</p>`).join('') : '<p class="empty">Approved changes and their verified steps will appear here.</p>'}<a href="#activity" class="text-button">View the full trail →</a></div></aside></div>`;
}
function emptyEvents() { return `<div class="card empty-large"><div class="empty-symbol" aria-hidden="true">⌘</div><h2>Bring your first event together.</h2><p>Choose a workshop in Calendar and confirm its matching schedule row.</p><button class="primary" data-action="go" data-page="connections">Connect and link an event →</button></div>`; }
function eventDetailsPage() {
  const event = eventById(route.id);
  if (!event) return `<div class="card empty-large"><h1>This event is unavailable.</h1><p>Choose a linked event from your workspace to see its saved details.</p><button class="primary" data-action="go" data-page="events">Back to events</button></div>`;
  const timeZone = zone(event), people = participantsFor(event), volunteerNames = new Set(people.filter(person => String(person.role).toLowerCase() === 'volunteer').map(person => person.name));
  const assignments = (Array.isArray(event.assignments) ? event.assignments : []).filter(assignment => event.stableEventId && (assignment.eventId === event.stableEventId || volunteerNames.has(assignment.name)));
  const eventRuns = state.runs.filter(run => run.eventId === event.id), unfinished = eventRuns.some(run => ['pending', 'running', 'failed', 'needs-checking', 'needs_checking'].includes(run.status));
  const review = state.plans.filter(plan => plan.eventId === event.id && !planById(plan.id)?.superseded).sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0))[0];
  const savedAt = event.updatedAt || event.createdAt;
  return `<div class="row intro"><div><a href="#events" class="text-button">← Your events</a><div class="eyebrow" style="margin-top:18px">YOUR SAVED EVENT DETAILS</div><h1>${esc(event.title)}</h1><p>One workshop, with the records and people you confirmed during setup.</p></div><div class="row">${review ? `<a class="button" href="#preview/${encodeURIComponent(review.id)}">Continue saved review →</a>` : ''}<button class="primary" data-action="plan-event" data-event="${esc(event.id)}" ${unfinished ? 'disabled' : ''}>Plan a change ↗</button></div></div>${unfinished ? '<div class="notice">This event has an unfinished update. <a href="#activity">Check its saved progress in Activity</a> before planning another change.</div>' : ''}<div class="grid"><section><article class="card event-details-summary"><div class="row"><h2>Saved schedule</h2><span class="badge">Confirmed event record</span></div><dl class="event-facts"><div><dt>Starts</dt><dd>${format(scheduleStart(event), timeZone)}</dd></div><div><dt>Ends</dt><dd>${format(scheduleEnd(event), timeZone)}</dd></div><div><dt>Event timezone</dt><dd>${esc(timeZone)}</dd></div><div><dt>Location</dt><dd>${esc(event.location || 'Location not specified')}</dd></div></dl>${secondarySchedule(scheduleStart(event), scheduleEnd(event), timeZone)}<p class="hint">${savedAt ? 'Details last saved ' + format(savedAt, timeZone) + '. ' : ''}A fresh change preview rechecks your connected records before approval.</p><button type="button" class="text-button" data-action="refresh-state">Refresh saved details ↻</button></article><article class="card setup-section"><div class="row"><h2>People linked to this workshop</h2><span class="badge">${people.length} saved</span></div>${people.length ? `<div class="event-people">${people.map(person => `<div class="event-person"><span class="avatar" aria-hidden="true">${esc(String(person.name || 'P').slice(0, 1).toUpperCase())}</span><div><strong>${esc(person.name || 'Unnamed participant')}</strong><span class="meta">${esc(person.role || 'Role not recorded')}</span><span class="receipt-email">${esc(person.email || 'Email not recorded')}</span></div></div>`).join('')}</div>` : '<p class="empty">No saved participant roster is available in this event summary.</p>'}<p class="hint">Saved roster details do not indicate availability. The announcement form lets you refresh the linked roster and choose recipients explicitly.</p></article><article class="card setup-section"><h2>Recorded volunteer assignments</h2>${assignments.length ? `<div class="event-assignments">${assignments.map(assignment => `<div class="event-assignment"><strong>${esc(assignment.name || 'Unnamed volunteer')}</strong><span class="meta">${assignment.eventId === event.stableEventId ? 'For this workshop' : 'Another recorded workshop'}</span><span>${format(assignment.start, timeZone)} – ${format(assignment.end, timeZone, true)}</span></div>`).join('')}</div>` : '<p class="empty">No saved assignments are available for this workshop’s volunteers in this summary.</p>'}<p class="hint">These are recorded commitments, not a complete availability check. A new preview checks known overlaps; this summary does not infer conflicts or change assignments.</p></article></section><aside><article class="card"><h2>Records connected during setup</h2><div class="connected">${toolIcon(APPS[0], true)}<div><strong>Calendar workshop</strong><br><small>Confirmed event link</small></div>${badge(connectionStatus('google-calendar'))}</div><div class="connected">${toolIcon(APPS[1], true)}<div><strong>Schedule spreadsheet row</strong><br><small>Confirmed event reference</small></div>${badge(connectionStatus('google-sheets'))}</div><p class="hint">Your Calendar workshop and schedule row were linked explicitly. Account readiness is shown above; source calendar, workbook and tab names are not included in this saved summary.</p><div class="divider"></div><a class="button" href="#connections">Connections and event setup →</a><p class="hint">To change links, choose and confirm the records again in setup. Saved links are not automatically selected in that form.</p></article><article class="card setup-section"><div class="row"><h2>Change history</h2><span class="badge">${eventRuns.length} saved</span></div>${eventRuns.length ? eventRuns.slice(0, 5).map(run => `<div class="event-history-item"><div class="row"><strong>${format(run.createdAt || run.created, timeZone)}</strong>${badge(run.status)}</div><p class="hint">${esc(run.lastError || (run.status === 'verified' ? 'The approved steps were verified at execution time.' : 'Open Activity to follow the saved execution steps.'))}</p></div>`).join('') : '<p class="empty">No approved changes have been recorded for this event.</p>'}<a href="#activity" class="text-button">Open activity and receipts →</a></article></aside></div>`;
}
function eventsPage() { const filtered = state.events.filter(event => event.title.toLowerCase().includes(search.toLowerCase())); return `<div class="row intro"><div><div class="eyebrow">YOUR CONFIRMED RECORDS</div><h1>Start with the right workshop.</h1><p>Each event has explicit Calendar and spreadsheet links.</p></div><button data-action="go" data-page="connections">＋ Link an event</button></div><label class="skip-label" for="event-search">Find an event</label><input class="search" id="event-search" placeholder="Search your events" value="${esc(search)}"><div class="events" id="filtered-events" style="margin-top:20px">${state.events.length ? filtered.map(eventCard).join('') || '<div class="card empty">No events match that search.</div>' : emptyEvents()}</div>`; }
function selectOptions(items, selected, emptyLabel = 'Choose an option') { return `<option value="">${esc(emptyLabel)}</option>` + items.map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(selected) ? 'selected' : ''}>${esc(option.label)}</option>`).join(''); }
function picker(id, label, items, value, key, placeholder) { return `<label for="${id}">${label}</label><select id="${id}" data-wizard="${key}">${selectOptions(items, value, placeholder)}</select>`; }
function mappingsFor(kind) { const items = options[kind + 'Columns']; return items.length ? `<fieldset><legend>Confirm the ${kind === 'schedule' ? 'schedule' : kind === 'roster' ? 'participant roster' : 'volunteer assignment'} columns</legend><p class="hint">Match each field to a column from the tab you selected. These choices are saved with this event.</p><div class="mapping-grid">${columnFields[kind].map(([key, label]) => `<div><label for="mapping-${kind}-${key}">${label}</label><select id="mapping-${kind}-${key}" data-mapping-kind="${kind}" data-mapping-key="${key}">${selectOptions(items, wizard.mappings[kind][key] || '', 'Choose a column')}</select></div>`).join('')}</div></fieldset>` : ''; }
function connectionCard(app) {
  const status = connectionStatus(app.slug), blocked = ['paused', 'needs_attention'].includes(status), ready = !blocked && tokenCache.has(app.slug) && connectReady;
  return `<section class="card connection-card">${toolIcon(app)}<h2>${app.title}</h2>${badge(status)}<p>${app.description}</p>${blocked ? `<button data-action="go" data-page="settings">${status === 'paused' ? 'Manage paused access' : 'Check app access'} →</button>` : `<button class="${connected(app.slug) ? '' : 'primary'}" data-action="${connected(app.slug) ? 'refresh-state' : 'connect'}" data-app="${app.slug}" data-unready="${!ready}" ${!ready ? 'disabled' : ''}>${reloadBeforeRetry.has(app.slug) && !connected(app.slug) ? 'Reload and retry' : status === 'expired' ? 'Reconnect' : connected(app.slug) ? 'Check connection to' : 'Connect'} ${app.title}</button>`}<span class="connection-note ${!blocked && tokenErrors.has(app.slug) ? 'connection-error' : ''}">${blocked ? 'Review app access in Settings before using this connection.' : tokenErrors.has(app.slug) ? 'Connection setup unavailable. Retry preparation below.' : ready ? 'Sign-in opens with Google through viaSocket.' : 'Preparing secure connection…'}</span></section>`;
}
function connectionsPage() { return `<div class="intro"><div class="eyebrow">ONE-TIME EVENT SETUP</div><h1>Bring the right tools together.</h1><p>Connect your own Google accounts, then confirm which event and spreadsheet records belong together.</p></div>${setupSavePanel()}<div class="stats connection-grid" id="setup-accounts">${APPS.map(connectionCard).join('')}</div><button class="text-button" data-action="prepare-connections">Refresh connection preparation</button><p class="hint">Account access and app connections are separate. Only the selected records are used for this workflow.</p><section class="card setup-section"><h2 id="setup-calendar"><span class="stage-label">1</span> Choose your Calendar workshop</h2><div class="setup-two"><div class="picker-group"><h3>Your calendar</h3><p class="hint">Choose the calendar once. You can correct this mapping by linking the event again.</p><button data-action="load-options" data-kind="calendars">Load connected calendars</button>${picker('calendar-choice', 'Calendar', options.calendars, wizard.calendarChoice, 'calendarChoice', 'Choose a calendar')}</div><div class="picker-group"><h3>The workshop to link</h3><button data-action="load-options" data-kind="calendarEvents" ${!wizard.calendarChoice ? 'disabled' : ''}>Load workshops</button>${picker('calendar-event-choice', 'Calendar workshop', options.calendarEvents, wizard.calendarEventChoice, 'calendarEventChoice', 'Choose a workshop')}</div></div></section><section class="card setup-section"><h2 id="setup-schedule"><span class="stage-label">2</span> Link the schedule spreadsheet</h2><div class="setup-two"><div class="picker-group"><h3>Your spreadsheet</h3><button data-action="load-options" data-kind="spreadsheets">Load connected spreadsheets</button>${picker('spreadsheet-choice', 'Spreadsheet', options.spreadsheets, wizard.spreadsheetChoice, 'spreadsheetChoice', 'Choose a spreadsheet')}<button data-action="load-options" data-kind="tabs" ${!wizard.spreadsheetChoice ? 'disabled' : ''}>Load spreadsheet tabs</button></div><div class="picker-group"><h3>The event schedule</h3>${picker('schedule-tab-choice', 'Schedule tab', options.tabs, wizard.scheduleTabChoice, 'scheduleTabChoice', 'Choose the schedule tab')}<button data-action="load-options" data-kind="scheduleColumns" ${!wizard.scheduleTabChoice ? 'disabled' : ''}>Load schedule columns</button><button data-action="load-options" data-kind="scheduleRows" ${!wizard.scheduleTabChoice ? 'disabled' : ''}>Load event rows</button>${picker('schedule-row-choice', 'Matching workshop row', options.scheduleRows, wizard.scheduleRowChoice, 'scheduleRowChoice', 'Choose the matching event row')}</div></div>${mappingsFor('schedule')}<p class="hint">The event reference column is used to find this row again after sorting. A row number alone is not a reliable link.</p></section><section class="card setup-section"><h2 id="setup-people"><span class="stage-label">3</span> Add the people and assignments</h2><div class="setup-two"><div class="picker-group"><h3>Participant roster <span class="meta">· optional</span></h3><p class="hint">A linked roster is needed before participant announcements can be approved.</p>${picker('roster-tab-choice', 'Roster tab', options.tabs, wizard.rosterTabChoice, 'rosterTabChoice', 'No roster linked')}<button data-action="load-options" data-kind="rosterColumns" ${!wizard.rosterTabChoice ? 'disabled' : ''}>Load roster columns</button>${mappingsFor('roster')}</div><div class="picker-group"><h3>Volunteer assignments <span class="meta">· optional</span></h3><p class="hint">Only recorded assignments are checked. Private availability is not inferred.</p>${picker('assignments-tab-choice', 'Assignments tab', options.tabs, wizard.assignmentsTabChoice, 'assignmentsTabChoice', 'No assignment tab linked')}<button data-action="load-options" data-kind="assignmentsColumns" ${!wizard.assignmentsTabChoice ? 'disabled' : ''}>Load assignment columns</button>${mappingsFor('assignments')}</div></div><div class="notice success">Review the selected workshop, matching event row, and column mappings before saving. Your Google records are not changed during linking.</div><div class="form-actions"><p class="hint">Mappings stay private to your signed-in workspace.</p><button class="primary" data-action="save-mapping">Confirm and link this event →</button></div></section>`; }

function participantsFor(event) { return Array.isArray(event?.participants) ? event.participants : []; }
function aiAssistant(draft, event) {
  const feedback = aiFeedback.get(event.id);
  return `<details class="ai-assist" ${draft.aiRequest || feedback ? 'open' : ''}><summary>Describe the change · optional AI help</summary><label for="ai-change-request">What would you like to change?</label><textarea id="ai-change-request" name="aiRequest" maxlength="1500" rows="3" placeholder="Move this workshop tomorrow to 4 pm and prepare a message.">${esc(draft.aiRequest || '')}</textarea><div class="row"><button type="button" data-action="fill-ai">Fill draft with AI</button><span class="hint">Suggestion only · never executes a change</span></div><p class="hint">AI can fill the time and announcement draft. Review the fields below, choose recipients yourself, then create a fresh preview. The normal form works without AI.</p>${feedback ? `<div class="notice ${feedback.status === 'ready' ? 'success' : ''}" role="status">${esc(feedback.message)}${feedback.warnings?.length ? `<ul>${feedback.warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}</div>` : ''}</details>`;
}
function changePage() {
  const event = eventById(), draft = draftFor(event), participants = participantsFor(event);
  return `<div class="step-pill">Step 1 of 2 · Plan a change</div><h1>What’s changing?</h1><p>Choose the new local start time. The event’s duration is preserved.</p><div class="grid"><form id="live-change-form" class="card"><label for="change-event">Choose your workshop</label><select id="change-event">${selectOptions(state.events.map(item => ({ value: item.id, label: item.title })), selectedEvent, 'Choose a linked workshop')}</select>${event ? `<div class="notice success">Current: ${format(scheduleStart(event), zone(event))} – ${format(scheduleEnd(event), zone(event), true)}<br>Event timezone: <strong>${esc(zone(event))}</strong></div>${aiAssistant(draft, event)}<label for="new-local-time">New local date and time · ${esc(zone(event))}</label><input id="new-local-time" name="local" required type="datetime-local" step="60" value="${esc(draft.local)}"><div id="time-resolution" class="field-error" role="status"></div><div id="time-offset-choice" class="offset-select" hidden></div><label class="check"><input type="checkbox" id="notify-people" name="notify" ${draft.notify ? 'checked' : ''}>Prepare a Gmail announcement for selected people</label><div id="notification-fields" ${draft.notify ? '' : 'hidden'}><div class="notice">Calendar invitation emails will be suppressed. Gmail messages are sent individually after both schedule updates are verified.</div><label for="sender">Send from</label><select id="sender" name="from">${selectOptions(options.senders, draft.from, 'Choose a connected sender')}</select><button type="button" class="text-button" data-action="load-senders">Refresh connected senders</button><label for="message-subject">Announcement subject</label><input id="message-subject" name="subject" maxlength="800" value="${esc(draft.subject)}"><label for="message-body">Your editable announcement</label><textarea id="message-body" name="messageBody" maxlength="10000">${esc(draft.messageBody)}</textarea><p class="hint">Include the new date, time, timezone and location in your message. A unique change receipt reference will appear in the saved preview.</p><fieldset><legend>Who should receive it?</legend><button type="button" class="text-button" data-action="refresh-roster">Refresh linked roster</button>${participants.length ? participants.map(person => `<label class="check person"><input type="checkbox" name="recipient" value="${esc(person.email)}" ${draft.recipients.includes(person.email) ? 'checked' : ''}><span><strong>${esc(person.name)}</strong> <span class="meta">${esc(person.role)}</span><small>${esc(person.email)}</small></span></label>`).join('') : '<div class="notice">No participant roster is available for this event. Link or refresh its roster before choosing an announcement.</div>'}</fieldset></div><div class="divider"></div><div class="form-actions"><span class="hint">Nothing changes before approval.</span><button class="primary" type="submit">See what changes →</button></div>` : '<div class="empty">Choose a workshop to prepare its change.</div>'}</form><aside class="card" style="align-self:start"><div class="eyebrow">THE DETAILS TRAVEL TOGETHER</div><h2>Review first. Then relay.</h2><p>A clear before-and-after view shows the exact schedule, linked records, people, and known conflicts.</p><div class="divider"></div><h3>Checks use confirmed data</h3><p class="hint">Only your connected calendar and linked assignments can be checked. Other calendars and participant availability remain unknown.</p><h3>Precise time, wherever you are</h3><p class="hint">The date and time are interpreted in the workshop’s named timezone, independently of your computer’s timezone. Ambiguous daylight-saving times require a specific choice.</p><span class="badge">Approval applies to one exact version</span></aside></div>`;
}

function impactDescription(plan, kind) {
  const snap = plan.snapshot, target = `${format(snap.target.start, snap.timezone)} – ${format(snap.target.end, snap.timezone, true)} (${snap.timezone})`;
  return ({ calendar: `Calendar: change the selected workshop’s start and end to ${target}. Invitation update emails are suppressed.`, sheets: `Schedule spreadsheet: find the confirmed event reference and update only its start and end fields to ${target}, then read the row back.`, people: snap.notify ? `Send the exact saved announcement individually to ${snap.notifications.length} selected ${snap.notifications.length === 1 ? 'person' : 'people'}, after Calendar and Sheets are verified.` : 'No participant announcement is included in this approved change.', volunteers: 'Known volunteer overlaps are listed below. Assignment times are available for coordination and are not changed by this event reschedule.' })[kind];
}
function previewPage() {
  const plan = planById();
  if (!plan) return `<div class="card empty-large"><h1>Start with a saved proposal.</h1><p>Choose a workshop and prepare its exact change before approving.</p><button class="primary" data-action="go" data-page="events">Choose a workshop</button></div>`;
  const snap = plan.snapshot;
  return `<div class="row intro"><div><div class="step-pill">Step 2 of 2 · Review and approve</div><h1>A change with the full picture.</h1><p>Review this exact schedule, announcement, and recipient list.</p></div><button data-action="edit-plan" data-plan="${esc(plan.id)}">Edit proposal</button></div><div class="grid"><section><div class="card schedule-comparison"><div><div class="eyebrow">BEFORE</div><h3>${format(snap.calendarBefore.start, snap.timezone)}</h3><span class="meta">Ends ${format(snap.calendarBefore.end, snap.timezone, true)}</span></div><span aria-hidden="true">→</span><div class="after"><div class="eyebrow">PROPOSED</div><h3>${format(snap.target.start, snap.timezone)}</h3><span class="meta">Ends ${format(snap.target.end, snap.timezone, true)}</span></div></div>${secondarySchedule(snap.target.start, snap.target.end, snap.timezone)}<p class="hint">${esc(snap.timezone)} · duration preserved · exact saved version ${esc(plan.version)}</p><div class="row section-head" style="margin-top:25px"><h2>Your Impact Map</h2><button class="text-button" data-action="toggle-map">${mapMode === 'map' ? 'Use list view' : 'Use map view'}</button></div><div class="${mapMode === 'map' ? 'impact-map' : 'impact-list'}" aria-label="Connected records affected by this change">${mapMode === 'map' ? `<div class="impact-hub"><h3>↗ &nbsp; ${esc(snap.title)}</h3><small>${format(snap.target.start, snap.timezone)} · ${esc(snap.timezone)}</small></div>` : ''}${[['calendar', 'Calendar', 'Change and verify event times'], ['sheets', 'Schedule spreadsheet', 'Find the stable event reference'], ['people', 'Participants', snap.notify ? `${snap.notifications.length} individual announcements` : 'Announcement not included'], ['volunteers', 'Volunteer assignments', snap.conflicts.some(item => item.kind === 'volunteer-overlap') ? 'Recorded overlap found' : 'Review recorded assignments']].map(([kind, title, description]) => `<button class="impact-card" data-action="inspect" data-impact="${kind}" aria-pressed="${impact === kind}">${kind === 'calendar' ? toolIcon(APPS[0]) : kind === 'sheets' ? toolIcon(APPS[1]) : `<span class="tool-icon" aria-hidden="true">${kind === 'people' ? '◎' : '◇'}</span>`}<span><strong>${title}</strong><span class="meta">${esc(description)}</span></span></button>`).join('')}</div><div class="notice success impact-detail" id="impact-detail" aria-live="polite">${esc(impactDescription(plan, impact))}</div>${snap.conflicts.length ? `<div class="notice"><strong>Review these known conflicts</strong>${snap.conflicts.map(conflict => `<p>${esc(conflict.message || (conflict.kind === 'volunteer-overlap' ? conflict.name + ' has another recorded assignment' : conflict.title || 'A connected calendar event overlaps'))}${conflict.start ? '<br>' + format(conflict.start, snap.timezone) + ' – ' + format(conflict.end, snap.timezone, true) : ''}</p>`).join('')}<label class="check"><input id="acknowledge-conflicts" type="checkbox" ${acknowledged ? 'checked' : ''}>I have reviewed these warnings and will coordinate any required coverage.</label></div>` : '<div class="notice success">No overlap was found in the connected records checked for this preview.</div>'}<details open><summary>Availability and checks</summary><ul>${snap.unavailableChecks.map(check => `<li>${esc(check)}</li>`).join('')}</ul></details></section><aside class="card" style="align-self:start"><div class="eyebrow">THE EXACT APPROVED COMMUNICATION</div><h2>${snap.notify ? 'Announcement preview' : 'Schedule updates only'}</h2>${snap.notify ? `<pre class="message-preview">${esc(snap.notifications[0]?.messageBody)}</pre><h3>Selected recipients · ${snap.notifications.length}</h3>${snap.notifications.map(notification => `<details><summary>${esc(notification.recipient)}</summary><p class="subject-line"><strong>From:</strong> ${esc(notification.from)}<br><strong>Subject:</strong> ${esc(notification.subject)}</p></details>`).join('')}<p class="hint">Sent individually. No roster is shared in recipient headers. “Sent” does not mean read or acknowledged.</p>` : '<p>The Calendar event and linked schedule row will change. No Gmail announcement is part of this plan.</p>'}<div class="divider"></div><h3>Execution order</h3><p class="hint">1. Check the saved source versions<br>2. Update and verify Calendar<br>3. Update and verify the schedule row<br>${snap.notify ? '4. Send and verify the approved messages' : '4. Save the change receipt'}</p><p class="hint">Calendar invitation emails: off. Connected updates happen in steps and may need recovery if one fails.</p>${plan.superseded ? `<div class="notice">${plan.stopped ? 'This update was stopped before dispatch. Review the current records and prepare a fresh proposal.' : 'This proposal was edited. Review its newest version before approving.'}</div>` : `<button class="primary" data-action="approve-plan" data-plan="${esc(plan.id)}" style="width:100%">Approve this exact change →</button>`}<p class="hint">Editing creates a new review and invalidates this approval.</p></aside></div>`;
}
function activityPage() {
  return `<div class="row intro"><div><div class="eyebrow">A CLEAR TRAIL FOR EVERY CHANGE</div><h1>Know what moved. And what didn’t.</h1><p>Saved progress survives page closure. Recovery checks unfinished work before taking action.</p></div><button data-action="refresh-state">Refresh status ↻</button></div>${state.runs.length ? state.runs.map(run => `<article class="card run-card"><div class="row"><div><div class="eyebrow">CHANGE RECEIPT · ${esc(run.id.slice(0, 8))}</div><h2>${esc(titleOfRun(run))}</h2><p class="hint">${format(run.createdAt || run.created, zone(eventById(run.eventId)))}</p></div>${badge(run.status)}</div><div class="steps">${(run.steps || []).map((step, index) => `<div class="step activity-step"><span class="avatar">${index + 1}</span><div class="step-body"><strong>${({ calendar: 'Calendar', sheets: 'Schedule spreadsheet', gmail: 'Participant announcements' })[step.kind] || esc(step.kind)}</strong><p>${esc(run.status === 'cancelled' && !step.attempts ? 'Plan stopped before updates.' : step.summary || 'Waiting to run.')}</p>${step.verification?.outcomes ? `<span class="meta">${step.verification.outcomes.filter(outcome => outcome.status === 'sent').length} sent · acknowledgement not checked</span>` : ''}</div>${badge(run.status === 'cancelled' && !step.attempts ? 'cancelled' : step.status, run.status === 'cancelled' && !step.attempts ? 'Not attempted' : undefined)}</div>`).join('')}</div>${run.lastError ? `<div class="notice">${esc(run.lastError)}</div>` : ''}<div class="row"><span class="hint">Verified steps are preserved. Uncertain Gmail results are reconciled before any resend.</span><div class="row">${attention(run.status) ? `<button class="primary" data-action="recover-run" data-run="${esc(run.id)}">Check and recover unfinished steps ↻</button>` : ''}${run.status === 'cancelled' ? `<button class="primary" data-action="plan-event" data-event="${esc(run.eventId)}">Prepare a fresh review →</button>` : ''}<button data-action="receipt" data-run="${esc(run.id)}">Download receipt ↓</button></div></div></article>`).join('') : `<div class="card empty-large"><div class="empty-symbol">↺</div><h2>Your next change starts here.</h2><p>Reviewed changes and verified execution steps will appear here.</p><button class="primary" data-action="go" data-page="events">Choose a workshop</button></div>`}`;
}
function connectionAccessControls() {
  return `<div class="privacy-connections">${APPS.map(app => {
    const record = connectionFor(app.slug), status = connectionStatus(app.slug), desired = record?.desiredPaused;
    let action = '';
    if (status === 'connected' || status === 'paused') action = `<button type="button" data-action="connection-access" data-app="${app.slug}" data-paused="${status === 'connected'}">${status === 'connected' ? 'Pause app access' : 'Resume app access'}</button>`;
    else if (status === 'needs_attention' && typeof desired === 'boolean') action = `<button type="button" data-action="connection-access" data-app="${app.slug}" data-paused="${desired}">Check ${desired ? 'pause' : 'resume'} status</button>`;
    else action = '<a class="text-button" href="#connections">Manage connection →</a>';
    return `<div class="privacy-connection"><div class="row">${toolIcon(app, true)}<strong>${app.title}</strong>${badge(status)}</div>${action}${connectionAccessNotices.has(app.slug) ? `<p class="hint" role="status">${esc(connectionAccessNotices.get(app.slug))}</p>` : status === 'paused' ? '<p class="hint">ChangeRelay access is paused. Your Google permission remains in place.</p>' : ''}</div>`;
  }).join('')}</div>`;
}
function privacyControls() {
  return `<article class="card setup-section"><h2>Privacy and account controls</h2><p class="hint">Your approval identifies the linked records and exact communication. Participant addresses are not shared in recipient headers. Setup drafts store record and column names; connection secrets stay on the server.</p><h3>Pause or resume app access</h3><p class="hint">Pause blocks ChangeRelay’s enabled actions for that app. It does not revoke Google permission or erase connected records. Changing app access makes previous reviews out of date; prepare a fresh review before approving a change.</p><button class="text-button" type="button" data-action="refresh-state">Refresh saved app access status ↻</button>${connectionAccessControls()}<h3>Google permissions</h3><p class="hint">Signing out ends this app session. It does not revoke Google permissions. Manage granted access in your Google account. Removing viaSocket’s Google access can affect Calendar, Sheets and Gmail together.</p><a class="button external-permissions" href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Manage Google permissions ↗ <span class="hint">opens Google in a new tab</span></a><p class="hint">This workspace does not delete your sign-in account. Google permission changes are separate from clearing saved ChangeRelay data.</p><details class="clear-data-details"><summary>Clear saved event data</summary><p>This removes this workspace’s saved event links, mappings, plans, execution history, setup and preferences in ChangeRelay.</p><p>Your login, app connections and original Google Calendar, Sheets and Gmail records stay in place. Clearing saved data does not undo Google edits or recall messages already sent.</p><p class="hint">Download any receipts you want to keep from Activity before clearing them. Cleared ChangeRelay history cannot be restored here. Finish or check unfinished work in Activity before clearing it.</p><form id="live-clear-data-form"><label for="clear-data-confirmation">Type <strong>CLEAR EVENT DATA</strong> to confirm</label><input id="clear-data-confirmation" name="confirmation" type="text" autocomplete="off" spellcheck="false" maxlength="40" aria-describedby="clear-data-help" required><p class="hint" id="clear-data-help">Only the button below sends this request. Opening this section or typing does not clear anything.</p><button class="danger-button" id="clear-event-data-button" type="submit" disabled>Clear saved event data</button></form></details><h3>Sample workspace</h3><p class="hint">Sample records stay separate from this signed-in workspace.</p><a href="/#dashboard" class="text-button">Open sample workspace ↗</a></article>`;
}
function liveStateResponse(value) { return value && Array.isArray(value.events) && Array.isArray(value.plans) && Array.isArray(value.runs) && value.workspace; }
function clearPrivateBrowserDrafts() {
  draftMemory.clear(); invalidatedPlanIds.clear(); aiFeedback.clear(); activePlan = null; selectedEvent = ''; acknowledged = false;
  try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith('changerelay-live-draft-') || key?.startsWith('changerelay-live-invalid-plan-') || key?.startsWith('changerelay-live-setup-')) sessionStorage.removeItem(key); } } catch {}
}
async function clearEventData() {
  const phrase = document.querySelector('#live-clear-data-form')?.querySelector('#clear-data-confirmation')?.value;
  if (phrase !== 'CLEAR EVENT DATA') throw new Error('Type CLEAR EVENT DATA exactly before clearing saved event data.');
  // Let any earlier autosave settle before the server clears its saved setup.
  clearTimeout(setupSaveTimer); await setupSaveChain.catch(() => {});
  const result = await api('live/clear-event-data', { confirmation: phrase });
  if (result?.cleared !== true) throw new Error('Saved data was not confirmed cleared. Your workspace is still shown.');
  clearPrivateBrowserDrafts(); setupRevision++; setupInitialized = false; setupDirty = false; setupLabels = safeSetupLabels(null); setupResumeIssues = []; reloadSetupDraft = null; setupSaveChain = Promise.resolve(); resetWizardChoices();
  acceptState(liveStateResponse(result.state) ? result.state : { ...state, events: [], plans: [], runs: [], setup: null });
  go('settings'); notify(result.message || 'Saved event data cleared. Your login, app connections and original Google records remain in place.');
}
function updateClearDataConfirmation() { const field = document.querySelector('#clear-data-confirmation'), button = document.querySelector('#clear-event-data-button'); if (button) { const allowed = field?.value === 'CLEAR EVENT DATA'; button.dataset.baseDisabled = String(!allowed); button.disabled = busy || !allowed; } }
async function changeConnectionAccess(app, paused) {
  if (!APPS.some(item => item.slug === app) || typeof paused !== 'boolean') throw new Error('Choose a supported app access control.');
  const existing = connectionFor(app);
  if (!existing) throw new Error('Connect this app before managing its access.');
  if (existing.status === 'needs_attention' && typeof existing.desiredPaused === 'boolean' && existing.desiredPaused !== paused) throw new Error('Check the previous app access request before choosing the opposite state.');
  tokenCache.delete(app); tokenErrors.delete(app);
  for (const plan of state.plans) { invalidatedPlanIds.add(plan.id); try { sessionStorage.setItem('changerelay-live-invalid-plan-' + plan.id, '1'); } catch {} }
  try {
    const result = await api('live/connection-state', { app, paused });
    if (typeof result?.verified !== 'boolean' || !liveStateResponse(result.state)) throw new Error('The app access result could not be verified.');
    acceptState(result.state); if (!result.verified) { const record = connectionFor(app); if (record) { record.status = 'needs_attention'; record.desiredPaused = paused; } } if (activePlan && !state.plans.some(plan => plan.id === activePlan.id)) activePlan = null;
    connectionAccessNotices.set(app, result.message || (result.verified ? paused ? 'App access is paused.' : 'App access is resumed.' : 'The result needs checking. Access remains blocked until it is verified.'));
    preparationStarted = false; render(); notify(connectionAccessNotices.get(app));
  } catch (error) {
    const record = connectionFor(app); if (record) { record.status = 'needs_attention'; record.desiredPaused = paused; }
    connectionAccessNotices.set(app, 'App access needs checking. Use the status button to verify the same request.');
    render(); throw error;
  }
}
function settingsPage() {
  const saved = preferences(), zones = [...new Set([saved.displayTimezone, 'UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'])];
  return `<div class="eyebrow">YOUR WORKSPACE</div><h1>Make this workspace yours.</h1><p>Choose useful defaults, manage your session, and find a clear guide to each step.</p><div class="grid"><section><article class="card"><h2>Display and draft preferences</h2><form id="live-preferences-form"><label for="display-timezone">Your display timezone</label><input id="display-timezone" name="displayTimezone" value="${esc(saved.displayTimezone)}" list="timezone-suggestions" maxlength="100" required autocomplete="off" spellcheck="false" aria-describedby="display-timezone-help"><datalist id="timezone-suggestions">${zones.map(timeZone => `<option value="${esc(timeZone)}"></option>`).join('')}</datalist><p class="hint" id="display-timezone-help">Use a timezone such as Asia/Kolkata or America/New_York. Event cards, details and reviews show this as an additional time. The event’s named timezone still controls its schedule and change form.</p><label class="check preference-toggle"><input type="checkbox" id="notifications-default" name="notificationsDefault" ${saved.notificationsDefault ? 'checked' : ''}><span>Include an announcement in new change drafts</span></label><p class="hint">New drafts only. You still choose a sender and recipients, review the exact message, and approve before anything is sent. Existing drafts and saved approvals keep their original choices.</p><button class="primary" type="submit">Save preferences →</button></form></article><article class="card setup-section"><h2>Your organiser account</h2><p>${esc(user.email)}</p><p class="hint">Saved setup names, preferences, confirmed event links and change receipts belong to this signed-in workspace.</p><button data-action="sign-out">Sign out</button><div class="divider"></div><h3>Connected accounts</h3><p class="hint">Google accounts are connected through viaSocket. Connections are checked before the selected records are used.</p><button data-action="go" data-page="connections">Connections and saved setup →</button></article></section><aside><article class="card"><h2>A little help, at every step.</h2><div class="help-steps"><details open><summary>1. Connect your tools</summary><p>Use Connect for Calendar, Sheets and Gmail, and finish the separate Google approval window. Signing into ChangeRelay alone does not connect your Google apps. If a window stalls, Stop waiting releases this screen; it does not revoke a permission you granted.</p></details><details><summary>2. Link the right records</summary><p>Choose your Calendar workshop, its matching spreadsheet row, and each column explicitly. Add the participant and volunteer tabs when available. Saved setup remembers names so you can return later; resume checks fresh choices and asks you again when a name is missing or ambiguous.</p></details><details><summary>3. Prepare and review</summary><p>Enter the new time in the event’s timezone. AI help only fills an editable draft. Preview rechecks the linked records and shows the exact schedule, selected recipients, message and known conflicts. Availability that was not checked is stated clearly.</p></details><details><summary>4. Approve the exact change</summary><p>Approval applies to one saved version. Calendar and the schedule row are updated and read back before an included announcement can be sent. Calendar invitation emails are off. Messages go individually to the selected recipients; Sent does not mean read or acknowledged.</p></details><details><summary>5. Follow progress and recover</summary><p>Activity keeps the receipt and verified steps. If an update needs checking, use recovery to inspect unfinished work; uncertain message results are checked before any resend. A plan stopped before dispatch needs a fresh review of the current records.</p></details></div></article>${privacyControls()}</aside></div>`;
}
function render() { if (!state || !user) return; root.innerHTML = shell(({ overview, events: eventsPage, event: eventDetailsPage, connections: connectionsPage, change: changePage, preview: previewPage, activity: activityPage, settings: settingsPage })[route.page]()); root.querySelectorAll('button').forEach(button => { button.dataset.baseDisabled = String(button.disabled); }); setBusy(busy); if (route.page === 'connections' && !preparationStarted) { preparationStarted = true; void prepareConnections(); } }

async function prepareConnections() {
  if (preparationRunning) return; preparationStarted = true; preparationRunning = true;
  try { await loadConnectScript(); connectReady = true; } catch { connectReady = false; preparationRunning = false; APPS.forEach(app => tokenErrors.set(app.slug, true)); if (route.page === 'connections') render(); return; }
  await Promise.allSettled(APPS.map(async app => { if (['paused', 'needs_attention'].includes(connectionStatus(app.slug))) { tokenCache.delete(app.slug); tokenErrors.delete(app.slug); return; } try { const prepared = await api('live/token', { app: app.slug }); if (!prepared.token || !prepared.serviceId) throw new Error('Connection preparation is unavailable.'); tokenCache.set(app.slug, prepared); tokenErrors.delete(app.slug); } catch { tokenErrors.set(app.slug, true); tokenCache.delete(app.slug); } }));
  preparationRunning = false; if (route.page === 'connections') render();
}
function preserveSetupBeforeReload() {
  try { sessionStorage.setItem('changerelay-live-setup-' + user.id, JSON.stringify({ version: 1, ownerId: user.id, savedAt: Date.now(), onboarding: safeSetupLabels(setupLabels) })); } catch { /* Already saved event mappings remain on the server. */ }
}
function restoreSetupAfterReload() {
  const key = 'changerelay-live-setup-' + user.id;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); sessionStorage.removeItem(key);
    if (!saved || saved.version !== 1 || saved.ownerId !== user.id || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > 3600000) return;
    reloadSetupDraft = { savedAt: saved.savedAt, onboarding: safeSetupLabels(saved.onboarding) };
  } catch { /* Expired or unreadable setup choices are left empty, never guessed. */ }
}
function reloadConnectionSetup() { preserveSetupBeforeReload(); location.reload(); }
function ownsWaitingScreen(operation) { return connectOperation?.id === operation.id && operation.waiting; }
function stopConnectionWait(operation = connectOperation, timedOut = false) {
  if (!operation || !ownsWaitingScreen(operation)) return;
  operation.waiting = false; operation.stopped = true; clearTimeout(operation.timer); reloadBeforeRetry.add(operation.app);
  const title = APPS.find(app => app.slug === operation.app)?.title || 'the account';
  connectionNotice = timedOut ? `${title} has not returned a result after a minute. Check for a separate Google sign-in window. You can continue here; reload connection setup before trying this app again.` : `Stopped waiting for ${title}. This does not revoke any permission you may have granted. If sign-in finishes later, its result is verified before saving. Reload setup before trying this app again.`;
  setBusy(false); render(); operation.releaseWait();
}
function finishConnectionWait(operation, message = '') {
  clearTimeout(operation.timer);
  if (!ownsWaitingScreen(operation)) return;
  operation.waiting = false; connectionNotice = message; setBusy(false); render(); operation.releaseWait();
}
async function saveOperationConnection(operation, authId) {
  if (operation.delivery) return operation.delivery;
  operation.delivery = (async () => {
    // A cancelled popup may finish later. Only the same still-authenticated organiser can save it.
    const account = await api('auth/me');
    if (account.user?.id !== operation.ownerId || user?.id !== operation.ownerId) {
      finishConnectionWait(operation, 'Your account session changed. Sign in again before saving this connection.'); return false;
    }
    if ((latestConnectByApp.get(operation.app)?.id || 0) > operation.id) return false;
    await api('live/connected', { app: operation.app, authId });
    operation.saved = true; reloadBeforeRetry.delete(operation.app); tokenCache.delete(operation.app);
    await refreshState({ renderPage: false });
    if (ownsWaitingScreen(operation)) finishConnectionWait(operation);
    else if (!busy) render();
    // Never let an older callback replace or unlock the screen for a newer account attempt.
    if (!connectOperation?.waiting || connectOperation.id === operation.id) void prepareConnections();
    notify('The account connection was verified and saved.');
    return true;
  })();
  return operation.delivery;
}
async function connectNow(app) {
  if (busy) return;
  if (['paused', 'needs_attention'].includes(connectionStatus(app))) { notify('Review this app’s access in Settings before using its connection.'); return; }
  if (reloadBeforeRetry.has(app) && !connected(app)) { reloadConnectionSetup(); return; }
  const prepared = tokenCache.get(app); if (!prepared || !connectReady) { notify('Prepare the secure connection first, then try again.'); return; }
  if (!user?.id) { notify('Sign in again before connecting an account.'); return; }
  const operation = { id: ++connectSequence, app, ownerId: user.id, waiting: true, stopped: false, saved: false };
  const released = new Promise(resolve => { operation.releaseWait = resolve; });
  connectOperation = operation; latestConnectByApp.set(app, operation); connectionNotice = '';
  // connect() is called directly from the click before any await, so its popup is a user gesture.
  const connection = connect({ embedToken: prepared.token, serviceId: prepared.serviceId, actions: prepared.actions, skipActionSelection: true, ...(prepared.reconnectAuthId ? { authId: prepared.reconnectAuthId } : {}), onLateSuccess: ({ authId }) => { saveOperationConnection(operation, authId).catch(() => { if (ownsWaitingScreen(operation)) finishConnectionWait(operation, 'Sign-in finished, but the connection could not be saved. Refresh its status before retrying.'); else if (!busy) notify('An earlier sign-in finished, but its connection could not be saved. Refresh the connection status.'); }); } });
  operation.timer = setTimeout(() => stopConnectionWait(operation, true), 60000);
  setBusy(true, 'Waiting for your account approval…'); render();
  const settled = (async () => {
    try { const result = await connection; await saveOperationConnection(operation, result.authId); }
    catch (error) {
      if (error.code === 'closed') reloadBeforeRetry.add(app);
      if (ownsWaitingScreen(operation)) finishConnectionWait(operation, error.code === 'closed' ? 'The sign-in window may have closed. If it finishes later, the connection is still verified before saving. Reload setup before trying this app again.' : 'The account could not be connected. Check the Google sign-in window and try again.');
    } finally { if (ownsWaitingScreen(operation)) finishConnectionWait(operation); }
  })();
  await Promise.race([settled, released]);
}
async function loadOptions(kind, { quiet = false } = {}) {
  const payload = { kind };
  let target = kind;
  if (kind === 'calendarEvents') { if (!wizard.calendarChoice) throw new Error('Choose a calendar first.'); payload.calendarChoice = wizard.calendarChoice; }
  if (kind === 'tabs') { if (!wizard.spreadsheetChoice) throw new Error('Choose a spreadsheet first.'); payload.spreadsheetChoice = wizard.spreadsheetChoice; }
  if (['scheduleColumns', 'rosterColumns', 'assignmentsColumns'].includes(kind)) { const role = kind.replace('Columns', ''); payload.kind = 'columns'; payload.tabChoice = wizard[role + 'TabChoice']; if (!payload.tabChoice) throw new Error('Choose the tab before loading its columns.'); }
  if (kind === 'scheduleRows') { if (!wizard.scheduleTabChoice) throw new Error('Choose the schedule tab first.'); payload.tabChoice = wizard.scheduleTabChoice; }
  const result = await api('live/options', payload); if (!Array.isArray(result.options)) throw new Error('No readable choices were returned. Try reconnecting this account.');
  options[target] = result.options; if (!quiet) render();
  if (!quiet && !result.options.length) notify('No matching choices were returned. Check the selected account and its access.');
  else if (result.more) { if (quiet) setupResumeIssues.push('One fresh picker list is limited. Choose again if the saved record is not shown.'); else notify('This list is limited. Narrow the source if the record you need is not shown.'); }
}
function mappingReady(kind) { return columnFields[kind].every(([key]) => wizard.mappings[kind][key]); }
async function saveMapping() {
  for (const key of ['calendarChoice', 'calendarEventChoice', 'spreadsheetChoice', 'scheduleTabChoice', 'scheduleRowChoice']) if (!wizard[key]) throw new Error('Choose the Calendar workshop and its matching schedule spreadsheet row first.');
  if (!mappingReady('schedule') || (wizard.rosterTabChoice && !mappingReady('roster')) || (wizard.assignmentsTabChoice && !mappingReady('assignments'))) throw new Error('Confirm every column mapping for the tabs you selected.');
  const result = await api('live/map', { ...wizard, mappings: structuredClone(wizard.mappings) });
  clearTimeout(setupSaveTimer); setupRevision++; setupLabels = safeSetupLabels(null); setupResumeIssues = []; resetWizardChoices();
  let cleared = true; try { await persistSetupDraft({ clear: true }); } catch { cleared = false; setupLabels = safeSetupLabels(state.setup?.onboarding); }
  await refreshState({ renderPage: false }); selectedEvent = result.event?.id || result.eventId || result.id || ''; go('events'); notify(cleared ? 'The event and record mappings are confirmed. You can now prepare a change.' : 'The event is linked. The unfinished setup draft could not be cleared; you can clear it in Connections.');
}
async function loadSenders() { const result = await api('live/options', { kind: 'senders' }); options.senders = result.options || []; render(); }
function readDraft() {
  const event = eventById(), form = document.querySelector('#live-change-form'); if (!event || !form) return null;
  const before = draftFor(event), enteredBody = form.querySelector('#message-body')?.value ?? before.messageBody;
  const draft = { ...before, local: form.querySelector('#new-local-time')?.value || '', notify: !!form.querySelector('#notify-people')?.checked, from: form.querySelector('#sender')?.value || '', subject: form.querySelector('#message-subject')?.value || '', messageBody: enteredBody, autoGenerated: before.autoGenerated === true && enteredBody === before.messageBody, recipients: [...form.querySelectorAll('[name="recipient"]:checked')].map(input => input.value), instantChoice: form.querySelector('#exact-offset')?.value || before.instantChoice || '', aiRequest: form.querySelector('#ai-change-request')?.value ?? before.aiRequest ?? '' };
  if (draft.autoGenerated) { draft.messageBody = generatedAnnouncement(event, draft.local, draft.instantChoice); const field = form.querySelector('#message-body'); if (field && field.value !== draft.messageBody) field.value = draft.messageBody; }
  saveDraft(event.id, draft); return draft;
}
function checkAIResult(result, timeZone) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !['ready', 'clarification', 'unavailable'].includes(result.status)) throw new Error('AI returned an unreadable suggestion. Your existing draft is unchanged; use the normal form.');
  const warnings = result.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.length > 8 || warnings.some(warning => typeof warning !== 'string' || warning.length > 1500)) throw new Error('AI returned invalid warning details. Your existing draft is unchanged.');
  if (result.status === 'unavailable') return { status: 'unavailable', message: typeof result.question === 'string' && result.question.trim() && result.question.length <= 2000 ? result.question : 'AI could not prepare a reliable suggestion. Your draft is unchanged; use the normal form to continue.', warnings };
  if (result.status === 'clarification') {
    if (typeof result.question !== 'string' || !result.question.trim() || result.question.length > 2000) throw new Error('AI could not provide a clear question. Your existing draft is unchanged; choose the exact time below.');
    return { status: result.status, message: result.question, warnings };
  }
  const patch = {};
  if (result.local !== undefined) { if (typeof result.local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(result.local) || !localCandidates(result.local, timeZone).length) throw new Error('AI suggested an invalid local time. Your existing draft is unchanged; choose the time below.'); patch.local = result.local; }
  if (result.notify !== undefined) { if (typeof result.notify !== 'boolean') throw new Error('AI returned an invalid announcement choice. Your existing draft is unchanged.'); patch.notify = result.notify; }
  if (result.subject !== undefined) { if (typeof result.subject !== 'string' || !result.subject.trim() || result.subject.length > 800 || /[\r\n\x00-\x1f]/.test(result.subject)) throw new Error('AI returned an invalid subject. Your existing draft is unchanged.'); patch.subject = result.subject; }
  if (result.messageBody !== undefined) { if (typeof result.messageBody !== 'string' || !result.messageBody.trim() || result.messageBody.length > 10000) throw new Error('AI returned an invalid message. Your existing draft is unchanged.'); patch.messageBody = result.messageBody; }
  if (!Object.keys(patch).length) throw new Error('AI did not return a draft suggestion. Your existing fields are unchanged.');
  return { status: 'ready', patch, message: 'Draft fields filled. Review the time and message, confirm the recipients yourself, and create a new preview before approving.', warnings };
}
async function fillDraftWithAI() {
  const event = eventById(); if (!event) throw new Error('Choose a linked workshop before using AI help.');
  const before = readDraft(), request = before.aiRequest.trim();
  if (!request || request.length > 1500) throw new Error('Describe the change in 1–1,500 characters.');
  try {
    const result = checkAIResult(await api('live/interpret', { eventId: event.id, request }), zone(event));
    if (result.status === 'ready') {
      const next = { ...before, ...result.patch, from: before.from, recipients: [...before.recipients], instantChoice: '', autoGenerated: Object.hasOwn(result.patch, 'messageBody') ? false : before.autoGenerated };
      if (next.autoGenerated) next.messageBody = generatedAnnouncement(event, next.local);
      saveDraft(event.id, next);
      for (const plan of state.plans.filter(plan => plan.eventId === event.id)) { invalidatedPlanIds.add(plan.id); try { sessionStorage.setItem('changerelay-live-invalid-plan-' + plan.id, '1'); } catch {} }
      activePlan = null; acknowledged = false;
    }
    aiFeedback.set(event.id, { status: result.status, message: result.message, warnings: result.warnings });
    render();
  } catch (error) {
    aiFeedback.set(event.id, { status: 'error', message: 'AI help is unavailable: ' + error.message + ' You can continue with the normal form.', warnings: [] });
    saveDraft(event.id, before); render();
  }
}
async function previewChange() {
  const event = eventById(); if (!event) throw new Error('Choose a linked workshop.');
  const draft = readDraft(), candidates = localCandidates(draft.local, zone(event));
  if (!candidates.length) throw new Error('This local time does not exist because of a timezone clock change. Choose another time.');
  let start = candidates[0].value;
  if (candidates.length > 1) {
    const chosen = candidates.find(candidate => candidate.value === draft.instantChoice);
    if (!chosen) { const field = document.querySelector('#time-offset-choice'); field.hidden = false; field.innerHTML = `<label for="exact-offset">This time occurs twice. Choose the intended UTC offset.</label><select id="exact-offset"><option value="">Choose the exact time</option>${candidates.map(candidate => `<option value="${esc(candidate.value)}">${esc(candidate.label)}</option>`).join('')}</select>`; throw new Error('Choose which occurrence of this time you mean before previewing.'); }
    start = chosen.value;
  }
  const plan = await api('live/preview', { eventId: event.id, start, notify: draft.notify, from: draft.from, subject: draft.subject, messageBody: draft.messageBody, recipients: draft.notify ? draft.recipients : [] });
  activePlan = plan.plan || plan; acknowledged = false; state.plans = state.plans.filter(saved => saved.id !== activePlan.id).concat(activePlan); impact = 'calendar'; go('preview', activePlan.id);
}
function editPlan(plan) { selectedEvent = plan.eventId; const event = eventById(); if (!event) return notify('This event is unavailable. Refresh your workspace.'); const notification = plan.snapshot.notifications[0]; saveDraft(event.id, { local: localInput(plan.snapshot.target.start, plan.snapshot.timezone), notify: plan.snapshot.notify, from: notification?.from || '', subject: notification?.subject?.replace(/ \[CR-[A-Za-z0-9_-]+\]$/, '') || `${event.title} · updated schedule`, messageBody: notification?.messageBody || draftFor(event).messageBody, autoGenerated: draftFor(event).autoGenerated === true && (!notification || draftFor(event).messageBody === notification.messageBody), recipients: plan.snapshot.notifications.map(item => item.recipient), instantChoice: plan.snapshot.target.start }); acknowledged = false; go('change', selectedEvent); if (plan.snapshot.notify) void loadSenders().catch(error => notify(error.message)); }
function downloadReceipt(run) { const plan = state.plans.find(plan => plan.id === run.planId); const receipt = { product: 'ChangeRelay', mode: 'live', id: run.id, title: titleOfRun(run), createdAt: run.createdAt, status: run.status, schedule: plan ? { before: { start: plan.snapshot.calendarBefore.start, end: plan.snapshot.calendarBefore.end }, after: plan.snapshot.target, timezone: plan.snapshot.timezone } : null, steps: (run.steps || []).map(step => ({ action: step.kind, status: step.status, summary: step.summary, attempts: step.attempts, completedAt: step.finishedAt || null })), acknowledged: false }; const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ChangeRelay-receipt-' + run.id.slice(0, 8) + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

root.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'cancel-connection') { stopConnectionWait(); return; }
  if (action === 'reload-connections') { reloadConnectionSetup(); return; }
  if (action === 'connect') { void connectNow(button.dataset.app); return; }
  if (action === 'go') return go(button.dataset.page);
  if (action === 'plan-event') { selectedEvent = button.dataset.event; return go('change', selectedEvent); }
  if (action === 'toggle-map') { mapMode = mapMode === 'map' ? 'list' : 'map'; return render(); }
  if (action === 'inspect') { impact = button.dataset.impact; root.querySelectorAll('[data-impact]').forEach(card => card.setAttribute('aria-pressed', String(card.dataset.impact === impact))); const plan = planById(); if (plan) root.querySelector('#impact-detail').textContent = impactDescription(plan, impact); return; }
  if (action === 'edit-plan') return editPlan(planById(button.dataset.plan));
  if (action === 'receipt') return downloadReceipt(state.runs.find(run => run.id === button.dataset.run));
  void act(action === 'fill-ai' ? 'Preparing a draft suggestion…' : 'Saving your workspace…', async () => {
    if (action === 'fill-ai') await fillDraftWithAI();
    if (action === 'prepare-connections') await prepareConnections();
    if (action === 'load-options') await loadOptions(button.dataset.kind);
    if (action === 'save-mapping') await saveMapping();
    if (action === 'resume-setup') await resumeSetup();
    if (action === 'clear-setup') await clearSavedSetup();
    if (action === 'save-setup-later') { await persistSetupDraft(); go('overview'); notify('Setup saved. Return to Connections and choose Resume saved setup when you are ready.'); }
    if (action === 'connection-access') { if (!['true', 'false'].includes(button.dataset.paused)) throw new Error('Choose a valid app access state.'); await changeConnectionAccess(button.dataset.app, button.dataset.paused === 'true'); }
    if (action === 'load-senders') { readDraft(); await loadSenders(); }
    if (action === 'refresh-roster') { readDraft(); const event = eventById(); if (!event) throw new Error('Choose a linked event first.'); const people = await api('live/options', { kind: 'participants', eventId: event.id }); event.participants = (people.options || []).map(person => ({ name: person.name || person.label, email: person.email || person.value, role: person.role || 'participant' })); render(); notify('The linked participant roster has been refreshed. Review your selected recipients.'); }
    if (action === 'refresh-state') await refreshState();
    if (action === 'approve-plan') { const plan = planById(button.dataset.plan); if (!plan || plan.superseded) throw new Error('Review the newest saved proposal.'); if (plan.snapshot.conflicts.length && !acknowledged) throw new Error('Review and acknowledge the known warnings first.'); await api('live/approve', { planId: plan.id, version: plan.version, hash: plan.hash, acknowledged }); try { sessionStorage.removeItem('changerelay-live-draft-' + plan.eventId); } catch {} draftMemory.delete(plan.eventId); await refreshState({ renderPage: false }); go('activity'); notify('The exact plan is approved. Follow its saved execution steps here.'); }
    if (action === 'recover-run') { await api('live/recover', { runId: button.dataset.run }); await refreshState(); notify('Recovery requested. Existing sources and uncertain receipts will be checked first.'); }
    if (action === 'sign-out') { clearTimeout(setupSaveTimer); setupRevision++; await api('auth/sign-out', {}); user = null; tokenCache.clear(); draftMemory.clear(); invalidatedPlanIds.clear(); aiFeedback.clear(); try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith('changerelay-live-draft-') || key?.startsWith('changerelay-live-invalid-plan-') || key?.startsWith('changerelay-live-setup-')) sessionStorage.removeItem(key); } } catch {} location.assign('/signin'); }
  });
});
root.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.wizard) {
    if (setupResuming) return render();
    const key = target.dataset.wizard; wizard[key] = target.value;
    if (key === 'calendarChoice') { wizard.calendarEventChoice = ''; options.calendarEvents = []; }
    if (key === 'spreadsheetChoice') { options.tabs = []; options.scheduleRows = []; for (const role of ['schedule', 'roster', 'assignments']) { wizard[role + 'TabChoice'] = ''; wizard.mappings[role] = {}; options[role + 'Columns'] = []; } wizard.scheduleRowChoice = ''; }
    if (key.endsWith('TabChoice')) { const role = key.replace('TabChoice', ''); options[role + 'Columns'] = []; wizard.mappings[role] = {}; if (role === 'schedule') { options.scheduleRows = []; wizard.scheduleRowChoice = ''; } }
    updateSetupLabels(key); return render();
  }
  if (target.dataset.mappingKind) { if (setupResuming) return render(); wizard.mappings[target.dataset.mappingKind][target.dataset.mappingKey] = target.value; updateSetupColumn(target.dataset.mappingKind, target.dataset.mappingKey, target.value); return; }
  if (target.id === 'change-event') { selectedEvent = target.value; return go('change', selectedEvent); }
  if (target.id === 'notify-people') { const draft = readDraft(); document.querySelector('#notification-fields').hidden = !draft.notify; if (draft.notify && !options.senders.length) void act('Loading connected sender choices…', loadSenders); }
  if (target.id === 'acknowledge-conflicts') acknowledged = target.checked;
  if (target.closest('#live-change-form')) readDraft();
});
root.addEventListener('input', event => { if (event.target.id === 'clear-data-confirmation') return updateClearDataConfirmation(); if (event.target.id === 'event-search') { search = event.target.value; const filtered = state.events.filter(item => item.title.toLowerCase().includes(search.toLowerCase())); root.querySelector('#filtered-events').innerHTML = filtered.map(eventCard).join('') || '<div class="card empty">No matching events.</div>'; } else if (event.target.closest('#live-change-form')) { if (event.target.id === 'new-local-time') { const draft = draftFor(eventById()); draft.instantChoice = ''; const choices = document.querySelector('#time-offset-choice'); if (choices) { choices.hidden = true; choices.innerHTML = ''; } } readDraft(); } });
root.addEventListener('submit', event => { if (event.target.id === 'live-change-form') { event.preventDefault(); void act('Reading connected records and saving your exact preview…', previewChange); } if (event.target.id === 'live-preferences-form') { event.preventDefault(); void act('Saving your preferences…', savePreferences); } if (event.target.id === 'live-clear-data-form') { event.preventDefault(); void act('Clearing saved ChangeRelay event data…', clearEventData); } });
window.addEventListener('hashchange', () => { if (route.page === 'change') readDraft(); route = parseRoute(); if (route.page === 'change') selectedEvent = route.id; if (route.page === 'preview') { acknowledged = false; impact = 'calendar'; } render(); });
setInterval(async () => { if (polling || busy || !state || document.hidden || !state.runs.some(run => ['pending', 'running'].includes(run.status))) return; polling = true; try { await refreshState({ renderPage: ['activity', 'overview'].includes(route.page) }); } catch { /* Keep saved status visible and let the organiser refresh explicitly. */ } finally { polling = false; } }, 5000);

async function init() {
  try { const account = await api('auth/me'); if (!account.configured || !account.user) { location.replace('/signin?returnTo=%2Fworkspace'); return; } user = account.user; restoreSetupAfterReload(); await refreshState(); }
  catch (error) { root.innerHTML = `<main class="live-loading"><a class="brand" href="/">ChangeRelay.</a><h1>Your workspace needs attention.</h1><p>${esc(error.message)}</p><p><a class="button primary" href="/workspace">Try again</a> <a class="button" href="/#dashboard">Open sample workspace</a></p></main>`; }
}
void init();









