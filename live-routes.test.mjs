import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createChoiceCodec, createLiveService, safeLivePlan, safeLiveRun, safeSetup } from './live-routes.mjs';
import {AuthError} from './auth.mjs';
import {StoreError} from './supabase-store.mjs';
const owner='11111111-1111-4111-8111-111111111111',key=Buffer.alloc(32,7);
async function fixture(overrides={}){
  const calls={auth:0,saved:0,enabled:0};
  let setup={};
  const scope={ensureWorkspace:async()=>({id:'workspace'}),getConnection:async()=>null,listConnections:async()=>[],getSetup:async()=>structuredClone(setup),saveSetup:async patch=>(setup={...setup,...structuredClone(patch)}),overview:async()=>({workspace:{id:'workspace',name:'Test'},events:[],connections:[],runs:[],plans:[]}),upsertConnection:async()=>{calls.saved++;return {app:'google-calendar',status:'connected'};},...overrides.scope};
  const auth={configured:true,requireUser:async()=>{calls.auth++;if(overrides.anonymous)throw new AuthError(401,'signin_required','Sign in first.');return {user:{id:owner,email:'owner@example.com'}};}};
  const user={listConnections:async()=>[{id:'owned-auth',service_id:'calendar-service'}],listFlows:async()=>[],findEnabled:async()=>null,enable:async()=>{calls.enabled++;return {scriptId:'private-script'};},token:async()=>'private-embed-token',...overrides.user};
  const viasocket={user:id=>{assert.equal(id,owner);return user;},catalog:{serviceIdFor:async()=> 'calendar-service'}};
  const service=createLiveService({auth,store:{configured:true,forOwner:id=>{assert.equal(id,owner);return scope;}},viasocket,sessionKey:key,...overrides.service});
  if(overrides.direct)return {calls,scope,service,close:async()=>{},async request(path,body,{method=body===undefined?'GET':'POST',headers={}}={}){
    const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method,headers:{host:'changerelay.test',...(body===undefined?{}:{'content-type':'application/json'}),...Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),value]))}});
    let status,output;const res={setHeader(){},writeHead(code){status=code;},end(value){output=value;}};
    assert.equal(await service.routes(req,res,new URL('/api/live/'+path,'https://changerelay.test')),true);return {status,json:JSON.parse(output)};
  }};
  const server=http.createServer(async(req,res)=>{if(!await service.routes(req,res,new URL(req.url,'http://local'))){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  return {calls,scope,service,close:()=>new Promise(resolve=>server.close(resolve)),async request(path,body,{method=body===undefined?'GET':'POST',headers={}}={}){const response=await fetch(base+'/api/live/'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,json:await response.json()};}};
}
test('picker values hide provider IDs and reject cross-owner, wrong-kind, tampered and expired reuse',()=>{let now=1000;const codec=createChoiceCodec(key,{now:()=>now});const token=codec.seal(owner,'tab',{spreadsheetId:'private-provider-id',sheetId:'123'});assert.ok(!token.includes('private-provider-id'));assert.equal(codec.open(owner,'tab',token).sheetId,'123');for(const [id,kind,value]of [['other','tab',token],[owner,'calendar',token],[owner,'tab',token.slice(0,-3)+'bad']])assert.throws(()=>codec.open(id,kind,value));now+=3600001;assert.throws(()=>codec.open(owner,'tab',token));});
test('live routes require verified login and never fall through to a sample workspace',async t=>{const app=await fixture({anonymous:true});t.after(app.close);const result=await app.request('state');assert.equal(result.status,401);assert.equal(result.json.error,'Sign in first.');});
test('wrong method, external origin and non-JSON posts stop before authentication or provider work',async t=>{const app=await fixture();t.after(app.close);assert.equal((await app.request('token',undefined)).status,405);assert.equal((await app.request('preview',{}, {headers:{Origin:'https://outside.example'}})).status,403);assert.equal((await app.request('preview',{}, {headers:{'Content-Type':'text/plain'}})).status,415);assert.equal(app.calls.auth,0);});
test('unconfigured live storage returns an honest setup error',async t=>{const app=await fixture({service:{store:{configured:false}}});t.after(app.close);assert.equal((await app.request('state')).status,503);});
test('connection callback validates the current user and app before enabling or saving',async t=>{const app=await fixture();t.after(app.close);const denied=await app.request('connected',{app:'google-calendar',authId:'another-owner-auth'});assert.equal(denied.status,403);assert.equal(app.calls.enabled,0);assert.equal(app.calls.saved,0);const accepted=await app.request('connected',{app:'google-calendar',authId:'owned-auth'});assert.equal(accepted.status,200);assert.equal(app.calls.enabled,1);assert.equal(app.calls.saved,1);assert.ok(!JSON.stringify(accepted.json).includes('private-script'));});
test('a conflicting enabled account is not silently replaced',async t=>{const app=await fixture({user:{findEnabled:async()=>'other-private-script'}});t.after(app.close);assert.equal((await app.request('connected',{app:'google-calendar',authId:'owned-auth'})).status,409);assert.equal(app.calls.saved,0);assert.equal(app.calls.enabled,0);});
test('SDK provider errors never expose their status, message or connection references',async t=>{const app=await fixture({user:{listConnections:async()=>{const e=Error('provider URL contains private-script and private-token');e.status=400;e.code='provider-private-code';e.name='ViaSocketError';throw e;}}});t.after(app.close);const result=await app.request('connected',{app:'google-calendar',authId:'owned-auth'});assert.equal(result.status,503);assert.ok(!JSON.stringify(result.json).includes('private-'));assert.equal(result.json.code,'CONNECTED_SERVICE_UNAVAILABLE');});
test('selecting a schedule row that moved before confirmation cannot link another workshop',async t=>{let saved=0;const adaptersFactory=()=>({calendar:{readEvent:async()=>({})},sheets:{readRow:async()=>({_rowNumber:2,event_id:'DIFFERENT',title:'Another event'})}});const app=await fixture({scope:{saveEvent:async()=>{saved++;}},service:{adaptersFactory}});t.after(app.close);const c=createChoiceCodec(key),seal=(kind,data)=>c.seal(owner,kind,data),tab={spreadsheetId:'s1',sheetId:'t1'};const mappings=Object.fromEntries(['eventId','title','start','end','timezone','location'].map(field=>[field,seal('column',{...tab,column:field})]));const result=await app.request('map',{calendarChoice:seal('calendar',{calendarId:'c'}),calendarEventChoice:seal('calendar-event',{calendarId:'c',eventId:'e'}),spreadsheetChoice:seal('spreadsheet',{spreadsheetId:'s1'}),scheduleTabChoice:seal('tab',tab),scheduleRowChoice:seal('schedule-row',{...tab,rowNumber:2,fingerprint:'old-source'}),mappings:{schedule:mappings}});assert.equal(result.status,409);assert.match(result.json.error,/moved or changed/);assert.equal(saved,0);});
test('picker hierarchy rejects mixing choices from different spreadsheets before any data write',async t=>{const app=await fixture();t.after(app.close);const c=createChoiceCodec(key),seal=(kind,data)=>c.seal(owner,kind,data);const body={calendarChoice:seal('calendar',{calendarId:'a'}),calendarEventChoice:seal('calendar-event',{calendarId:'a',eventId:'x'}),spreadsheetChoice:seal('spreadsheet',{spreadsheetId:'s1'}),scheduleTabChoice:seal('tab',{spreadsheetId:'s2',sheetId:'t'}),scheduleRowChoice:seal('schedule-row',{spreadsheetId:'s2',sheetId:'t',rowNumber:2})};assert.equal((await app.request('map',body)).status,400);assert.equal(app.calls.saved,0);});
test('workspace responses strip provider references while retaining exact approved messages',()=>{
 const plan={id:'plan',ownerId:'private-owner',eventId:'event',version:1,hash:'hash',snapshot:{title:'Workshop',timezone:'Asia/Kolkata',calendarBefore:{eventId:'private-calendar-event',etag:'private-etag',start:'before',end:'end'},sheetBefore:{title:'Workshop',start:'before',end:'end',_spreadsheetId:'private-sheet'},target:{start:'new',end:'newend'},notify:true,notifications:[{id:'notification',recipient:'a@real.com',from:'b@real.com',subject:'Exact [CR-1234]',messageBody:'Exact body',receiptMarker:'CR-1234'}],recipients:[],conflicts:[],unavailableChecks:[]}};
 const safe=safeLivePlan(plan);assert.equal(safe.snapshot.notifications[0].messageBody,'Exact body');assert.ok(!JSON.stringify(safe).includes('private-'));
 const run=safeLiveRun({id:'run',status:'verified',steps:[{kind:'calendar',status:'verified',verification:{start:'new',end:'newend',providerMessageId:'private-message'}}]});assert.ok(!JSON.stringify(run).includes('private-message'));
});

function setupFixture({ workspaceTimezones = {} } = {}) {
  const saved = new Map(), calls = { authenticated: 0, saved: 0, providers: 0 };
  const auth = { configured: true, requireUser: async cookie => {
    calls.authenticated++;
    if (!['owner-a', 'owner-b'].includes(cookie)) throw new AuthError(401, 'signin_required', 'Sign in first.');
    return { user: { id: cookie, email: `${cookie}@example.com` } };
  } };
  const store = { configured: true, forOwner: id => {
    assert.ok(['owner-a', 'owner-b'].includes(id));
    return { ensureWorkspace: async () => ({ id: id + '-workspace', timezone: workspaceTimezones[id] || 'UTC' }), getSetup: async () => structuredClone(saved.get(id) || {}), saveSetup: async patch => {
      calls.saved++; const previous = saved.get(id) || {};
      const next = { ...previous, ...structuredClone(patch), ...(patch.preferences ? { preferences: { ...previous.preferences, ...patch.preferences } } : {}) };
      saved.set(id, next); return structuredClone(next);
    }, overview: async () => ({ workspace: { name: id, timezone: workspaceTimezones[id] || 'UTC' }, events: [], plans: [], runs: [], connections: [] }) };
  } };
  const forbiddenProvider = () => { calls.providers++; throw Error('Setup drafts must not make provider calls.'); };
  const service = createLiveService({ auth, store, viasocket: { user: forbiddenProvider, catalog: { serviceIdFor: forbiddenProvider } }, sessionKey: key, now: () => Date.parse('2026-10-30T10:00:00Z') });
  return { saved, calls, async request(path, body, { cookie = 'owner-a', method = body === undefined ? 'GET' : 'POST', origin, contentType = 'application/json' } = {}) {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(request, { method, headers: { cookie, host: 'changerelay.test', 'content-type': contentType, ...(origin ? { origin } : {}) } });
    let status, output;
    const response = { setHeader() {}, writeHead(code) { status = code; }, end(value) { output = value; } };
    assert.equal(await service.routes(request, response, new URL('/api/live/' + path, 'https://changerelay.test')), true);
    return { status, json: JSON.parse(output) };
  } };
}

test('saved onboarding resumes through safe owner-scoped state and clearing it retains preferences', async () => {
  const app = setupFixture(), onboarding = { step: 'people', selections: { calendar: 'College calendar', calendarEvent: 'AI Workshop', spreadsheet: 'Event Schedule', scheduleTab: 'Events', scheduleRow: 'AI-101 · AI Workshop', rosterTab: 'Participants' }, columns: { schedule: { eventId: 'event_id', title: 'title', start: 'start', end: 'end', timezone: 'timezone', location: 'location' }, roster: { eventId: 'event_id', name: 'name', email: 'email', role: 'role' } } };
  const posted = await app.request('setup', { version: 1, onboarding, preferences: { displayTimezone: 'Asia/Kolkata', notificationsDefault: true } });
  assert.equal(posted.status, 200); assert.deepEqual(posted.json.setup.onboarding, onboarding);
  assert.equal(posted.json.setup.updatedAt, '2026-10-30T10:00:00.000Z');
  assert.deepEqual((await app.request('state')).json.setup, posted.json.setup);
  assert.equal((await app.request('setup', { version: 1, preferences: { notificationsDefault: false } })).json.setup.preferences.displayTimezone, 'Asia/Kolkata');
  const cleared = await app.request('setup', { version: 1, onboarding: null });
  assert.equal(cleared.json.setup.onboarding, null); assert.deepEqual(cleared.json.setup.preferences, { displayTimezone: 'Asia/Kolkata', notificationsDefault: false });
  assert.equal(app.calls.providers, 0);
});

test('saved setup labels retain exact surrounding whitespace for unambiguous picker matching', async () => {
  const app = setupFixture(), onboarding = { step: 'schedule', selections: { calendar: ' College calendar ', scheduleTab: ' Events ', scheduleRow: ' AI-101 · Workshop ' }, columns: { schedule: { title: ' Event title ', eventId: ' event_id ' } } };
  assert.deepEqual((await app.request('setup', { version: 1, onboarding })).json.setup.onboarding, onboarding);
  assert.deepEqual((await app.request('state')).json.setup.onboarding, onboarding);
});

test('setup display timezone defaults to each verified workspace while an explicit UTC preference stays UTC', async () => {
  const app = setupFixture({ workspaceTimezones: { 'owner-a': 'Asia/Kolkata', 'owner-b': 'Europe/London' } });
  for (const [cookie, timezone] of [['owner-a', 'Asia/Kolkata'], ['owner-b', 'Europe/London']]) {
    assert.equal((await app.request('state', undefined, { cookie })).json.setup.preferences.displayTimezone, timezone);
    assert.equal((await app.request('setup', { version: 1, preferences: { notificationsDefault: true } }, { cookie })).json.setup.preferences.displayTimezone, timezone);
    assert.equal(app.saved.get(cookie).preferences.displayTimezone, undefined, 'An inferred display default is not saved as an explicit preference.');
  }
  const explicit = await app.request('setup', { version: 1, preferences: { displayTimezone: 'UTC' } });
  assert.equal(explicit.json.setup.preferences.displayTimezone, 'UTC');
  assert.equal((await app.request('state')).json.setup.preferences.displayTimezone, 'UTC');
  assert.equal((await app.request('setup', { version: 1, onboarding: null })).json.setup.preferences.displayTimezone, 'UTC');
  assert.equal((await app.request('state', undefined, { cookie: 'owner-b' })).json.setup.preferences.displayTimezone, 'Europe/London');
  assert.equal(app.calls.providers, 0);
  assert.equal(safeSetup({}, { workspaceTimezone: 'Invalid/Zone' }).preferences.displayTimezone, 'UTC');
});

test('setup never accepts owner references and separate organisers cannot read or overwrite saved progress', async () => {
  const app = setupFixture();
  await app.request('setup', { version: 1, onboarding: { step: 'calendar', selections: { calendar: 'Owner A calendar' } } });
  assert.equal((await app.request('state', undefined, { cookie: 'owner-b' })).json.setup.onboarding, null);
  await app.request('setup', { version: 1, preferences: { displayTimezone: 'Europe/London' } }, { cookie: 'owner-b' });
  assert.equal((await app.request('state')).json.setup.onboarding.selections.calendar, 'Owner A calendar');
  assert.equal((await app.request('state')).json.setup.preferences.displayTimezone, 'UTC');
  assert.equal((await app.request('setup', { version: 1, ownerId: 'owner-b', onboarding: null })).status, 400);
  assert.equal((await app.request('setup', { version: 1, onboarding: null }, { cookie: '' })).status, 401);
  assert.equal(app.calls.providers, 0);
});

test('setup validates version, bounded labels, mapping keys, timezone and preference types before saving', async () => {
  const app = setupFixture();
  const invalid = [
    { version: 2, onboarding: null }, { version: 1 }, { version: 1, preferences: {} },
    { version: 1, onboarding: { step: 'unknown' } },
    { version: 1, onboarding: { step: 'calendar', calendarChoice: 'opaque-choice-token' } },
    { version: 1, onboarding: { step: 'calendar', selections: { calendarId: 'provider-reference' } } },
    { version: 1, onboarding: { step: 'calendar', selections: { calendar: 'a'.repeat(601) } } },
    { version: 1, onboarding: { step: 'calendar', selections: { calendar: 'Contains\ncontrol' } } },
    { version: 1, onboarding: { step: 'schedule', columns: { schedule: { authId: 'private-reference' } } } },
    { version: 1, onboarding: { step: 'schedule', columns: { schedule: { title: [] } } } },
    { version: 1, preferences: { displayTimezone: 'Not/A-Timezone' } },
    { version: 1, preferences: { notificationsDefault: 'yes' } },
    { version: 1, preferences: { authId: 'private-reference' } },
    JSON.parse('{"version":1,"onboarding":null,"__proto__":{"ownerId":"other"}}'),
  ];
  for (const body of invalid) assert.equal((await app.request('setup', body)).status, 400);
  assert.equal(app.calls.saved, 0); assert.equal(app.calls.providers, 0);
  assert.equal((await app.request('setup', { version: 1, onboarding: { step: 'calendar', selections: { calendar: 'a'.repeat(600) } } })).status, 200);
});

test('setup rejects wrong method, external origin and non-JSON before authentication', async () => {
  const app = setupFixture();
  assert.equal((await app.request('setup')).status, 405);
  assert.equal((await app.request('setup', { version: 1, onboarding: null }, { origin: 'https://outside.example' })).status, 403);
  assert.equal((await app.request('setup', { version: 1, onboarding: null }, { contentType: 'text/plain' })).status, 415);
  assert.equal(app.calls.authenticated, 0); assert.equal(app.calls.saved, 0);
});

test('safe setup drops old arbitrary private fields and malformed drafts from state responses', async () => {
  const raw = { authId: 'private-auth', scriptId: 'private-script', calendarChoice: 'private-token', ownerId: 'private-owner', preferences: { displayTimezone: 'Asia/Kolkata', notificationsDefault: true, credential: 'private-key' }, onboarding: { step: 'calendar', selections: { calendarId: 'private-calendar-reference' } }, updatedAt: '2026-10-30T10:00:00Z' };
  const safe = safeSetup(raw);
  assert.equal(safe.onboarding, null); assert.equal(safe.preferences.notificationsDefault, true);
  assert.ok(!JSON.stringify(safe).includes('private-'));
  assert.deepEqual(safeSetup({ preferences: { displayTimezone: 'Not/A-Zone', notificationsDefault: 'yes' }, updatedAt: 'invalid' }), { version: 1, onboarding: null, preferences: { displayTimezone: 'UTC', notificationsDefault: false }, updatedAt: null });
  const app = setupFixture(); app.saved.set('owner-a', raw);
  assert.deepEqual((await app.request('state')).json.setup, safe);
});

async function connectionFixture({ paused = false, mutation = 'normal', flow = 'matching', unfinished = false, expired = false } = {}) {
  const trace = [], record = { id: 'connection-1', ownerId: owner, app: 'gmail', viaSocketUserId: owner, authId: 'private-auth', serviceId: 'private-service', scriptId: 'private-flow', displayLabel: 'Gmail', status: paused ? 'paused' : 'connected' };
  let current = paused ? 'paused' : 'active', operation, sequence = 0;
  const safe = () => ({ id: record.id, app: record.app, status: record.status, displayLabel: record.displayLabel, ...(operation ? { desiredPaused: operation.paused } : {}) });
  const scope = {
    getConnection: async () => structuredClone({ ...record, ...(operation ? { pendingOperation: operation } : {}) }),
    overview: async () => ({ workspace: { id: 'workspace', timezone: 'Asia/Kolkata' }, events: [], plans: [], runs: [], connections: [safe()] }),
    beginConnectionState: async ({ app, paused }) => {
      trace.push('begin'); assert.equal(app, 'gmail');
      if (unfinished) throw new StoreError(409, 'STORAGE_CONFLICT', 'Finish the current run first.');
      if (operation && operation.paused !== paused) throw new AuthError(409, 'pending_connection', 'Check the previous result first.');
      operation = { id: 'operation-' + (++sequence), paused, authId: record.authId, serviceId: record.serviceId, scriptId: record.scriptId, reconcileOnly: operation?.attempted === true, attempted: operation?.attempted === true };
      record.status = 'needs_attention'; return { connection: structuredClone(record), operation: structuredClone(operation) };
    },
    markConnectionDispatch: async ({ operationId }) => { assert.equal(operation.id, operationId); assert.equal(record.status, 'needs_attention'); assert.equal(operation.reconcileOnly, false); operation.attempted = true; trace.push('dispatch-checkpoint'); return true; },
    finishConnectionState: async ({ operationId, verified, reconnectRequired }) => {
      assert.equal(operation.id, operationId); trace.push(verified ? 'verified' : 'uncertain');
      record.status = reconnectRequired ? 'expired' : verified ? operation.paused ? 'paused' : 'connected' : 'needs_attention';
      if (verified || reconnectRequired) operation = null;
      return safe();
    },
  };
  const user = {
    listFlows: async () => { trace.push('list'); return flow === 'missing' ? [] : [{ id: flow === 'foreign-id' ? 'other-flow' : record.scriptId, authId: flow === 'foreign-auth' ? 'other-auth' : record.authId, serviceId: flow === 'foreign-service' ? 'other-service' : record.serviceId, status: flow === 'deleted' ? 'deleted' : current }]; },
    listConnections: async () => [{ id: record.authId, service_id: record.serviceId, isExpired: expired }],
    disableFlow: async id => { assert.equal(id, record.scriptId); assert.equal(operation.attempted, true); trace.push('disable'); if (mutation !== 'timeout-without-change' && mutation !== 'response-only') current = 'paused'; if (mutation.startsWith('timeout')) throw Error('private-provider-error'); return { id, status: '2' }; },
    enableFlow: async id => { assert.equal(id, record.scriptId); assert.equal(operation.attempted, true); trace.push('enable'); if (mutation !== 'timeout-without-change' && mutation !== 'response-only') current = 'active'; if (mutation.startsWith('timeout')) throw Error('private-provider-error'); return { id, status: '1' }; },
    enable: async () => { throw Error('Never create a replacement flow.'); },
  };
  const app = await fixture({ direct: true, scope, user });
  return { ...app, trace, record, settle: status => { current = status; } };
}

test('pause and resume verify only the exact owned flow and block local access before the SDK mutation', async () => {
  const app = await connectionFixture();
  const paused = await app.request('connection-state', { app: 'gmail', paused: true });
  assert.equal(paused.status, 200); assert.equal(paused.json.verified, true); assert.equal(paused.json.connection.status, 'paused');
  assert.ok(app.trace.indexOf('dispatch-checkpoint') < app.trace.indexOf('disable'));
  assert.equal(app.trace.filter(value => value === 'disable').length, 1);
  assert.equal(paused.json.state.connections[0].status, 'paused'); assert.ok(!JSON.stringify(paused.json).includes('private-'));
  const resumed = await app.request('connection-state', { app: 'gmail', paused: false });
  assert.equal(resumed.json.verified, true); assert.equal(resumed.json.connection.status, 'connected');
  assert.equal(app.trace.filter(value => value === 'enable').length, 1);
});

test('missing, deleted or mismatched flow references never enable or disable a replacement', async () => {
  for (const flow of ['missing', 'deleted', 'foreign-id', 'foreign-auth', 'foreign-service']) {
    const app = await connectionFixture({ paused: true, flow });
    const result = await app.request('connection-state', { app: 'gmail', paused: false });
    assert.equal(result.status, 200); assert.equal(result.json.verified, false); assert.equal(result.json.connection.status, 'needs_attention');
    assert.ok(!app.trace.includes('enable')); assert.ok(!app.trace.includes('disable'));
    assert.ok(!JSON.stringify(result.json).includes('private-'));
  }
});

test('a lost pause response is reconciled by list read-back, while an uncertain result is never blindly dispatched again', async () => {
  const applied = await connectionFixture({ mutation: 'timeout-after-change' });
  assert.equal((await applied.request('connection-state', { app: 'gmail', paused: true })).json.verified, true);
  assert.equal(applied.trace.filter(value => value === 'disable').length, 1);
  const uncertain = await connectionFixture({ mutation: 'timeout-without-change' });
  const first = await uncertain.request('connection-state', { app: 'gmail', paused: true });
  assert.equal(first.json.verified, false); assert.equal(first.json.connection.desiredPaused, true);
  assert.equal((await uncertain.request('connection-state', { app: 'gmail', paused: false })).status, 409);
  assert.equal((await uncertain.request('connection-state', { app: 'gmail', paused: true })).json.verified, false);
  assert.equal(uncertain.trace.filter(value => value === 'disable').length, 1);
  assert.equal((await uncertain.request('state')).json.connections[0].desiredPaused, true);
  uncertain.settle('paused');
  assert.equal((await uncertain.request('connection-state', { app: 'gmail', paused: true })).json.verified, true);
  assert.equal(uncertain.trace.filter(value => value === 'disable').length, 1);
});

test('mutation response strings alone are not verification and expired resume accounts can reconnect without a flow mutation', async () => {
  const responseOnly = await connectionFixture({ mutation: 'response-only' });
  assert.equal((await responseOnly.request('connection-state', { app: 'gmail', paused: true })).json.verified, false);
  const expired = await connectionFixture({ paused: true, expired: true });
  const result = await expired.request('connection-state', { app: 'gmail', paused: false });
  assert.equal(result.json.verified, false); assert.equal(result.json.connection.status, 'expired');
  assert.ok(!expired.trace.includes('enable')); assert.match(result.json.message, /reconnection/);
});

test('paused or unresolved connections block tokens and callbacks before any connection SDK call', async () => {
  for (const paused of [true, false]) {
    const app = await connectionFixture({ paused, mutation: 'timeout-without-change' });
    if (!paused) await app.request('connection-state', { app: 'gmail', paused: true });
    const before = app.trace.length;
    assert.equal((await app.request('token', { app: 'gmail' })).status, 409);
    assert.equal((await app.request('connected', { app: 'gmail', authId: 'private-auth' })).status, 409);
    assert.equal(app.trace.length, before);
  }
});

test('unfinished-work and connection payload guards reject before any SDK side effect', async () => {
  const app = await connectionFixture({ unfinished: true });
  const result = await app.request('connection-state', { app: 'gmail', paused: true });
  assert.equal(result.status, 409); assert.deepEqual(app.trace, ['begin']);
  for (const body of [{ app: 'gmail', paused: 'yes' }, { app: 'other', paused: true }, { app: 'gmail', paused: true, authId: 'foreign' }]) assert.equal((await app.request('connection-state', body)).status, 400);
  assert.equal((await app.request('connection-state')).status, 405);
  assert.equal((await app.request('connection-state', { app: 'gmail', paused: true }, { headers: { Origin: 'https://outside.example' } })).status, 403);
});

test('event-data removal requires exact confirmation, keeps login and returns refreshed safe state without SDK calls', async () => {
  let clears = 0, events = [{ id: 'event-1', title: 'Workshop' }];
  const app = await fixture({ direct: true, scope: { clearEventData: async body => { assert.deepEqual(body, { confirmation: 'CLEAR EVENT DATA' }); clears++; events = []; }, overview: async () => ({ workspace: { timezone: 'Asia/Kolkata' }, events, plans: [], runs: [], connections: [{ app: 'gmail', status: 'connected' }] }) }, user: { listFlows: async () => { throw Error('No provider call allowed.'); } } });
  for (const body of [{}, { confirmation: 'CLEAR' }, { confirmation: 'CLEAR EVENT DATA', ownerId: 'other' }]) assert.equal((await app.request('clear-event-data', body)).status, 400);
  assert.equal(clears, 0);
  const cleared = await app.request('clear-event-data', { confirmation: 'CLEAR EVENT DATA' });
  assert.equal(cleared.status, 200); assert.equal(cleared.json.cleared, true); assert.deepEqual(cleared.json.state.events, []);
  assert.equal(cleared.json.state.user.id, owner); assert.equal(cleared.json.state.connections[0].status, 'connected');
  assert.equal(clears, 1); assert.equal((await app.request('clear-event-data')).status, 405);
});

test('a connection callback racing with pause never resumes or creates a flow', async () => {
  let record={status:'connected'}, release, started, resumed=0, created=0, saved=0;
  const waiting=new Promise(resolve=>{started=resolve;});
  const app=await fixture({direct:true,scope:{getConnection:async()=>({...record}),upsertConnection:async()=>{saved++;if(record.status==='paused')throw new StoreError(409,'STORAGE_CONFLICT','The app was paused.');}},user:{listFlows:async()=>{started();await new Promise(resolve=>{release=resolve;});return [{id:'private-flow',authId:'owned-auth',serviceId:'calendar-service',status:'paused'}];},enableFlow:async()=>{resumed++;},enable:async()=>{created++;}}});
  const callback=app.request('connected',{app:'google-calendar',authId:'owned-auth'});await waiting;record.status='paused';release();
  assert.equal((await callback).status,409);assert.equal(resumed,0);assert.equal(created,0);assert.equal(saved,0);
});

test('callbacks retain existing active flows but never replace missing or deleted saved flows', async () => {
  for(const status of ['active','paused','deleted','missing']){
    let created=0,resumed=0;
    const app=await fixture({direct:true,scope:{getConnection:async()=>({status:'connected',scriptId:'private-flow'})},user:{listFlows:async()=>status==='missing'?[]:[{id:'private-flow',authId:'owned-auth',serviceId:'calendar-service',status}],enable:async()=>{created++;},enableFlow:async()=>{resumed++;}}});
    assert.equal((await app.request('connected',{app:'google-calendar',authId:'owned-auth'})).status,status==='active'?200:409);
    assert.equal(created,0);assert.equal(resumed,0);
  }
});

test('first onboarding rechecks a newly saved or paused connection before enabling any flow', async () => {
  let reads=0,created=0;
  const app=await fixture({direct:true,scope:{getConnection:async()=>++reads===1?null:{status:'paused'}},user:{enable:async()=>{created++;}}});
  assert.equal((await app.request('connected',{app:'google-calendar',authId:'owned-auth'})).status,409);assert.equal(created,0);
});
