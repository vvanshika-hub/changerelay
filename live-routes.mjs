import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { AuthError } from './auth.mjs';
import { StoreError } from './supabase-store.mjs';
import { createAiIntent, AiIntentError } from './ai-intent.mjs';
import { createLiveEngine } from './live-engine.mjs';
import { createCalendarAdapter, snapshotCalendarEvent } from './integrations/calendar.mjs';
import { createSheetsAdapter, snapshotSheetRow } from './integrations/sheets.mjs';
import { createGmailAdapter } from './integrations/gmail.mjs';

const APPS = Object.freeze({
  'google-calendar': { name: 'Google Calendar', actions: ['rowpr775r260','rowk78n47s6v','rowf3g5zquop','rowo9a3brirh'] },
  'google-sheets': { name: 'Google Sheets', actions: ['rowju3dxf5ss','rowtc0ud5uci','rowlpijbo5k1','rowetjd2kmog','rowioybw3c8a','row1qvdf0nuc'] },
  gmail: { name: 'Gmail', actions: ['rowogelpy0h6','rowr1h03w5cx','row8s689orsm'] },
});
const METHODS = { state:'GET', setup:'POST', 'clear-event-data':'POST', 'connection-state':'POST', token:'POST', connected:'POST', options:'POST', map:'POST', interpret:'POST', preview:'POST', approve:'POST', recover:'POST' };
class RouteError extends Error { constructor(status,message){super(message);this.status=status;} }
function reply(response,status,value){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));}
function string(value,label,max=1000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new RouteError(400,`Choose a valid ${label}.`);return value;}
const clone = value => structuredClone(value);
const supported = app => Object.hasOwn(APPS,app);
const rowFingerprint = row => createHash('sha256').update(JSON.stringify(Object.keys(row).filter(key=>!key.startsWith('_')).sort().map(key=>[key,row[key]]))).digest('hex');
const domainErrorNames = new Set(['LiveInputError','LiveConflictError','LiveAccessError','LiveLeaseLostError','CalendarSetupError','CalendarInputError','CalendarConflictError','SheetsSetupError','SheetsInputError','SheetsConflictError','SheetsIncompleteError','GmailSetupError','GmailInputError','GmailApprovalError','GmailStoreError']);
const SETUP_STEPS = new Set(['accounts', 'calendar', 'schedule', 'people', 'review']);
const SETUP_SELECTIONS = ['calendar', 'calendarEvent', 'spreadsheet', 'scheduleTab', 'scheduleRow', 'rosterTab', 'assignmentsTab'];
const SETUP_COLUMNS = { schedule: ['eventId', 'title', 'start', 'end', 'timezone', 'location'], roster: ['eventId', 'name', 'email', 'role'], assignments: ['person', 'eventId', 'start', 'end'] };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function setupObject(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new RouteError(400, `Choose only supported ${label} fields.`);
  return value;
}
function setupLabels(value, keys) {
  const supplied = setupObject(value, keys, 'saved label'), labels = {};
  for (const [name, label] of Object.entries(supplied)) {
    if (typeof label !== 'string' || label.length > 600 || /[\x00-\x1f\x7f]/.test(label)) throw new RouteError(400, 'Saved setup labels must be readable text of at most 600 characters.');
    if (label.trim()) labels[name] = label;
  }
  return labels;
}
function onboardingDraft(value) {
  if (value === null) return null;
  setupObject(value, ['step', 'selections', 'columns'], 'onboarding');
  if (!SETUP_STEPS.has(value.step)) throw new RouteError(400, 'Choose a supported setup step.');
  const selections = setupLabels(value.selections ?? {}, SETUP_SELECTIONS);
  const supplied = setupObject(value.columns ?? {}, Object.keys(SETUP_COLUMNS), 'column mapping'), columns = {};
  for (const [kind, labels] of Object.entries(supplied)) columns[kind] = setupLabels(labels, SETUP_COLUMNS[kind]);
  return { step: value.step, selections, columns };
}
function displayTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new RouteError(400, 'Choose a valid display timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new RouteError(400, 'Choose a valid display timezone.'); }
  return value;
}
/** Allowlist entered setup labels/preferences; never reflect arbitrary private setup fields. */
export function safeSetup(value, { workspaceTimezone = 'UTC' } = {}) {
  let defaultTimezone = 'UTC';
  try { defaultTimezone = displayTimezone(workspaceTimezone); } catch { /* An invalid legacy workspace zone uses the safe default. */ }
  const raw = plainObject(value) ? value : {}, preferences = { displayTimezone: defaultTimezone, notificationsDefault: false };
  let onboarding = null, updatedAt = null;
  try { if (raw.onboarding !== undefined) onboarding = onboardingDraft(raw.onboarding); } catch { /* An obsolete draft never exposes arbitrary stored fields. */ }
  try { if (plainObject(raw.preferences) && raw.preferences.displayTimezone !== undefined) preferences.displayTimezone = displayTimezone(raw.preferences.displayTimezone); } catch { /* Use the safe display default. */ }
  if (plainObject(raw.preferences) && typeof raw.preferences.notificationsDefault === 'boolean') preferences.notificationsDefault = raw.preferences.notificationsDefault;
  if (typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))) updatedAt = new Date(raw.updatedAt).toISOString();
  return { version: 1, onboarding, preferences, updatedAt };
}
function setupPatch(body, time) {
  setupObject(body, ['version', 'onboarding', 'preferences'], 'setup');
  if (body.version !== 1) throw new RouteError(400, 'Use the current setup draft version.');
  const patch = { version: 1, updatedAt: new Date(time).toISOString() };
  if (Object.hasOwn(body, 'onboarding')) patch.onboarding = onboardingDraft(body.onboarding);
  if (Object.hasOwn(body, 'preferences')) {
    const supplied = setupObject(body.preferences, ['displayTimezone', 'notificationsDefault'], 'preference'), preferences = {};
    if (Object.hasOwn(supplied, 'displayTimezone')) preferences.displayTimezone = displayTimezone(supplied.displayTimezone);
    if (Object.hasOwn(supplied, 'notificationsDefault')) {
      if (typeof supplied.notificationsDefault !== 'boolean') throw new RouteError(400, 'Choose whether announcement drafting should be selected by default.');
      preferences.notificationsDefault = supplied.notificationsDefault;
    }
    if (Object.keys(preferences).length) patch.preferences = preferences;
  }
  if (!Object.hasOwn(patch, 'onboarding') && !patch.preferences) throw new RouteError(400, 'Choose setup progress or a preference to save.');
  return patch;
}
export function safeLivePlan(plan){
  if(!plan)return null;
  const source=plan.snapshot;
  return {id:plan.id,eventId:plan.eventId,version:plan.version,hash:plan.hash,createdAt:plan.createdAt,superseded:plan.superseded===true,
    snapshot:{title:source.title,timezone:source.timezone,calendarBefore:{start:source.calendarBefore.start,end:source.calendarBefore.end},sheetBefore:{title:source.sheetBefore.title,start:source.sheetBefore.start,end:source.sheetBefore.end},target:source.target,notify:source.notify,notifications:source.notifications.map(({id,recipient,from,subject,messageBody,receiptMarker})=>({id,recipient,from,subject,messageBody,receiptMarker})),recipients:source.recipients,conflicts:source.conflicts,unavailableChecks:source.unavailableChecks,calendarInvitationUpdates:'none'}};
}
export function safeLiveRun(run){return {id:run.id,eventId:run.eventId,planId:run.planId,status:run.status,busy:run.busy===true,createdAt:run.createdAt,updatedAt:run.updatedAt,lastError:run.lastError,approval:run.approval,steps:run.steps.map(step=>({kind:step.kind,ordinal:step.ordinal,status:step.status,summary:step.summary,attempts:step.attempts,required:step.required,startedAt:step.startedAt,finishedAt:step.finishedAt,verification:step.kind==='gmail'?{outcomes:(step.verification?.outcomes||[]).map(x=>({receiptId:x.receiptId,status:x.status,acknowledged:false}))}:step.verification?{start:step.verification.start,end:step.verification.end}:null}))};}

/** Picker values are encrypted, time-limited and bound to the verified organiser. */
export function createChoiceCodec(secret,{now=()=>Date.now()}={}){
  const raw=Buffer.isBuffer(secret)?secret:Buffer.from(String(secret||''),/^[a-f0-9]{64}$/i.test(secret||'')?'hex':'base64');
  if(raw.length!==32)throw new RouteError(503,'Secure connection setup needs server configuration.');
  const key=Buffer.from(hkdfSync('sha256',raw,Buffer.from('ChangeRelay pickers'),Buffer.from('choice-v1'),32));
  return {
    seal(ownerId,kind,data){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(ownerId));const encrypted=Buffer.concat([cipher.update(JSON.stringify({kind,data,expires:now()+3600000})),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');},
    open(ownerId,kind,value){try{if(typeof value!=='string'||value.length>12000||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const b=Buffer.from(value,'base64url');const decipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));decipher.setAAD(Buffer.from(ownerId));decipher.setAuthTag(b.subarray(12,28));const parsed=JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString());if(parsed.kind!==kind||!Number.isFinite(parsed.expires)||parsed.expires<=now())throw Error();return parsed.data;}catch{throw new RouteError(400,'This setup choice expired or changed. Refresh the list and choose again.');}}
  };
}

export function createLiveService({auth,store,viasocket,sessionKey,now=()=>Date.now(),adaptersFactory}={}){
  let codec;
  const configured=!!auth?.configured&&!!store?.configured&&!!viasocket;
  const workerId='web-'+randomUUID();
  const aiServices=new Map();
  const servicePromises=new Map();
  async function serviceId(app){if(!supported(app))throw new RouteError(400,'Choose Calendar, Sheets or Gmail.');if(!servicePromises.has(app))servicePromises.set(app,(async()=>{if(app!=='gmail')return viasocket.catalog.serviceIdFor(app);const matches=(await viasocket.catalog.search('Gmail')).filter(x=>x.name==='Gmail');if(matches.length!==1||!matches[0].serviceId)throw new RouteError(503,'Gmail is unavailable in the current integration catalog.');return matches[0].serviceId;})().catch(error=>{servicePromises.delete(app);throw error;}));return servicePromises.get(app);}
  const choices=()=>codec??=createChoiceCodec(sessionKey,{now});
  function scopeFor(ownerId){return store.forOwner(ownerId);}
  async function adaptersForScope(ownerId,scope,loadApproval=async()=>null,fence=null){
    if(adaptersFactory)return adaptersFactory({ownerId,store:scope,loadApproval,fence});
    const connections=await scope.listConnections();
    const connection=app=>{const found=connections.find(x=>x.app===app&&x.viaSocketUserId===ownerId&&x.status==='connected');return found?.authId;};
    const args=app=>({viasocket,userId:ownerId,authId:connection(app)});
    return {calendar:connection('google-calendar')?createCalendarAdapter(args('google-calendar')):null,sheets:connection('google-sheets')?createSheetsAdapter(args('google-sheets')):null,gmail:connection('gmail')?createGmailAdapter({...args('gmail'),store:fence?scope.receiptStore.withFence(fence):scope.receiptStore,loadApproval}):null};
  }
  function engine(ownerId,scope){return createLiveEngine({ownerId,store:scope,now,adaptersFor:({loadApproval,fence})=>adaptersForScope(ownerId,scope,loadApproval,fence)});}
  async function processOwner(ownerId){const scope=scopeFor(ownerId),runs=await scope.listRuns();for(const run of runs.filter(x=>['pending','running'].includes(x.status)).slice(0,5)){await engine(ownerId,scope).execute({runId:run.id,workerId});}}
  async function workerCycle(){if(!configured)return;let afterOwnerId=null;while(true){const owners=await store.listRuntimeOwners({limit:100,afterOwnerId});for(const owner of owners){const id=typeof owner==='string'?owner:owner.ownerId||owner.owner_id;try{await processOwner(id);}catch{/* Durable pending/attention state is retained; no provider data is logged. */}}if(owners.length<100)return;const last=owners.at(-1);const next=typeof last==='string'?last:last.ownerId||last.owner_id;if(!next||next===afterOwnerId)throw new Error('Worker pagination did not advance.');afterOwnerId=next;}}
  async function context(request,response){if(!configured)throw new RouteError(503,'Live workspace setup is still in progress. The sample workspace is available.');const result=await auth.requireUser(request.headers.cookie||'');if(result.setCookie)response.setHeader('Set-Cookie',result.setCookie);const ownerId=result.user.id,scope=scopeFor(ownerId),workspace=await scope.ensureWorkspace();if(typeof scope.captureRequest==='function')await scope.captureRequest();return {ownerId,scope,workspace,user:result.user};}
  async function liveState(ctx){const overview=await ctx.scope.overview();return {...overview,user:ctx.user,mode:'live',setup:safeSetup(await ctx.scope.getSetup(),{workspaceTimezone:overview.workspace?.timezone??ctx.workspace?.timezone}),plans:overview.plans.map(safeLivePlan),runs:overview.runs.map(safeLiveRun)};}
  function connectionAvailable(connection){if(connection?.status==='paused'||connection?.pendingOperation)throw new RouteError(409,'Resume or check the saved connection before opening account setup again.');}
  async function connectionState(body,ctx){
    setupObject(body,['app','paused'],'connection state');
    const app=string(body.app,'app');if(!supported(app)||typeof body.paused!=='boolean')throw new RouteError(400,'Choose Calendar, Sheets or Gmail and whether it should be paused.');
    const started=await ctx.scope.beginConnectionState({app,paused:body.paused}),operation=started.operation,user=viasocket.user(ctx.ownerId);
    const desired=body.paused?'paused':'active';let verified=false,dispatched=false,reconnectRequired=false;
    const exactFlow=async()=>{
      const flows=await user.listFlows();
      if(!Array.isArray(flows))throw new RouteError(503,'The app connection could not be checked.');
      const matches=flows.filter(flow=>flow.id===operation.scriptId&&flow.authId===operation.authId&&flow.serviceId===operation.serviceId);
      if(matches.length!==1||!['active','paused'].includes(matches[0].status))throw new RouteError(409,'The saved app flow is unavailable. No replacement flow was created.');
      return matches[0];
    };
    try{
      const before=await exactFlow();
      if(!body.paused&&!operation.reconcileOnly){
        const accounts=await user.listConnections();
        if(!Array.isArray(accounts)||!accounts.some(account=>account.id===operation.authId&&account.service_id===operation.serviceId&&!account.isExpired)){reconnectRequired=true;throw new RouteError(409,'This app account needs reconnection before it can resume.');}
      }
      if(before.status===desired)verified=true;
      else if(!operation.reconcileOnly){
        await ctx.scope.markConnectionDispatch({app,operationId:operation.id});dispatched=true;
        if(body.paused)await user.disableFlow(operation.scriptId);else await user.enableFlow(operation.scriptId);
        verified=(await exactFlow()).status===desired;
      }
    }catch{
      // A lost mutation response does not prove failure. Reconcile only the exact saved flow;
      // never enable a new flow, restore a deleted flow, or repeat a timed-out mutation here.
      if(dispatched)try{verified=(await exactFlow()).status===desired;}catch{/* Remain blocked until an explicit status check. */}
    }
    const connection=await ctx.scope.finishConnectionState({app,operationId:operation.id,verified,reconnectRequired});
    const message=reconnectRequired?'This app account needs reconnection before it can resume. No flow change was attempted.':verified?(body.paused?'ChangeRelay access is paused for this app. Google permissions remain until you remove them in your Google account.':'ChangeRelay access is resumed for this app.'):'The connection result needs checking. This app stays blocked; check this same requested state before any opposite change.';
    return {verified,connection,state:await liveState(ctx),message};
  }
  async function options(body,{ownerId,scope}){
    const adapters=await adaptersForScope(ownerId,scope),kind=body.kind;
    const open=(type,value)=>choices().open(ownerId,type,value);
    const option=(type,data,label,extra={})=>({value:choices().seal(ownerId,type,data),label:String(label),...extra});
    const calendar=()=>{if(!adapters.calendar)throw new RouteError(409,'Connect Google Calendar first.');return adapters.calendar;};
    const sheets=()=>{if(!adapters.sheets)throw new RouteError(409,'Connect Google Sheets first.');return adapters.sheets;};
    if(kind==='calendars'){const result=await calendar().listCalendars();return {options:(result.items||[]).filter(x=>x.id).map(x=>option('calendar',{calendarId:x.id},x.summary||x.id)),more:!!result.nextPageToken};}
    if(kind==='calendarEvents'){const selected=open('calendar',body.calendarChoice||body.choice);const result=await calendar().listEvents({...selected,search:typeof body.search==='string'?body.search:''});return {options:result.events.filter(x=>x.id&&x.start?.dateTime&&!x.recurringEventId&&!x.recurrence).map(x=>option('calendar-event',{...selected,eventId:x.id},x.summary||'Untitled event',{start:x.start.dateTime,end:x.end?.dateTime,timezone:x.start.timeZone||x.end?.timeZone})),more:result.events.length>=250};}
    if(kind==='spreadsheets'){const result=await sheets().spreadsheetOptions({search:typeof body.search==='string'?body.search:''});return {options:result.options.map(x=>option('spreadsheet',{spreadsheetId:String(x.value)},x.label)),more:!!result.offset};}
    if(kind==='tabs'){const selected=open('spreadsheet',body.spreadsheetChoice||body.choice);const result=await sheets().listTabs(selected);return {options:result.sheets.filter(x=>x.properties?.sheetId!==undefined).map(x=>option('tab',{...selected,sheetId:String(x.properties.sheetId)},x.properties.title)),more:false};}
    if(kind==='columns'){const tab=open('tab',body.tabChoice||body.choice);const result=await sheets().lookupColumnOptions(tab);return {options:result.options.map(x=>option('column',{...tab,column:String(x.value)},x.label)),more:!!result.offset};}
    if(kind==='scheduleRows'){const tab=open('tab',body.tabChoice||body.choice);const result=await sheets().listRows(tab);return {options:result.map(row=>option('schedule-row',{...tab,rowNumber:row._rowNumber,fingerprint:rowFingerprint(row)},Object.entries(row).filter(([key])=>!key.startsWith('_')).slice(0,3).map(([,value])=>String(value)).join(' · '))),more:false};}
    if(kind==='senders'){if(!adapters.gmail)throw new RouteError(409,'Connect Gmail before choosing the sender.');const result=await adapters.gmail.senderOptions();return {options:result.options.map(x=>({value:x.value,label:x.label})),more:!!result.offset};}
    if(kind==='participants'){const event=await scope.getEvent(string(body.eventId,'linked event'));const mapping=await scope.getEventMapping(event.id);const roster=mapping.roster?await sheets().listRoster({...mapping.roster,eventId:mapping.schedule.eventId}):[];return {options:roster.map(person=>({value:person.email,label:person.name,...person})),more:false};}
    throw new RouteError(400,'Choose a supported setup list.');
  }
  async function mapEvent(body,{ownerId,scope}){
    const open=(kind,value)=>choices().open(ownerId,kind,value);
    const cal=open('calendar',body.calendarChoice),calEvent=open('calendar-event',body.calendarEventChoice),spreadsheet=open('spreadsheet',body.spreadsheetChoice),tab=open('tab',body.scheduleTabChoice),row=open('schedule-row',body.scheduleRowChoice);
    if(cal.calendarId!==calEvent.calendarId||tab.spreadsheetId!==spreadsheet.spreadsheetId||row.spreadsheetId!==tab.spreadsheetId||row.sheetId!==tab.sheetId)throw new RouteError(400,'Choose all event links from the selected calendar and spreadsheet.');
    const mappingFor=(selected,fields,supplied)=>Object.fromEntries(fields.map(field=>{const column=open('column',supplied?.[field]);if(column.spreadsheetId!==selected.spreadsheetId||column.sheetId!==selected.sheetId)throw new RouteError(400,'Choose each column from its selected tab.');return [field,column.column];}));
    const scheduleMapping=mappingFor(tab,['eventId','title','start','end','timezone','location'],body.mappings?.schedule);
    const adapters=await adaptersForScope(ownerId,scope);if(!adapters.calendar||!adapters.sheets)throw new RouteError(409,'Connect Calendar and Sheets first.');
    const [event,sheetRow]=await Promise.all([adapters.calendar.readEvent(calEvent),adapters.sheets.readRow({...row})]);
    if(rowFingerprint(sheetRow)!==row.fingerprint)throw new RouteError(409,'The selected schedule row moved or changed. Refresh the row list and select it again.');
    const source=snapshotSheetRow(sheetRow,scheduleMapping),calendarSource=snapshotCalendarEvent(event,source.timezone);
    const schedule={...tab,eventId:source.eventId,mapping:scheduleMapping};await adapters.sheets.lookupEvent(schedule);
    const mapping={calendar:calEvent,schedule};let participants=[],assignments=[];
    if(body.rosterTabChoice){const roster=open('tab',body.rosterTabChoice);if(roster.spreadsheetId!==spreadsheet.spreadsheetId)throw new RouteError(400,'Choose a roster tab from the selected spreadsheet.');mapping.roster={...roster,mapping:mappingFor(roster,['eventId','name','email','role'],body.mappings?.roster)};participants=await adapters.sheets.listRoster({...mapping.roster,eventId:source.eventId});}
    if(body.assignmentsTabChoice){const selected=open('tab',body.assignmentsTabChoice);if(selected.spreadsheetId!==spreadsheet.spreadsheetId)throw new RouteError(400,'Choose assignments from the selected spreadsheet.');mapping.assignments={...selected,mapping:mappingFor(selected,['person','eventId','start','end'],body.mappings?.assignments)};assignments=await adapters.sheets.listAssignments(mapping.assignments);}
    return scope.saveEvent({event:{stableEventId:source.eventId,title:event.summary||source.title,start:calendarSource.start,end:calendarSource.end,timezone:calendarSource.timeZone,location:event.location||source.location,participants,assignments},mapping});
  }
  const attempts=new Map();
  async function routes(request,response,url){
    if(!url.pathname.startsWith('/api/live/'))return false;
    try{
      const name=url.pathname.slice('/api/live/'.length),method=METHODS[name];if(!method)throw new RouteError(404,'This workspace action is unavailable.');if(request.method!==method){response.setHeader('Allow',method);throw new RouteError(405,'Method not allowed.');}
      if(method==='POST'){
        if(request.headers.origin&&!['http://'+request.headers.host,'https://'+request.headers.host].includes(request.headers.origin))throw new RouteError(403,'Request origin rejected.');
        if(!String(request.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new RouteError(415,'Send workspace requests as JSON.');
      }
      const ctx=await context(request,response);let body={};
      if(method==='POST'){
        const limitKey=ctx.ownerId+':'+name,time=now(),recent=(attempts.get(limitKey)||[]).filter(x=>x>time-60000);if(recent.length>=40)throw new RouteError(429,'Please wait a minute before trying this action again.');recent.push(time);attempts.set(limitKey,recent);if(attempts.size>5000)for(const [key,values]of attempts)if(!values.some(x=>x>time-60000))attempts.delete(key);
        let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>50000)throw new RouteError(413,'The workspace request is too large.');}try{body=JSON.parse(raw||'{}');}catch{throw new RouteError(400,'Enter a valid workspace request.');}if(!body||typeof body!=='object'||Array.isArray(body))throw new RouteError(400,'Enter a valid workspace request.');
      }
      let result;
      if(name==='state')result=await liveState(ctx);
      if(name==='setup')result={setup:safeSetup(await ctx.scope.saveSetup(setupPatch(body,now())),{workspaceTimezone:ctx.workspace?.timezone})};
      if(name==='clear-event-data'){setupObject(body,['confirmation'],'data clearing');if(body.confirmation!=='CLEAR EVENT DATA')throw new RouteError(400,'Type CLEAR EVENT DATA to remove saved event data.');await ctx.scope.clearEventData(body);aiServices.delete(ctx.ownerId);result={cleared:true,state:await liveState(ctx),message:'Saved ChangeRelay event data was cleared. Your login, app connections and original Google records are retained.'};}
      if(name==='connection-state')result=await connectionState(body,ctx);
      if(name==='token'){const app=string(body.app,'app');if(!supported(app))throw new RouteError(400,'Choose Calendar, Sheets or Gmail.');const existing=await ctx.scope.getConnection(app);connectionAvailable(existing);const user=viasocket.user(ctx.ownerId);const realConnection=existing?(await user.listConnections()).find(x=>x.id===existing.authId):null;result={token:await user.token(),serviceId:await serviceId(app),actions:APPS[app].actions,...(realConnection?.isExpired||existing?.status==='expired'?{reconnectAuthId:existing.authId}:{})};}
      if(name==='connected'){
        const app=string(body.app,'app'),authId=string(body.authId,'connected account');if(!supported(app))throw new RouteError(400,'Choose Calendar, Sheets or Gmail.');const savedConnection=await ctx.scope.getConnection(app);connectionAvailable(savedConnection);const id=await serviceId(app),user=viasocket.user(ctx.ownerId);const connection=(await user.listConnections()).find(x=>x.id===authId&&x.service_id===id);if(!connection)throw new RouteError(403,'This connection does not belong to your signed-in account. Connect it from this workspace.');if(connection.isExpired)throw new RouteError(409,'This connection expired. Connect it again.');
        const flows=await user.listFlows();let flow=flows.find(x=>x.authId===authId&&x.serviceId===id&&!['deleted','0'].includes(String(x.status).toLowerCase()));
        if(!flow){
          if(savedConnection)throw new RouteError(409,'The saved app flow is unavailable. No replacement was created. Check its access in Settings.');
          const existing=await user.findEnabled(id);if(existing)throw new RouteError(409,'Another account is enabled for this app. Reconnect that account before replacing it.');
          const latest=await ctx.scope.getConnection(app);connectionAvailable(latest);if(latest)throw new RouteError(409,'App setup changed while connecting. Refresh its saved status before trying again.');
          const enabled=await user.enable(id,authId);flow={id:enabled.scriptId,status:'active'};
        }
        if(!['active','1'].includes(String(flow.status).toLowerCase()))throw new RouteError(409,'This app flow is paused or unavailable. Use the explicit access controls in Settings; connecting never resumes or restores a flow.');
        result=await ctx.scope.upsertConnection(app,{authId,viaSocketUserId:ctx.ownerId,serviceId:id,scriptId:flow.id,displayLabel:APPS[app].name,status:'connected'});
      }
      if(name==='options')result=await options(body,ctx);
      if(name==='map')result=await mapEvent(body,ctx);
      if(name==='interpret'){
        if(!aiServices.has(ctx.ownerId)){if(aiServices.size>=2000)aiServices.delete(aiServices.keys().next().value);aiServices.set(ctx.ownerId,createAiIntent({viasocket,ownerId:ctx.ownerId,store:ctx.scope,now,calendarFor:async()=> (await adaptersForScope(ctx.ownerId,ctx.scope)).calendar}));}
        result=await aiServices.get(ctx.ownerId).interpret({eventId:body.eventId,request:body.request});
      }
      if(name==='preview')result=safeLivePlan(await engine(ctx.ownerId,ctx.scope).prepare(body));
      if(name==='approve'){const approved=await engine(ctx.ownerId,ctx.scope).approve(body);result={approval:approved.approval,run:safeLiveRun(await engine(ctx.ownerId,ctx.scope).execute({runId:approved.run.id,workerId}))};}
      if(name==='recover')result=safeLiveRun(await engine(ctx.ownerId,ctx.scope).execute({runId:string(body.runId,'saved run'),workerId,retry:true}));
      reply(response,200,result);
    }catch(error){const trusted=error instanceof RouteError||error instanceof AuthError||error instanceof StoreError||error instanceof AiIntentError||domainErrorNames.has(error.name);if(error instanceof AuthError&&error.setCookie)response.setHeader('Set-Cookie',error.setCookie);reply(response,trusted?(error.status||409):503,{error:trusted?error.message:'The connected service could not complete this request. Saved progress has been preserved. Please try again.',code:trusted?(error.code||'LIVE_REQUEST_FAILED'):'CONNECTED_SERVICE_UNAVAILABLE'});}
    return true;
  }
  return Object.freeze({configured,routes,workerCycle,processOwner,engineFor:ownerId=>engine(ownerId,scopeFor(ownerId))});
}
