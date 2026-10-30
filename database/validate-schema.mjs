// Local PostgreSQL-compatible validation only. Never connects to the configured project.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.waitReady;
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;
const one = async (sql, values = []) => (await rows(sql, values))[0];
async function as(role, owner, fn) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec('begin; set local role ' + role + ';');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [owner || '']);
    const result = await fn();
    await db.exec('commit;');
    return result;
  } catch (error) { await db.exec('rollback;'); throw error; }
}
async function denied(role, owner, sql, values = [], code = '42501') {
  await assert.rejects(as(role, owner, () => db.query(sql, values)), error => error.code === code);
}

await db.exec(`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable security invoker set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`);
const schema = await readFile(new URL('./schema-draft.sql', import.meta.url), 'utf8');
try { await db.exec(schema); console.log('PASS schema executes in PostgreSQL-compatible PGlite'); }
catch (error) { console.error('FAIL schema execution:', error.message, error.code, error.detail || ''); await db.close(); process.exit(1); }

const owner = randomUUID(), stranger = randomUUID();
await db.query('insert into auth.users(id) values ($1),($2)', [owner, stranger]);
const workspace = await as('authenticated', owner, () => one('insert into public.workspaces(owner_id,name) values ($1,$2) returning *', [owner, 'Owner workspace']));
const otherWorkspace = await as('authenticated', stranger, () => one('insert into public.workspaces(owner_id,name) values ($1,$2) returning *', [stranger, 'Other workspace']));
const event = await as('service_role', null, () => one("insert into public.events(owner_id,workspace_id,stable_event_id,title,starts_at,ends_at,timezone) values($1,$2,'AI-101','AI workshop','2030-10-31T08:30:00Z','2030-10-31T09:30:00Z','Asia/Kolkata') returning *", [owner, workspace.id]));
const otherEvent = await as('service_role', null, () => one("insert into public.events(owner_id,workspace_id,stable_event_id,title,starts_at,ends_at,timezone) values($1,$2,'OTHER-101','Other workshop','2030-10-31T08:30:00Z','2030-10-31T09:30:00Z','Asia/Kolkata') returning *", [stranger, otherWorkspace.id]));
const participant = await as('authenticated', owner, () => one("insert into public.participants(owner_id,workspace_id,event_id,name,email,role) values($1,$2,$3,'Sample volunteer','sample@example.com','volunteer') returning *", [owner, workspace.id, event.id]));

async function queue(whichEvent = event, whichWorkspace = workspace, whichOwner = owner) {
  return as('service_role', null, async () => {
    const request = await one("insert into public.change_requests(owner_id,workspace_id,event_id,request_text) values($1,$2,$3,'Move to 4 pm') returning *", [whichOwner, whichWorkspace.id, whichEvent.id]);
    const plan = await one("insert into public.plan_versions(owner_id,workspace_id,event_id,change_request_id,version,event_record_version,snapshot) values($1,$2,$3,$4,1,1,$5) returning *", [whichOwner, whichWorkspace.id, whichEvent.id, request.id, { start: '2030-10-31T10:30:00Z', end: '2030-10-31T11:30:00Z', message: 'Approved sample', recipients: ['sample@example.com'] }]);
    const approval = await one('insert into public.plan_approvals(owner_id,workspace_id,event_id,plan_id,approved_hash,approved_by) values($1,$2,$3,$4,$5,$1) returning *', [whichOwner, whichWorkspace.id, whichEvent.id, plan.id, plan.plan_hash]);
    const run = await one('insert into public.execution_runs(owner_id,workspace_id,event_id,approval_id) values($1,$2,$3,$4) returning *', [whichOwner, whichWorkspace.id, whichEvent.id, approval.id]);
    const steps = [];
    for (const [index, kind] of ['calendar', 'sheets', 'gmail'].entries()) steps.push(await one('insert into public.execution_steps(owner_id,workspace_id,event_id,run_id,kind,ordinal,required) values($1,$2,$3,$4,$5,$6,$7) returning *', [whichOwner, whichWorkspace.id, whichEvent.id, run.id, kind, index + 1, kind !== 'gmail']));
    return { request, plan, approval, run, steps };
  });
}
let queued, lease;
const claim = (whichOwner = owner, seconds = 60) => as('service_role', null, () => rows('select * from public.claim_execution_run($1,$2,$3)', [whichOwner, 'local-validation', seconds]));
const checkpoint = (step, status, verification = null, token = lease?.lease_token, generation = lease?.generation) => as('service_role', null, () => one('select * from public.checkpoint_execution_step($1,$2,$3,$4,$5,$6,$7,$8)', [owner, queued.run.id, step.id, token, generation, status, 'Local validation', verification]));

test('all 18 tables enable RLS and all eight functions are invoker', async () => {
  const tables = await rows("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','changerelay_private') and c.relkind='r'");
  assert.equal(tables.length, 18); assert.ok(tables.every(table => table.relrowsecurity));
  const functions = await rows("select p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','changerelay_private') and p.proname in ('hash_and_freeze_plan','claim_execution_run','renew_execution_lease','checkpoint_execution_step','release_execution_run','ensure_runtime_workspace','read_runtime_state','compare_and_swap_runtime_state')");
  assert.equal(functions.length, 8); assert.ok(functions.every(fn => !fn.prosecdef));
});
test('owner rows visible and stranger rows hidden', async () => {
  assert.deepEqual((await as('authenticated', owner, () => rows('select id from public.events'))).map(row => row.id), [event.id]);
  assert.deepEqual((await as('authenticated', stranger, () => rows('select id from public.events'))).map(row => row.id), [otherEvent.id]);
  assert.equal((await as('authenticated', stranger, () => rows('select * from public.participants where id=$1', [participant.id]))).length, 0);
});
test('anon denied public tables and client denied private records and worker RPC', async () => {
  await denied('anon', null, 'select * from public.workspaces');
  await denied('authenticated', owner, 'select * from changerelay_private.connection_credentials');
  await denied('authenticated', owner, "select * from public.claim_execution_run($1,'browser',60)", [owner]);
});
test('client write policies reject forged ownership and foreign workspace/event parents', async () => {
  await denied('authenticated', stranger, "insert into public.workspaces(owner_id,name) values($1,'Forged')", [owner]);
  await denied('authenticated', owner, "insert into public.participants(owner_id,workspace_id,event_id,name,email,role) values($1,$2,$3,'Wrong','wrong@example.com','participant')", [owner, otherWorkspace.id, otherEvent.id]);
  await denied('authenticated', owner, "insert into public.participants(owner_id,workspace_id,event_id,name,email,role) values($1,$2,$3,'Wrong','wrong@example.com','participant')", [owner, workspace.id, otherEvent.id], '23503');
  const changed = await as('authenticated', stranger, () => rows("update public.participants set name='Stolen' where id=$1 returning id", [participant.id])); assert.equal(changed.length, 0);
  assert.equal((await as('authenticated', owner, () => one('select name from public.participants where id=$1', [participant.id]))).name, 'Sample volunteer');
});
test('client may edit permitted columns but not owner, metadata, events, connections or run state', async () => {
  assert.equal((await as('authenticated', owner, () => one("update public.participants set name='Updated name' where id=$1 returning name", [participant.id]))).name, 'Updated name');
  await denied('authenticated', owner, 'update public.participants set owner_id=$1 where id=$2', [stranger, participant.id]);
  await denied('authenticated', owner, 'update public.events set record_version=900 where id=$1', [event.id]);
  await denied('authenticated', owner, "insert into public.connection_summaries(owner_id,workspace_id,app_slug,display_label,status) values($1,$2,'gmail','Forged','connected')", [owner, workspace.id]);
});
test('plan hash generated; immutable plan and approval hash reject rewriting', async () => {
  queued = await queue();
  assert.match(queued.plan.plan_hash, /^[a-f0-9]{64}$/);
  assert.equal((await one("select encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') as expected from public.plan_versions where owner_id=$1 and id=$2", [owner, queued.plan.id])).expected, queued.plan.plan_hash);
  await denied('service_role', null, 'update public.plan_versions set snapshot=$1 where owner_id=$2 and id=$3', [{ changed: true }, owner, queued.plan.id]);
  await assert.rejects(db.query('update public.plan_versions set snapshot=$1 where owner_id=$2 and id=$3', [{ changed: true }, owner, queued.plan.id]), /immutable/);
  const alternate = await as('service_role', null, () => one('insert into public.plan_versions(owner_id,workspace_id,event_id,change_request_id,version,event_record_version,snapshot) values($1,$2,$3,$4,2,1,$5) returning *', [owner, workspace.id, event.id, queued.request.id, { start: '2030-10-31T11:30:00Z' }]));
  await denied('service_role', null, 'insert into public.plan_approvals(owner_id,workspace_id,event_id,plan_id,approved_hash,approved_by) values($1,$2,$3,$4,$5,$1)', [owner, workspace.id, event.id, alternate.id, 'a'.repeat(64)], '23503');
});
test('duplicate approved run and overlapping event run are rejected', async () => {
  await denied('service_role', null, 'insert into public.execution_runs(owner_id,workspace_id,event_id,approval_id) values($1,$2,$3,$4)', [owner, workspace.id, event.id, queued.approval.id], '23505');
  await assert.rejects(queue(), error => error.code === '23505');
  assert.equal((await rows('select * from public.execution_runs where owner_id=$1 and event_id=$2', [owner, event.id])).length, 1);
});
test('claim returns one lease, competing claim returns none; NULL/invalid durations denied', async () => {
  const claimed = await claim(); assert.equal(claimed.length, 1); lease = claimed[0]; assert.equal(lease.run_id, queued.run.id);
  assert.equal((await claim()).length, 0); assert.equal((await claim(stranger)).length, 0);
  await assert.rejects(claim(owner, null), /required/); await assert.rejects(claim(owner, 121), /required/);
});
test('fencing rejects wrong token/owner and prevents out-of-order or unsupported step transitions', async () => {
  await assert.rejects(checkpoint(queued.steps[0], 'running', null, randomUUID()), /Lease/);
  await denied('service_role', null, 'select * from public.checkpoint_execution_step($1,$2,$3,$4,$5,$6,$7,$8)', [stranger, queued.run.id, queued.steps[0].id, lease.lease_token, lease.generation, 'running', 'Wrong owner', null], 'P0001');
  await assert.rejects(checkpoint(queued.steps[1], 'running'), /preceding/);
  await assert.rejects(checkpoint(queued.steps[0], 'verified', { checked: true }), /running/);
  await assert.rejects(checkpoint(queued.steps[0], 'skipped'), /required/);
});
test('step read-back proof is required, completed steps are preserved, heartbeat renews finite lease', async () => {
  assert.equal((await checkpoint(queued.steps[0], 'running')).attempts, 1);
  await assert.rejects(checkpoint(queued.steps[0], 'verified', {}), /evidence/);
  const verified = await checkpoint(queued.steps[0], 'verified', { start: '2030-10-31T10:30:00Z', end: '2030-10-31T11:30:00Z' }); assert.equal(verified.status, 'verified');
  assert.equal((await checkpoint(queued.steps[0], 'verified', { changed: true })).attempts, 1);
  await assert.rejects(checkpoint(queued.steps[0], 'running'), /completed/);
  assert.ok((await as('service_role', null, () => one('select public.renew_execution_lease($1,$2,$3,$4,60) as expiry', [owner, queued.run.id, lease.lease_token, lease.generation]))).expiry);
});
test('expired in-flight operation moves to needs_checking and never replays', async () => {
  await checkpoint(queued.steps[1], 'running');
  await db.query("update changerelay_private.run_leases set expires_at=clock_timestamp()-interval '1 second' where owner_id=$1 and run_id=$2", [owner, queued.run.id]);
  await assert.rejects(checkpoint(queued.steps[1], 'verified', { checked: true }), /Lease/);
  assert.equal((await claim()).length, 0);
  assert.equal((await one('select status from public.execution_runs where owner_id=$1 and id=$2', [owner, queued.run.id])).status, 'needs_checking');
  assert.equal((await one('select status from public.execution_steps where owner_id=$1 and id=$2', [owner, queued.steps[0].id])).status, 'verified');
  assert.equal((await one('select status from public.execution_steps where owner_id=$1 and id=$2', [owner, queued.steps[1].id])).status, 'needs_checking');
  assert.equal((await claim()).length, 0);
});
test('reviewed recovery can resume only safe work, retaining verified steps', async () => {
  await db.query("update public.execution_steps set status='pending' where owner_id=$1 and id=$2", [owner, queued.steps[1].id]);
  await db.query("update public.execution_runs set status='pending' where owner_id=$1 and id=$2", [owner, queued.run.id]);
  [lease] = await claim(); assert.ok(lease);
  await assert.rejects(checkpoint(queued.steps[1], 'running', null, randomUUID(), 1), /Lease/);
  await checkpoint(queued.steps[1], 'running'); await checkpoint(queued.steps[1], 'verified', { checked: true });
  await checkpoint(queued.steps[2], 'skipped');
  assert.equal((await as('service_role', null, () => one('select public.release_execution_run($1,$2,$3,$4) as status', [owner, queued.run.id, lease.lease_token, lease.generation]))).status, 'verified');
});
test('receipt uniqueness prevents duplicate notification rows and keeps sent separate from acknowledged', async () => {
  const receipt = await as('service_role', null, () => one('insert into public.notification_outcomes(owner_id,workspace_id,event_id,run_id,participant_id,recipient_email,message_hash) values($1,$2,$3,$4,$5,$6,$7) returning *', [owner, workspace.id, event.id, queued.run.id, participant.id, participant.email, 'b'.repeat(64)]));
  await denied('service_role', null, 'insert into public.notification_outcomes(owner_id,workspace_id,event_id,run_id,participant_id,recipient_email,message_hash,receipt_id) values($1,$2,$3,$4,$5,$6,$7,$8)', [owner, workspace.id, event.id, queued.run.id, participant.id, participant.email, 'b'.repeat(64), receipt.receipt_id], '23505');
  await denied('service_role', null, "update public.notification_outcomes set status='acknowledged',acknowledged_at=clock_timestamp() where owner_id=$1 and receipt_id=$2", [owner, receipt.receipt_id], '23514');
  const sent = await as('service_role', null, () => one("update public.notification_outcomes set status='sent',sent_at=clock_timestamp() where owner_id=$1 and receipt_id=$2 returning *", [owner, receipt.receipt_id])); assert.equal(sent.acknowledged_at, null);
});
test('runtime workspace is single and owner-scoped; client cannot forge its server marker', async () => {
  const primary = await as('service_role', null, () => one('select * from public.ensure_runtime_workspace($1,$2)', [owner, 'Runtime workspace']));
  const repeated = await as('service_role', null, () => one('select * from public.ensure_runtime_workspace($1,$2)', [owner, 'Different label']));
  assert.equal(primary.id, repeated.id); assert.equal(repeated.name, 'Runtime workspace');
  assert.equal(primary.owner_id, owner); assert.equal(primary.is_runtime_primary, true);
  await denied('authenticated', owner, 'update public.workspaces set is_runtime_primary=true where id=$1', [workspace.id]);
  await denied('authenticated', owner, 'select * from public.ensure_runtime_workspace($1,$2)', [owner, 'Browser']);
  await denied('authenticated', owner, 'select * from changerelay_private.runtime_state');
});
test('runtime CAS stores opaque bytea, returns database time and rejects stale/cross-owner writes', async () => {
  const primary = await as('service_role', null, () => one('select * from public.ensure_runtime_workspace($1,$2)', [owner, 'Runtime workspace']));
  assert.equal((await as('service_role', null, () => rows('select * from public.read_runtime_state($1,$2)', [owner, primary.id]))).length, 0);
  const casSql = 'select public.compare_and_swap_runtime_state($1,$2,$3,$4,$5) as saved';
  const initial = await as('service_role', null, () => one(casSql, [owner, primary.id, 0, Buffer.from('010203', 'hex'), 'runtime-v1'])); assert.equal(initial.saved, true);
  assert.equal((await as('service_role', null, () => one(casSql, [owner, primary.id, 0, Buffer.from('040506', 'hex'), 'runtime-v1']))).saved, false);
  const saved = await as('service_role', null, () => one('select * from public.read_runtime_state($1,$2)', [owner, primary.id]));
  assert.equal(Number(saved.revision), 1); assert.equal(Buffer.from(saved.ciphertext).toString('hex'), '010203'); assert.ok(Number.isFinite(+new Date(saved.server_time)));
  await denied('service_role', null, 'select * from public.read_runtime_state($1,$2)', [stranger, primary.id]);
  await denied('service_role', null, casSql, [stranger, primary.id, 1, Buffer.from('00', 'hex'), 'runtime-v1']);
  await denied('authenticated', owner, casSql, [owner, primary.id, 1, Buffer.from('00', 'hex'), 'runtime-v1']);
  await assert.rejects(as('service_role', null, () => one(casSql, [owner, primary.id, null, Buffer.from('00', 'hex'), 'runtime-v1'])), /Valid revision/);
  // Two concurrent JavaScript submissions with the SAME expected revision. Each SQL call
  // is an atomic implicit transaction; exactly one succeeds. PGlite schedules one DB connection.
  await db.exec('set role service_role;');
  let contenders;
  try { contenders = await Promise.all([db.query(casSql, [owner, primary.id, 1, Buffer.from('111111', 'hex'), 'runtime-v1']), db.query(casSql, [owner, primary.id, 1, Buffer.from('222222', 'hex'), 'runtime-v1'])]); }
  finally { await db.exec('reset role;'); }
  assert.deepEqual(contenders.map(result => result.rows[0].saved).sort(), [false, true]);
  assert.equal(Number((await one('select revision from changerelay_private.runtime_state where owner_id=$1 and workspace_id=$2', [owner, primary.id])).revision), 2);
  await db.query('update public.workspaces set deletion_requested_at=clock_timestamp() where owner_id=$1 and id=$2', [owner, primary.id]);
  await denied('service_role', null, casSql, [owner, primary.id, 2, Buffer.from('00', 'hex'), 'runtime-v1']);
  await denied('service_role', null, 'select * from public.read_runtime_state($1,$2)', [owner, primary.id]);
  await denied('service_role', null, 'select * from public.ensure_runtime_workspace($1,$2)', [owner, 'Cannot recreate during removal']);
  await db.query('delete from public.workspaces where owner_id=$1 and id=$2', [owner, primary.id]);
  assert.equal((await rows('select * from changerelay_private.runtime_state where owner_id=$1 and workspace_id=$2', [owner, primary.id])).length, 0);
});
test('workspace deletion cascades owned records and preserves another owner', async () => {
  await db.query('delete from public.workspaces where owner_id=$1 and id=$2', [owner, workspace.id]);
  assert.equal((await rows('select * from public.events where owner_id=$1', [owner])).length, 0);
  assert.equal((await rows('select * from public.execution_runs where owner_id=$1', [owner])).length, 0);
  assert.equal((await rows('select * from public.notification_outcomes where owner_id=$1', [owner])).length, 0);
  assert.equal((await rows('select * from public.events where owner_id=$1 and id=$2', [stranger, otherEvent.id])).length, 1);
});

try {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log('PASS', name); }
    catch (error) { console.error('FAIL', name, error.message, error.code || '', error.detail || ''); process.exitCode = 1; }
  }
  console.log(`${passed}/${tests.length} runtime checks passed.`);
  console.log('Scope: local PGlite PostgreSQL engine with minimal Supabase auth-role stubs. Real Supabase API/Auth/pgTAP and true multi-connection lock scheduling remain untested.');
} finally { await db.close(); }
