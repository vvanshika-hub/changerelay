import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Server-only operational storage. Every scope must originate from auth.requireUser().user.id,
// never a request body or a JWT/user_metadata claim. The privileged client never reaches a browser.
// Runtime documents are encrypted in an unexposed schema. Only service-role RPCs can read/CAS them.
// This module performs no environment reads and makes no calls until an operation is requested.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APPS = new Set(['google-calendar', 'google-sheets', 'gmail']);
const KEY_VERSION = 'runtime-v1';
// The service-only RPC caps encrypted blobs at 2 MiB; leave room for encryption framing.
const MAX_STATE_BYTES = 1900000;
const STEP_KINDS = ['calendar', 'sheets', 'gmail'];
const FINISHED = new Set(['verified', 'cancelled']);
const STEP_COMPLETE = new Set(['verified', 'skipped']);
const RUN_STATUSES = new Set(['pending', 'running', 'verified', 'failed', 'needs_checking', 'needs-checking', 'cancelled']);
const STEP_STATUSES = new Set(['pending', 'running', 'verified', 'failed', 'needs_checking', 'needs-checking', 'skipped']);
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export class StoreError extends Error {
  constructor(status, code, message) { super(message); this.name = 'StoreError'; this.status = status; this.code = code; }
}
const invalid = message => new StoreError(400, 'INVALID_STORAGE_INPUT', message);
const conflict = message => new StoreError(409, 'STORAGE_CONFLICT', message);
const missing = message => new StoreError(404, 'RECORD_NOT_FOUND', message);
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`A valid ${label} is required.`); return value; }
function text(value, label, limit = 200) { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid(`Enter a valid ${label}.`); return value.trim(); }
function timestamp(value, label) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(`A valid ${label} is required.`); return new Date(value).toISOString(); }
function timezone(value) { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return value; } catch { throw invalid('Choose a valid IANA timezone.'); } }
function json(value) {
  function inspect(item, depth = 0) {
    if (depth > 35) throw invalid('The saved record is too deeply nested.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(child => inspect(child, depth + 1)); return; }
    if (!object(item)) throw invalid('Saved records must contain plain JSON values.');
    for (const [key, child] of Object.entries(item)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid('The saved record contains a reserved key.'); inspect(child, depth + 1); }
  }
  inspect(value); return JSON.parse(JSON.stringify(value));
}
function rawKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength === 32 ? Buffer.from(value) : null;
  if (typeof value !== 'string') return null;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9_+/-]{43}=?$/.test(value)) return null;
  const result = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); return result.length === 32 ? result : null;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashStoredPlan(plan) {
  const value = Object.fromEntries(['id', 'ownerId', 'workspaceId', 'eventId', 'version', 'eventVersion', 'mappingVersion', 'snapshot'].map(key => [key, plan[key]]));
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function blank(ownerId, workspaceId) {
  return { schemaVersion: 1, dataGeneration: 0, ownerId, workspaceId, setup: {}, events: {}, mappings: {}, connections: {}, plans: {}, latestPlanIds: {}, approvals: {}, runs: {}, receipts: {}, authRevocations: {}, leases: {}, leaseGenerations: {}, audit: [] };
}
function assertState(state, ownerId, workspaceId) {
  if (!object(state) || state.schemaVersion !== 1 || state.ownerId !== ownerId || state.workspaceId !== workspaceId || !Array.isArray(state.audit)) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'Saved workspace data could not be verified. Existing records have been preserved.');
  // Additive schema-1 upgrade only; never replace a present or invalid receipt collection.
  if (!Object.hasOwn(state, 'receipts')) state.receipts = {};
  if (!Object.hasOwn(state, 'authRevocations')) state.authRevocations = {};
  if (!Object.hasOwn(state, 'dataGeneration')) state.dataGeneration = 0;
  if (!Number.isSafeInteger(state.dataGeneration) || state.dataGeneration < 0) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'The saved workspace generation could not be verified.');
  for (const field of ['setup', 'events', 'mappings', 'connections', 'plans', 'latestPlanIds', 'approvals', 'runs', 'receipts', 'authRevocations', 'leases', 'leaseGenerations']) if (!object(state[field])) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'Saved workspace data has an unsupported structure.');
  for (const field of ['events', 'mappings', 'connections', 'plans', 'approvals', 'runs', 'receipts', 'authRevocations']) for (const record of Object.values(state[field])) if (!object(record) || record.ownerId !== ownerId || record.workspaceId !== workspaceId) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'A saved record does not belong to this workspace.');
  return state;
}
function summary(connection) { return connection ? { id: connection.id, app: connection.app, displayLabel: connection.displayLabel, status: connection.status, connectedAt: connection.connectedAt, updatedAt: connection.updatedAt, ...(typeof connection.pendingOperation?.paused === 'boolean' ? { desiredPaused: connection.pendingOperation.paused } : {}) } : null; }
function attention(status) { return ['failed', 'needs_checking', 'needs-checking'].includes(status); }
function boundedStoreFetch(input, init = {}) {
  const signals = [AbortSignal.timeout(15000)];
  if (input instanceof Request) signals.push(input.signal);
  if (init.signal) signals.push(init.signal);
  return globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
}

export function createSupabaseStore({ url, serviceKey, encryptionKey, client: injectedClient, createClientImpl = createClient, maxRetries = 8, now = () => Date.now() } = {}) {
  const sourceKey = rawKey(encryptionKey);
  const key = sourceKey ? Buffer.from(hkdfSync('sha256', sourceKey, Buffer.from('ChangeRelay runtime storage'), Buffer.from('private workspace aggregate runtime-v1'), 32)) : null;
  const configured = !!key && (!!injectedClient || (typeof url === 'string' && /^https:\/\//.test(url) && typeof serviceKey === 'string' && !!serviceKey));
  let provider = injectedClient || null;
  const setupState = () => ({ configured, setupRequired: !configured });
  function requireClient() {
    if (!configured) throw new StoreError(503, 'STORAGE_SETUP_REQUIRED', 'Live workspace storage still needs server configuration.');
    if (!provider) {
      try { provider = createClientImpl(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedStoreFetch } }); }
      catch { throw new StoreError(503, 'STORAGE_SETUP_REQUIRED', 'The workspace storage client could not be configured.'); }
    }
    return provider;
  }
  async function rpc(name, params) {
    let result;
    try { result = await requireClient().rpc(name, params); } catch (error) { if (error instanceof StoreError) throw error; throw new StoreError(503, 'STORAGE_UNAVAILABLE', 'Workspace storage is temporarily unavailable. Saved progress has been preserved.'); }
    if (result?.error) {
      if (result.error.code === '42501' || result.error.code === 'P0002') throw missing('This workspace is unavailable for the signed-in organiser.');
      throw new StoreError(503, 'STORAGE_REQUEST_FAILED', 'The workspace storage request could not be completed. Saved progress has been preserved.');
    }
    return result?.data;
  }

  // Worker-only discovery. Never expose this privileged owner list through a browser route.
  async function listRuntimeOwners({ limit = 100, afterOwnerId = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid('Choose a worker batch size between 1 and 1000.');
    if (afterOwnerId !== null) uuid(afterOwnerId, 'worker queue cursor');
    let response;
    try {
      let query = requireClient().from('workspaces').select('owner_id').eq('is_runtime_primary', true).is('deletion_requested_at', null).order('owner_id', { ascending: true });
      if (afterOwnerId !== null) query = query.gt('owner_id', afterOwnerId);
      response = await query.limit(limit);
    }
    catch (error) { if (error instanceof StoreError) throw error; throw new StoreError(503, 'STORAGE_UNAVAILABLE', 'The worker workspace queue could not be read.'); }
    if (response.error || !Array.isArray(response.data)) throw new StoreError(503, 'STORAGE_REQUEST_FAILED', 'The worker workspace queue could not be read.');
    if (response.data.some(row => !UUID.test(row.owner_id || ''))) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'The worker workspace queue contains an invalid owner.');
    return [...new Set(response.data.map(row => row.owner_id))];
  }

  function forOwner(verifiedUserId, { workspaceId: explicitWorkspaceId } = {}) {
    const ownerId = uuid(verifiedUserId, 'verified organiser identity');
    if (explicitWorkspaceId) uuid(explicitWorkspaceId, 'workspace');
    let workspacePromise, capturedGeneration;
    async function ensureWorkspace({ name = 'ChangeRelay workspace' } = {}) {
      if (!workspacePromise) workspacePromise = (async () => {
        let data;
        if (explicitWorkspaceId) {
          let response;
          try { response = await requireClient().from('workspaces').select('id,owner_id,name,timezone').eq('owner_id', ownerId).eq('id', explicitWorkspaceId).is('deletion_requested_at', null).maybeSingle(); }
          catch { throw new StoreError(503, 'STORAGE_UNAVAILABLE', 'The workspace could not be read.'); }
          if (response.error) throw new StoreError(503, 'STORAGE_REQUEST_FAILED', 'The workspace could not be read.');
          data = response.data;
        } else data = await rpc('ensure_runtime_workspace', { p_owner_id: ownerId, p_name: text(name, 'workspace name', 120) });
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || row.owner_id !== ownerId || !UUID.test(row.id || '') || (explicitWorkspaceId && row.id !== explicitWorkspaceId)) throw missing('Workspace not found for the signed-in organiser.');
        return { id: row.id, ownerId, name: row.name, timezone: row.timezone || 'Asia/Kolkata' };
      })().catch(error => { workspacePromise = null; throw error; });
      return clone(await workspacePromise);
    }
    const aad = workspace => Buffer.from(`ChangeRelay|runtime-v1|${ownerId}|${workspace.id}`);
    function seal(state, workspace) {
      const plain = Buffer.from(JSON.stringify(json(state)), 'utf8');
      if (plain.length > MAX_STATE_BYTES) throw new StoreError(413, 'WORKSPACE_LIMIT_REACHED', 'This workspace needs a storage upgrade before more history can be saved.');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(workspace));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return '\\x' + Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString('hex');
    }
    function open(row, workspace) {
      if (row.key_version !== KEY_VERSION || typeof row.ciphertext !== 'string' || !/^\\x(?:[a-f0-9]{2})+$/i.test(row.ciphertext) || row.ciphertext.length > MAX_STATE_BYTES * 2 + 1000) throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'The encrypted workspace could not be verified.');
      try {
        const bytes = Buffer.from(row.ciphertext.slice(2), 'hex');
        if (bytes.length < 30 || bytes[0] !== 1) throw new Error('Invalid format');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
        decipher.setAAD(aad(workspace)); decipher.setAuthTag(bytes.subarray(13, 29));
        const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
        return assertState(state, ownerId, workspace.id);
      } catch { throw new StoreError(503, 'STORAGE_INTEGRITY_FAILED', 'Saved workspace data could not be decrypted. Existing records have been preserved.'); }
    }
    async function read() {
      const workspace = await ensureWorkspace();
      const data = await rpc('read_runtime_state', { p_owner_id: ownerId, p_workspace_id: workspace.id });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        if (capturedGeneration !== undefined && capturedGeneration !== 0) throw conflict('Saved event data was cleared. Reload the workspace before continuing.');
        capturedGeneration = 0;
        return { workspace, state: blank(ownerId, workspace.id), revision: 0, time: now() };
      }
      const revision = Number(row.revision), serverTime = Date.parse(row.server_time);
      if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(serverTime)) throw new StoreError(503, 'STORAGE_CLOCK_INVALID', 'The workspace revision or database clock could not be verified.');
      const state = open(row, workspace);
      if (capturedGeneration !== undefined && capturedGeneration !== state.dataGeneration) throw conflict('Saved event data was cleared. Reload the workspace before continuing.');
      capturedGeneration = state.dataGeneration;
      return { workspace, state, revision, time: serverTime };
    }
    async function mutate(operation) {
      if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 20) throw invalid('Storage retry configuration is invalid.');
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const context = await read(), before = JSON.stringify(context.state);
        const value = await operation(context);
        assertState(context.state, ownerId, context.workspace.id);
        if (JSON.stringify(context.state) === before) return clone(value);
        const applied = await rpc('compare_and_swap_runtime_state', { p_owner_id: ownerId, p_workspace_id: context.workspace.id, p_expected_revision: context.revision, p_ciphertext: seal(context.state, context.workspace), p_key_version: KEY_VERSION });
        if (applied === true) { capturedGeneration = context.state.dataGeneration; return clone(value); }
        if (applied !== false) throw new StoreError(503, 'STORAGE_RESPONSE_INVALID', 'The workspace write could not be confirmed. Please refresh before trying again.');
      }
      throw conflict('Another change is updating this workspace. Refresh and try again.');
    }
    async function captureRequest() { await read(); return true; }
    function audit(state, time, action, extra = {}) { state.audit.push({ id: randomUUID(), at: new Date(time).toISOString(), action, ...extra }); }
    function ownedEvent(state, id) { uuid(id, 'event'); const event = state.events[id]; if (!event) throw missing('Event not found in this workspace.'); return event; }
    function ownedRun(state, id) { uuid(id, 'run'); const run = state.runs[id]; if (!run) throw missing('Execution not found in this workspace.'); return run; }
    function validateLease(state, run, token, generation, time) {
      const lease = state.leases[run.eventId];
      if (!lease || lease.runId !== run.id || lease.ownerId !== ownerId || lease.workspaceId !== run.workspaceId || lease.eventId !== run.eventId || !UUID.test(lease.token || '') || !Number.isSafeInteger(lease.generation) || lease.generation < 1 || !Number.isFinite(Date.parse(lease.expiresAt)) || lease.token !== token || lease.generation !== generation || Date.parse(lease.expiresAt) <= time) throw conflict('The execution lease expired or changed. This worker must stop.');
      return lease;
    }
    function leaseSeconds(seconds = 60) { if (!Number.isInteger(seconds) || seconds < 15 || seconds > 120) throw invalid('Execution leases must last between 15 and 120 seconds.'); return seconds; }
    function noUnfinishedWork(state, time) {
      if (Object.values(state.runs).some(run => !FINISHED.has(run.status))) throw conflict('Finish or reconcile every saved change before changing this workspace access or clearing event data.');
      if (Object.values(state.leases).some(lease => !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) > time)) throw conflict('A saved operation still holds an active lease. Wait for it to finish before continuing.');
    }
    function invalidateConnectionPlans(state, app) {
      for (const [eventId, mapping] of Object.entries(state.mappings)) {
        const affects = app === 'google-calendar' ? !!mapping.calendar : app === 'google-sheets' ? !!(mapping.schedule || mapping.roster || mapping.assignments) : true;
        if (affects) { mapping.version += 1; state.events[eventId].latestPlanId = null; delete state.latestPlanIds[eventId]; }
      }
    }
    function currentConnectionOperation(state, app, operationId, time) {
      const connection = state.connections[app], operation = connection?.pendingOperation;
      if (!connection || !operation || operation.id !== operationId || !Number.isFinite(Date.parse(operation.expiresAt)) || Date.parse(operation.expiresAt) <= time || connection.viaSocketUserId !== ownerId || connection.authId !== operation.authId || connection.serviceId !== operation.serviceId || connection.scriptId !== operation.scriptId) throw conflict('The connection operation expired or changed. Check its saved status before continuing.');
      return { connection, operation };
    }

    async function listConnections() { const { state } = await read(); return clone(Object.values(state.connections)); }
    async function listConnectionSummaries() { return (await listConnections()).map(summary); }
    async function getConnection(app) { if (!APPS.has(app)) throw invalid('Choose a supported connected app.'); const { state } = await read(); return clone(state.connections[app] || null); }
    async function upsertConnection(app, value) {
      if (!APPS.has(app) || !object(value)) throw invalid('Choose a supported connected app.');
      if (value.viaSocketUserId !== ownerId) throw new StoreError(403, 'CONNECTION_OWNER_MISMATCH', 'This connection belongs to a different organiser. Connect the account from your own workspace.');
      text(value.authId, 'verified account connection', 1000); text(value.serviceId, 'app service', 200);
      if (value.scriptId !== undefined && value.scriptId !== null) text(value.scriptId, 'enabled connection', 1000);
      const status = value.status || 'connected';
      if (!['connected', 'expired', 'disconnected', 'needs_attention', 'setup_required'].includes(status)) throw invalid('Choose a valid connection state.');
      return mutate(({ state, workspace, time }) => {
        const old = state.connections[app], stamp = new Date(time).toISOString();
        if (old?.status === 'paused' || old?.pendingOperation) throw conflict('Resume or check this saved connection before connecting an account again.');
        const scriptId = value.scriptId ?? (old?.authId === value.authId ? old?.scriptId : null) ?? null;
        const credentialsChanged = old && (old.authId !== value.authId || old.serviceId !== value.serviceId || old.scriptId !== scriptId);
        if (credentialsChanged && Object.values(state.runs).some(run => !FINISHED.has(run.status))) throw conflict('Finish or reconcile active changes before replacing a connected account.');
        if (credentialsChanged) invalidateConnectionPlans(state, app);
        const record = { id: old?.id || randomUUID(), ownerId, workspaceId: workspace.id, app, authId: value.authId, viaSocketUserId: ownerId, serviceId: value.serviceId, scriptId, displayLabel: text(value.displayLabel || app, 'account label', 250), status, connectedAt: old?.connectedAt || stamp, updatedAt: stamp, verifiedAt: stamp };
        state.connections[app] = record; audit(state, time, 'connection_saved'); return summary(record);
      });
    }
    async function beginConnectionState({ app, paused }) {
      if (!APPS.has(app) || typeof paused !== 'boolean') throw invalid('Choose a supported app and whether it should be paused.');
      return mutate(({ state, time }) => {
        noUnfinishedWork(state, time);
        const connection = state.connections[app];
        if (!connection || connection.viaSocketUserId !== ownerId) throw missing('Connect this app from your signed-in workspace first.');
        for (const field of ['authId', 'serviceId', 'scriptId']) text(connection[field], 'saved app connection', 1000);
        const pending = connection.pendingOperation;
        if (pending && pending.paused !== paused) throw conflict('Check the unfinished connection change before requesting the opposite state.');
        if (pending?.state === 'pending' && Date.parse(pending.expiresAt) > time) throw conflict('This connection change is still running. Wait for its result before checking again.');
        const operation = { id: randomUUID(), paused, authId: connection.authId, serviceId: connection.serviceId, scriptId: connection.scriptId, state: 'pending', attempted: pending?.attempted === true, reconcileOnly: pending?.attempted === true, expiresAt: new Date(time + 120000).toISOString() };
        connection.status = 'needs_attention'; connection.pendingOperation = operation; connection.updatedAt = new Date(time).toISOString();
        invalidateConnectionPlans(state, app);
        audit(state, time, paused ? 'connection_pause_requested' : 'connection_resume_requested');
        return { connection, operation };
      });
    }
    async function markConnectionDispatch({ app, operationId }) {
      if (!APPS.has(app)) throw invalid('Choose a supported app.'); uuid(operationId, 'connection operation');
      return mutate(({ state, time }) => {
        noUnfinishedWork(state, time);
        const { operation } = currentConnectionOperation(state, app, operationId, time);
        if (operation.reconcileOnly || operation.attempted) throw conflict('Check the previous connection result before any further operation.');
        operation.attempted = true;
        return true;
      });
    }
    async function finishConnectionState({ app, operationId, verified, reconnectRequired = false }) {
      if (!APPS.has(app) || typeof verified !== 'boolean' || typeof reconnectRequired !== 'boolean') throw invalid('Choose a supported connection result.'); uuid(operationId, 'connection operation');
      return mutate(({ state, time }) => {
        const { connection, operation } = currentConnectionOperation(state, app, operationId, time);
        connection.updatedAt = new Date(time).toISOString();
        if (reconnectRequired) {
          if (verified || operation.attempted || operation.reconcileOnly) throw conflict('Reconcile an attempted connection change before replacing its account.');
          connection.status = 'expired'; delete connection.pendingOperation;
        }
        else if (verified) { connection.status = operation.paused ? 'paused' : 'connected'; connection.verifiedAt = connection.updatedAt; delete connection.pendingOperation; }
        else { connection.status = 'needs_attention'; operation.state = 'uncertain'; }
        audit(state, time, verified ? 'connection_state_verified' : 'connection_state_needs_checking');
        return summary(connection);
      });
    }
    async function clearEventData({ confirmation } = {}) {
      if (confirmation !== 'CLEAR EVENT DATA') throw invalid('Type CLEAR EVENT DATA to remove saved event data.');
      return mutate(({ state, workspace, time }) => {
        noUnfinishedWork(state, time);
        if (Object.values(state.receipts).some(receipt => receipt.status !== 'sent')) throw conflict('An announcement result still needs checking. Reconcile it before clearing event data.');
        if (Object.values(state.connections).some(connection => connection.pendingOperation?.state === 'pending' && Date.parse(connection.pendingOperation.expiresAt) > time)) throw conflict('Wait for the current connection change before clearing saved event data.');
        if (state.dataGeneration >= Number.MAX_SAFE_INTEGER) throw conflict('The workspace generation limit was reached. Contact support before clearing data.');
        const retained = { connections: state.connections, authRevocations: state.authRevocations, dataGeneration: state.dataGeneration + 1 };
        Object.assign(state, blank(ownerId, workspace.id), retained);
        return { cleared: true };
      });
    }
    async function getSetup() { return clone((await read()).state.setup); }
    async function saveSetup(patch) {
      const change = json(patch); if (!object(change)) throw invalid('The setup draft must be an object.');
      if (change.preferences !== undefined && !object(change.preferences)) throw invalid('Workspace preferences must be an object.');
      return mutate(({ state }) => {
        // Preference fields merge inside the CAS retry; concurrent timezone and default
        // announcement changes must not overwrite each other or the onboarding draft.
        state.setup = { ...state.setup, ...change, ...(change.preferences ? { preferences: { ...(object(state.setup.preferences) ? state.setup.preferences : {}), ...change.preferences } } : {}) };
        return state.setup;
      });
    }
    async function listEvents() { return clone(Object.values((await read()).state.events)); }
    async function getEvent(id) { const { state } = await read(); return clone(ownedEvent(state, id)); }
    async function getEventMapping(id) { const { state } = await read(); ownedEvent(state, id); return clone(state.mappings[id] || null); }
    async function saveEvent({ event: input, mapping: suppliedMapping }) {
      if (!object(input) || !object(suppliedMapping)) throw invalid('Confirm the event and its record mappings.');
      const event = json(input), mapping = json(suppliedMapping);
      const stableId = text(event.stableEventId || event.stable_event_id, 'stable event ID', 200);
      const start = timestamp(event.start || event.starts_at, 'event start'), end = timestamp(event.end || event.ends_at, 'event end');
      if (Date.parse(end) <= Date.parse(start)) throw invalid('The event end must be after its start.');
      text(event.title, 'event title', 500); timezone(event.timezone);
      if (!mapping.calendar?.calendarId || !mapping.calendar?.eventId || !mapping.schedule?.spreadsheetId || !mapping.schedule?.sheetId || !mapping.schedule?.eventId) throw invalid('Calendar and schedule links must be confirmed before saving this event.');
      for (const value of [mapping.calendar.calendarId, mapping.calendar.eventId, mapping.schedule.spreadsheetId, mapping.schedule.sheetId, mapping.schedule.eventId]) text(value, 'confirmed source reference', 1000);
      if (mapping.schedule.eventId !== stableId) throw invalid('The linked schedule must use this event’s stable ID.');
      return mutate(({ state, workspace, time }) => {
        const previous = Object.values(state.events).find(row => row.stableEventId === stableId);
        const id = event.id ? uuid(event.id, 'event') : previous?.id || randomUUID();
        if (event.ownerId && event.ownerId !== ownerId || event.workspaceId && event.workspaceId !== workspace.id) throw new StoreError(403, 'EVENT_OWNER_MISMATCH', 'The event belongs to another workspace.');
        if (previous && previous.id !== id) throw conflict('This stable event ID is already linked to another event.');
        for (const [linkedEventId, references] of Object.entries(state.mappings)) {
          if (linkedEventId === id) continue;
          const sameCalendar = references.calendar?.calendarId === mapping.calendar.calendarId && references.calendar?.eventId === mapping.calendar.eventId;
          const sameSchedule = references.schedule?.spreadsheetId === mapping.schedule.spreadsheetId && references.schedule?.sheetId === mapping.schedule.sheetId && references.schedule?.eventId === mapping.schedule.eventId;
          if (sameCalendar || sameSchedule) throw conflict('This Calendar event or stable schedule record is already linked to another event. Open that event instead.');
        }
        const old = state.events[id];
        if (Object.values(state.runs).some(run => run.eventId === id && !FINISHED.has(run.status))) throw conflict('Finish or reconcile the current change before editing its event mappings.');
        const record = { ...event, id, stableEventId: stableId, ownerId, workspaceId: workspace.id, title: event.title.trim(), start, end, timezone: event.timezone, version: old ? old.version + 1 : 1, latestPlanId: null, createdAt: old?.createdAt || new Date(time).toISOString(), updatedAt: new Date(time).toISOString() };
        const references = { ...mapping, ownerId, workspaceId: workspace.id, eventId: id, version: (state.mappings[id]?.version || 0) + 1 };
        state.events[id] = record; state.mappings[id] = references; delete state.latestPlanIds[id]; audit(state, time, 'event_linked', { eventId: id }); return record;
      });
    }
    async function listPlans() { const { state } = await read(); return clone(Object.values(state.plans).map(plan => ({ ...plan, superseded: state.latestPlanIds[plan.eventId] !== plan.id }))); }
    async function getPlan(id) {
      uuid(id, 'plan'); const { state } = await read(), plan = state.plans[id];
      if (!plan) throw missing('Plan not found in this workspace.');
      if (hashStoredPlan(plan) !== plan.hash) throw new StoreError(503, 'PLAN_INTEGRITY_FAILED', 'The saved proposal could not be verified. Review a fresh proposal.');
      return clone({ ...plan, superseded: state.latestPlanIds[plan.eventId] !== plan.id });
    }
    async function savePlan(input) {
      const plan = json(input); uuid(plan.id, 'plan'); uuid(plan.eventId, 'event');
      if (!Number.isSafeInteger(plan.version) || plan.version < 1 || !/^[a-f0-9]{64}$/.test(plan.hash || '') || !object(plan.snapshot)) throw invalid('The proposal version or hash is invalid.');
      return mutate(({ state, workspace, time }) => {
        if (plan.ownerId !== ownerId || plan.workspaceId !== workspace.id) throw new StoreError(403, 'PLAN_OWNER_MISMATCH', 'The proposal belongs to a different workspace.');
        if (hashStoredPlan(plan) !== plan.hash) throw conflict('The proposal changed before it could be saved. Review it again.');
        const event = ownedEvent(state, plan.eventId), mapping = state.mappings[plan.eventId];
        const existing = state.plans[plan.id];
        if (existing) { if (canonical(existing) !== canonical(plan)) throw conflict('Saved plan versions are immutable. Create a new proposal.'); return existing; }
        if (event.version !== plan.eventVersion || mapping?.version !== plan.mappingVersion) throw conflict('The event or its mapping changed. Refresh the impact preview.');
        if (Object.values(state.runs).some(run => run.eventId === event.id && !FINISHED.has(run.status))) throw conflict('This event has an unfinished change. Recover it before planning another.');
        state.plans[plan.id] = plan; state.latestPlanIds[event.id] = plan.id; event.latestPlanId = plan.id;
        audit(state, time, 'plan_saved', { eventId: event.id }); return plan;
      });
    }
    async function approvePlan({ planId, version, hash, acknowledged, approvedAt, approvalId, run: suppliedRun }) {
      uuid(planId, 'plan'); uuid(approvalId, 'approval');
      const initialRun = json(suppliedRun); uuid(initialRun.id, 'run');
      return mutate(({ state, workspace, time }) => {
        const plan = state.plans[planId]; if (!plan) throw missing('Plan not found in this workspace.');
        if (hashStoredPlan(plan) !== plan.hash || plan.hash !== hash || plan.version !== version) throw conflict('The proposal changed. Review the exact current version before approving.');
        const event = ownedEvent(state, plan.eventId), mapping = state.mappings[event.id];
        const existing = state.approvals[planId];
        if (existing) { const prior = state.runs[existing.runId]; if (!prior) throw new StoreError(503, 'RUN_INTEGRITY_FAILED', 'The saved execution could not be found.'); return { approval: existing, run: prior }; }
        if (state.latestPlanIds[event.id] !== planId || event.version !== plan.eventVersion || mapping?.version !== plan.mappingVersion) throw conflict('This proposal was replaced or its event changed. Refresh the review.');
        if (Object.values(state.runs).some(run => run.eventId === event.id && !FINISHED.has(run.status))) throw conflict('Another change is already active for this event.');
        if (initialRun.ownerId !== ownerId || initialRun.workspaceId !== workspace.id || initialRun.eventId !== event.id || initialRun.planId !== planId || initialRun.planHash !== hash || initialRun.planVersion !== version) throw invalid('The execution does not match this exact approved plan.');
        if (Array.isArray(plan.snapshot.conflicts) && plan.snapshot.conflicts.length && acknowledged !== true) throw invalid('Acknowledge the reviewed conflicts before approving.');
        if (initialRun.status !== 'pending' || !Array.isArray(initialRun.steps) || initialRun.steps.length !== 3 || initialRun.steps.some((step, index) => step.kind !== STEP_KINDS[index] || step.ordinal !== index + 1 || step.attempts !== 0 || !['pending', 'skipped'].includes(step.status) || (index < 2 && (!step.required || step.status !== 'pending')) || index === 2 && (step.required !== (plan.snapshot.notify === true) || step.status !== (plan.snapshot.notify === true ? 'pending' : 'skipped')))) throw invalid('The execution must contain the reviewed Calendar, Sheets and announcement steps.');
        const approval = { id: approvalId, ownerId, workspaceId: workspace.id, eventId: event.id, planId, version, hash, acknowledged: acknowledged === true, approvedAt: timestamp(approvedAt || new Date(time).toISOString(), 'approval time'), runId: initialRun.id };
        const run = { ...initialRun, approval: { id: approval.id, approvedAt: approval.approvedAt, version, hash, acknowledged: approval.acknowledged } };
        state.approvals[planId] = approval; state.runs[run.id] = run; audit(state, time, 'plan_approved', { eventId: event.id, runId: run.id }); return { approval, run };
      });
    }
    async function getRun(id) { const { state } = await read(); return clone(ownedRun(state, id)); }
    async function listRuns() { return clone(Object.values((await read()).state.runs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))); }
    async function claimRun({ runId, workerId, leaseSeconds: requestedSeconds = 60, recovery = false }) {
      text(workerId, 'worker identity', 128); const seconds = leaseSeconds(requestedSeconds);
      return mutate(({ state, time, workspace }) => {
        const run = ownedRun(state, runId); if (FINISHED.has(run.status) || attention(run.status) && recovery !== true) return null;
        const current = state.leases[run.eventId]; if (current && Date.parse(current.expiresAt) > time) return null;
        if (run.steps.some(step => step.status === 'running')) {
          for (const step of run.steps) if (step.status === 'running') { step.status = 'needs-checking'; step.summary = 'The worker stopped while this operation was in flight. Reconcile before retrying.'; }
          run.status = 'needs-checking'; run.lastError = 'An interrupted operation needs reconciliation.'; run.updatedAt = new Date(time).toISOString(); delete state.leases[run.eventId]; audit(state, time, 'run_needs_checking', { eventId: run.eventId, runId }); if (recovery !== true) return null;
        }
        const previousGeneration = state.leaseGenerations[run.eventId] || 0;
        if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0 || previousGeneration >= Number.MAX_SAFE_INTEGER) throw new StoreError(503, 'LEASE_GENERATION_INVALID', 'The saved worker generation could not be verified.');
        const generation = previousGeneration + 1;
        const lease = { ownerId, workspaceId: workspace.id, eventId: run.eventId, runId, workerId, token: randomUUID(), generation, recovery: recovery === true, expiresAt: new Date(time + seconds * 1000).toISOString() };
        state.leaseGenerations[run.eventId] = generation; state.leases[run.eventId] = lease; run.status = 'running'; run.updatedAt = new Date(time).toISOString();
        return { run, lease };
      });
    }
    async function heartbeatRun({ runId, leaseToken, generation, leaseSeconds: requestedSeconds = 60 }) {
      const seconds = leaseSeconds(requestedSeconds);
      return mutate(({ state, time }) => { const run = ownedRun(state, runId), lease = validateLease(state, run, leaseToken, generation, time); lease.expiresAt = new Date(time + seconds * 1000).toISOString(); return lease; });
    }
    async function checkpointStep({ runId, leaseToken, generation, kind = null, patch = {}, runPatch = {}, eventPatch }) {
      const stepChange = json(patch), runChange = json(runPatch), eventChange = eventPatch === undefined ? null : json(eventPatch);
      if (!object(stepChange) || !object(runChange) || eventChange !== null && !object(eventChange)) throw invalid('Execution checkpoints must be objects.');
      if (kind !== null && !STEP_KINDS.includes(kind)) throw invalid('Unknown execution step.');
      const allowedRun = new Set(['status', 'updatedAt', 'lastError', 'startedAt', 'finishedAt', 'completedAt', 'resolution']);
      const allowedStep = new Set(['status', 'attempts', 'summary', 'verification', 'startedAt', 'finishedAt', 'verifiedAt', 'updatedAt']);
      if (Object.keys(runChange).some(key => !allowedRun.has(key)) || Object.keys(stepChange).some(key => !allowedStep.has(key))) throw invalid('Execution identities and approval snapshots cannot be changed.');
      return mutate(({ state, time }) => {
        const run = ownedRun(state, runId), lease = validateLease(state, run, leaseToken, generation, time);
        if (FINISHED.has(run.status)) throw conflict('A completed execution receipt cannot be rewritten.');
        if (runChange.status !== undefined && !RUN_STATUSES.has(runChange.status)) throw invalid('The execution state is invalid.');
        if (runChange.resolution !== undefined && (runChange.status !== 'cancelled' || runChange.resolution !== 'source-stale-before-dispatch')) throw invalid('Choose a supported safe execution resolution.');
        if (runChange.status === 'cancelled') {
          // This check runs inside the fenced CAS, independently of the engine's stale read.
          // A send receipt or any dispatch evidence makes cancellation unsafe, even if a
          // delayed response has not yet updated the visible step state.
          const untouched = run.steps.every(step => step.attempts === 0 && ['pending', 'failed', 'skipped'].includes(step.status) && !step.startedAt && step.verification == null);
          const plan = state.plans[run.planId];
          const markers = new Set((plan?.snapshot.notifications || []).map(item => item.receiptMarker));
          const hasReceipt = Object.values(state.receipts).some(receipt => receipt.runId === run.id || markers.has(receipt.receiptId));
          if (kind !== null || Object.keys(stepChange).length || eventChange || runChange.resolution !== 'source-stale-before-dispatch' || !untouched || hasReceipt) throw conflict('Only a stale plan with no attempted operations or announcement receipts can be stopped. Reconcile existing work first.');
        }
        if (kind) {
          const step = run.steps.find(item => item.kind === kind); if (!step) throw missing('Execution step not found.');
          const target = stepChange.status || step.status;
          if (!STEP_STATUSES.has(target)) throw invalid('The step state is invalid.');
          if (STEP_COMPLETE.has(step.status) && canonical({ ...step, ...stepChange }) !== canonical(step)) throw conflict('A completed execution step cannot be repeated or changed.');
          if (target === 'running' && step.status !== 'running') {
            if (!['pending', 'failed'].includes(step.status) && !(lease.recovery && ['needs_checking', 'needs-checking'].includes(step.status))) throw conflict('Reconcile this step before retrying it.');
            if (run.steps.some(item => item.ordinal < step.ordinal && !STEP_COMPLETE.has(item.status))) throw conflict('Verify preceding steps before starting this operation.');
            if (stepChange.attempts !== step.attempts + 1) throw invalid('Each dispatch must increment its saved attempt count exactly once.');
          } else if (stepChange.attempts !== undefined && stepChange.attempts !== step.attempts) throw invalid('The attempt count can change only when an operation starts.');
          if (target === 'verified' && step.status !== 'running' && step.status !== 'verified' && !(lease.recovery && attention(step.status) && step.attempts > 0)) throw conflict('An operation must be recorded as running or explicitly reconciled before verification.');
          if (target === 'verified' && (!object(stepChange.verification || step.verification) || Object.keys(stepChange.verification || step.verification).length === 0)) throw invalid('Verification requires read-back evidence.');
          if (target === 'skipped' && (step.required || !['pending', 'skipped'].includes(step.status))) throw conflict('A required or started operation cannot be skipped.');
          Object.assign(step, stepChange);
        }
        if (runChange.status === 'verified' && !run.steps.every(step => STEP_COMPLETE.has(step.status))) throw conflict('Every planned step must be verified or explicitly skipped before completion.');
        Object.assign(run, runChange); run.updatedAt = new Date(time).toISOString();
        if (run.status === 'cancelled') {
          const event = ownedEvent(state, run.eventId);
          if (state.latestPlanIds[event.id] === run.planId) { delete state.latestPlanIds[event.id]; event.latestPlanId = null; }
          audit(state, time, 'stale_plan_stopped_before_dispatch', { eventId: run.eventId, runId: run.id });
        }
        if (eventChange) {
          if (run.status !== 'verified' || !run.steps.every(step => STEP_COMPLETE.has(step.status)) || Object.keys(eventChange).some(key => !['start', 'end', 'version'].includes(key))) throw conflict('The event schedule can be committed only after verified execution.');
          const event = ownedEvent(state, run.eventId), plan = state.plans[run.planId];
          if (!plan || event.version !== plan.eventVersion || eventChange.version !== event.version + 1) throw conflict('The event changed before its result could be saved.');
          const start = timestamp(eventChange.start, 'verified start'), end = timestamp(eventChange.end, 'verified end'); if (Date.parse(end) <= Date.parse(start)) throw invalid('The verified duration is invalid.');
          if (object(plan.snapshot?.target) && (plan.snapshot.target.start !== start || plan.snapshot.target.end !== end)) throw conflict('The verified event must match the exact approved schedule.');
          Object.assign(event, { start, end, version: eventChange.version, latestPlanId: null, updatedAt: new Date(time).toISOString() }); delete state.latestPlanIds[event.id];
        }
        return run;
      });
    }
    async function releaseRun({ runId, leaseToken, generation }) {
      return mutate(({ state, time }) => {
        const run = ownedRun(state, runId); validateLease(state, run, leaseToken, generation, time);
        if (run.steps.some(step => step.status === 'running')) throw conflict('An operation is still in flight. Save or reconcile its outcome before release.');
        if (run.status === 'running') run.status = run.steps.every(step => STEP_COMPLETE.has(step.status)) ? 'verified' : run.steps.some(step => ['needs_checking', 'needs-checking'].includes(step.status)) ? 'needs-checking' : run.steps.some(step => step.status === 'failed') ? 'failed' : 'pending';
        delete state.leases[run.eventId]; run.updatedAt = new Date(time).toISOString(); return true;
      });
    }
    function receiptIdFor(key) {
      if (typeof key !== 'string' || !key.startsWith(`${ownerId}:`)) throw new StoreError(403, 'RECEIPT_OWNER_MISMATCH', 'This announcement receipt belongs to another organiser.');
      const id = key.slice(ownerId.length + 1);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{6,99}$/.test(id)) throw invalid('Choose a valid announcement receipt marker.');
      return id;
    }
    function approvedNotification(state, record, time) {
      if (record.ownerId !== ownerId || typeof record.approvalId !== 'string' || !Number.isInteger(record.approvalVersion) || !/^[a-f0-9]{64}$/.test(record.approvalHash || '') || !/^[a-f0-9]{64}$/.test(record.payloadHash || '')) throw invalid('The receipt must reference an immutable approved announcement.');
      for (const plan of Object.values(state.plans)) {
        const notification = plan.snapshot.notifications?.find(item => item.id === record.approvalId && item.receiptMarker === record.receiptId);
        if (!notification) continue;
        const approval = state.approvals[plan.id], run = approval && state.runs[approval.runId];
        if (!approval || !run || plan.snapshot.notify !== true || plan.hash !== record.approvalHash || plan.version !== record.approvalVersion || approval.hash !== plan.hash || hashStoredPlan(plan) !== plan.hash) throw conflict('The receipt does not match an approved plan.');
        const payload = { recipient: notification.recipient, from: notification.from, subject: notification.subject, messageBody: notification.messageBody, receiptMarker: notification.receiptMarker };
        if (Object.values(payload).some(value => typeof value !== 'string') || createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== record.payloadHash) throw conflict('The announcement payload differs from the exact approved message.');
        const lease = state.leases[run.eventId];
        if (run.status !== 'running' || !lease || lease.runId !== run.id || Date.parse(lease.expiresAt) <= time || !run.steps.filter(step => step.kind === 'calendar' || step.kind === 'sheets').every(step => step.status === 'verified')) throw conflict('Verify the approved Calendar and spreadsheet updates under an active execution lease before sending an announcement.');
        return { approval, run };
      }
      throw missing('The approved announcement was not found in this workspace.');
    }
    async function createReceipt(key, input, fence = null) {
      const id = receiptIdFor(key), record = json(input);
      if (!object(record) || record.receiptId !== id || record.status !== 'sending' || record.acknowledged !== false) throw invalid('A new announcement receipt must start as Sending without acknowledgement.');
      return mutate(({ state, workspace, time }) => {
        // Fencing is checked in the same CAS transaction as the dispatch claim. A previous
        // worker cannot acquire a fresh Sending record after another worker takes this run.
        if (fence) validateLease(state, ownedRun(state, fence.runId), fence.leaseToken, fence.generation, time);
        const { run } = approvedNotification(state, record, time);
        if (fence && run.id !== fence.runId) throw conflict('This announcement belongs to a different execution lease.');
        if (state.receipts[id]) return false;
        state.receipts[id] = { ...record, ownerId, workspaceId: workspace.id, runId: run.id, updatedAt: new Date(time).toISOString() };
        audit(state, time, 'announcement_claimed', { eventId: run.eventId, runId: run.id }); return true;
      });
    }
    // This adapter is server-private: provider message/thread references stay encrypted here.
    const receiptStore = Object.freeze({
      async get(key) { const id = receiptIdFor(key), { state } = await read(); return clone(state.receipts[id] || null); },
      create: (key, input) => createReceipt(key, input),
      async update(key, input) {
        const id = receiptIdFor(key), patch = json(input);
        const allowed = new Set(['status', 'acknowledged', 'reason', 'checkedAt', 'providerMessageId', 'providerThreadId', 'verifiedAt', 'sentAt']);
        if (!object(patch) || Object.keys(patch).some(field => !allowed.has(field)) || patch.acknowledged !== undefined && patch.acknowledged !== false) throw invalid('Announcement ownership, approval and payload hashes cannot be changed.');
        if (patch.status !== undefined && !['sending', 'sent', 'needs-checking'].includes(patch.status)) throw invalid('The announcement receipt state is invalid.');
        return mutate(({ state, time }) => {
          const record = state.receipts[id]; if (!record) throw missing('Announcement receipt not found.');
          if (record.status === 'sent') return record;
          for (const field of ['providerMessageId', 'providerThreadId']) if (patch[field] !== undefined) {
            text(patch[field], 'provider receipt reference', 1000);
            if (record[field] && record[field] !== patch[field]) throw conflict('The provider receipt reference changed. Reconcile the existing message first.');
          }
          if (patch.status === 'sending' && record.status !== 'sending') throw conflict('An uncertain announcement cannot be dispatched again blindly.');
          if (patch.status === 'sent' && !(patch.providerMessageId || record.providerMessageId)) throw invalid('A verified message reference is required before marking Sent.');
          Object.assign(record, patch, { updatedAt: new Date(time).toISOString() }); return record;
        });
      },
      withFence(fence) {
        if (!object(fence)) throw invalid('A current execution fence is required for announcement dispatch.');
        const fixed = { runId: uuid(fence.runId, 'execution'), leaseToken: uuid(fence.leaseToken, 'execution lease'), generation: fence.generation };
        if (!Number.isSafeInteger(fixed.generation) || fixed.generation < 1) throw invalid('A valid worker generation is required.');
        // get/update intentionally remain available after lease loss: late, immutable provider
        // receipt evidence can still be saved, while a new potentially consequential send cannot.
        return Object.freeze({ get: receiptStore.get, update: receiptStore.update, create: (key, input) => createReceipt(key, input, fixed) });
      },
    });
    function pruneAuthRevocations(state, time) {
      for (const [sid, record] of Object.entries(state.authRevocations)) {
        if (!UUID.test(sid) || record.sid !== sid || record.userId !== ownerId || !Number.isFinite(Date.parse(record.expiresAt))) throw new StoreError(503, 'AUTH_REVOCATION_INTEGRITY_FAILED', 'Saved account session revocations could not be verified.');
        if (Date.parse(record.expiresAt) <= time) delete state.authRevocations[sid];
      }
    }
    async function isAuthSessionRevoked(sid) {
      uuid(sid, 'account session');
      return mutate(({ state, time }) => { pruneAuthRevocations(state, time); return Object.hasOwn(state.authRevocations, sid); });
    }
    async function revokeAuthSession({ sid, expiresAt }) {
      uuid(sid, 'account session');
      const expiry = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
      if (!Number.isFinite(expiry)) throw invalid('A valid account session expiry is required.');
      return mutate(({ state, workspace, time }) => {
        pruneAuthRevocations(state, time);
        if (expiry <= time) return true;
        const existing = state.authRevocations[sid];
        if (existing && Date.parse(existing.expiresAt) >= expiry) return true;
        state.authRevocations[sid] = { sid, ownerId, workspaceId: workspace.id, userId: ownerId, revokedAt: existing?.revokedAt || new Date(time).toISOString(), expiresAt: new Date(expiry).toISOString() };
        audit(state, time, 'account_session_revoked'); return true;
      });
    }
    async function overview() { const { workspace, state } = await read(); return { workspace, events: clone(Object.values(state.events)), connections: Object.values(state.connections).map(summary), runs: clone(Object.values(state.runs)), plans: clone(Object.values(state.plans).map(plan => ({ ...plan, superseded: state.latestPlanIds[plan.eventId] !== plan.id }))) }; }
    return Object.freeze({ ownerId, ensureWorkspace, captureRequest, listConnections, listConnectionSummaries, getConnection, upsertConnection, saveConnection: upsertConnection, beginConnectionState, markConnectionDispatch, finishConnectionState, clearEventData, getSetup, saveSetup, listEvents, getEvent, getEventMapping, saveEvent, upsertEvent: saveEvent, listPlans, getPlan, savePlan, approvePlan, getRun, listRuns, claimRun, heartbeatRun, checkpointStep, releaseRun, receiptStore, isAuthSessionRevoked, revokeAuthSession, overview });
  }
  const authSessionRegistry = Object.freeze({
    isRevoked: ({ sid, userId }) => forOwner(uuid(userId, 'verified organiser identity')).isAuthSessionRevoked(sid),
    revoke: ({ sid, userId, expiresAt }) => forOwner(uuid(userId, 'verified organiser identity')).revokeAuthSession({ sid, expiresAt }),
  });
  return Object.freeze({ configured, setupState, forOwner, listRuntimeOwners, authSessionRegistry });
}
