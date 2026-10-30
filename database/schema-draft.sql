-- ChangeRelay source SQL snapshot, applied to the selected Supabase project on 2026-10-30.
-- NOT a CLI migration and NOT idempotent: do not rerun this snapshot on that project.
-- Validated: 16 local PostgreSQL-engine checks and 8 live Supabase Auth/RLS/CAS checks.
-- Full Supabase advisors, pgTAP and normalized-queue contention checks remain outstanding.
-- Target: Supabase Auth, owner-only workspaces, server-side viaSocket adapter.
-- No provider token, auth_id, script_id, or raw provider response belongs in public.
begin;

create schema changerelay_private;
revoke all on schema changerelay_private from public, anon, authenticated;
grant usage on schema changerelay_private to service_role;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  timezone text not null default 'Asia/Kolkata', -- Backend validates against IANA zones.
  notification_preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(notification_preferences) = 'object'),
  is_runtime_primary boolean not null default false, -- Server-only; one operational aggregate workspace per owner.
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);
create unique index one_runtime_workspace_per_owner on public.workspaces(owner_id)
where is_runtime_primary;

-- Only a connection's friendly label and readiness appear in the browser.
create table public.connection_summaries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  app_slug text not null check (app_slug in ('google-calendar', 'google-sheets', 'gmail')),
  display_label text not null,
  status text not null check (status in ('setup_required', 'connected', 'expired', 'disconnected', 'needs_attention')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id) references public.workspaces(owner_id, id) on delete cascade,
  unique (owner_id, workspace_id, app_slug),
  unique (owner_id, workspace_id, id)
);

create table changerelay_private.connection_credentials (
  owner_id uuid not null,
  workspace_id uuid not null,
  connection_id uuid not null,
  -- Encrypt with an application/KMS key kept outside this database. No Google OAuth tokens.
  credential_ciphertext bytea not null,
  encryption_key_version text not null,
  verified_for_user_id uuid not null,
  verified_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, workspace_id, connection_id),
  foreign key (owner_id, workspace_id, connection_id) references public.connection_summaries(owner_id, workspace_id, id) on delete cascade,
  check (verified_for_user_id = owner_id)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  stable_event_id text not null check (length(btrim(stable_event_id)) between 1 and 200),
  title text not null check (length(btrim(title)) between 1 and 500),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  location text not null default '',
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (owner_id, workspace_id) references public.workspaces(owner_id, id) on delete cascade,
  unique (owner_id, workspace_id, stable_event_id),
  unique (owner_id, workspace_id, id)
);

create table public.event_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  connection_id uuid not null,
  resource_kind text not null check (resource_kind in ('calendar_event', 'schedule_row', 'participant_roster', 'volunteer_assignments')),
  display_label text not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null,
  mapping_version bigint not null default 1 check (mapping_version > 0),
  check (confirmed_by = owner_id),
  foreign key (owner_id, workspace_id, event_id) references public.events(owner_id, workspace_id, id) on delete cascade,
  foreign key (owner_id, workspace_id, connection_id) references public.connection_summaries(owner_id, workspace_id, id) on delete no action deferrable initially deferred,
  unique (owner_id, workspace_id, event_id, resource_kind),
  unique (owner_id, workspace_id, id)
);

create table changerelay_private.resource_references (
  owner_id uuid not null,
  workspace_id uuid not null,
  link_id uuid not null,
  -- Calendar/spreadsheet/tab/row identifiers and actual mapping details stay server-side.
  reference_ciphertext bytea not null,
  encryption_key_version text not null,
  primary key (owner_id, workspace_id, link_id),
  foreign key (owner_id, workspace_id, link_id) references public.event_links(owner_id, workspace_id, id) on delete cascade
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  email text not null check (length(email) <= 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text not null check (role in ('participant', 'volunteer')),
  created_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id, event_id) references public.events(owner_id, workspace_id, id) on delete cascade,
  unique (owner_id, workspace_id, event_id, email),
  unique (owner_id, workspace_id, event_id, id)
);

create table public.volunteer_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  participant_id uuid,
  person_name text not null,
  assignment_title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (owner_id, workspace_id, event_id) references public.events(owner_id, workspace_id, id) on delete cascade,
  foreign key (owner_id, workspace_id, event_id, participant_id) references public.participants(owner_id, workspace_id, event_id, id) on delete no action deferrable initially deferred
);

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  request_text text not null default '' check (length(request_text) <= 10000),
  requested_start_at timestamptz,
  notify_participants boolean not null default true,
  locked_at timestamptz, -- Server locks a request after generating its immutable plan.
  created_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id, event_id) references public.events(owner_id, workspace_id, id) on delete cascade,
  unique (owner_id, workspace_id, event_id, id)
);

create table public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  change_request_id uuid not null,
  version integer not null check (version > 0),
  event_record_version bigint not null check (event_record_version > 0),
  -- Exact schedule, selected recipients, message, warnings, semantic actions and source fingerprints.
  -- Never provider credentials or provider auth/script/resource IDs; use product-owned link IDs.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  plan_hash text not null check (plan_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id, event_id, change_request_id) references public.change_requests(owner_id, workspace_id, event_id, id) on delete cascade,
  unique (owner_id, change_request_id, version),
  unique (owner_id, workspace_id, event_id, id),
  unique (owner_id, workspace_id, event_id, id, plan_hash)
);

create function changerelay_private.hash_and_freeze_plan()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Plan versions are immutable; create a new version and obtain fresh approval.';
  end if;
  new.plan_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.snapshot::text, 'UTF8')), 'hex');
  return new;
end;
$$;
revoke execute on function changerelay_private.hash_and_freeze_plan() from public, anon, authenticated;
grant execute on function changerelay_private.hash_and_freeze_plan() to service_role;
create trigger plan_versions_immutable before insert or update on public.plan_versions
for each row execute function changerelay_private.hash_and_freeze_plan();

create table public.plan_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  plan_id uuid not null,
  approved_hash text not null,
  approved_by uuid not null,
  warnings_acknowledged boolean not null default false,
  approved_at timestamptz not null default now(),
  check (approved_by = owner_id),
  foreign key (owner_id, workspace_id, event_id, plan_id, approved_hash) references public.plan_versions(owner_id, workspace_id, event_id, id, plan_hash) on delete cascade,
  unique (owner_id, plan_id),
  unique (owner_id, workspace_id, event_id, id)
);

create table public.execution_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  approval_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'verified', 'failed', 'needs_checking', 'cancelled')),
  expected_step_count integer not null default 3 check (expected_step_count between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  last_error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id, event_id, approval_id) references public.plan_approvals(owner_id, workspace_id, event_id, id) on delete cascade,
  unique (owner_id, approval_id),
  unique (owner_id, workspace_id, event_id, id)
);
create unique index one_unfinished_run_per_event on public.execution_runs(owner_id, event_id)
where status in ('pending', 'running', 'failed', 'needs_checking');
create index execution_runs_queue on public.execution_runs(owner_id, next_attempt_at, created_at)
where status in ('pending', 'running');

create table public.execution_steps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  run_id uuid not null,
  kind text not null check (kind in ('calendar', 'sheets', 'gmail')),
  ordinal integer not null check (ordinal between 1 and 10),
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'running', 'verified', 'failed', 'needs_checking', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  summary text not null default 'Waiting to run.',
  -- Safe intended/read-back values only; no raw provider responses or provider identifiers.
  verification jsonb,
  started_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  check (kind = 'gmail' or required),
  foreign key (owner_id, workspace_id, event_id, run_id) references public.execution_runs(owner_id, workspace_id, event_id, id) on delete cascade,
  unique (owner_id, run_id, ordinal),
  unique (owner_id, run_id, kind),
  unique (owner_id, workspace_id, event_id, run_id, id)
);

create table public.notification_outcomes (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null default gen_random_uuid(), -- Persist before dispatch; reuse on reconciliation.
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  run_id uuid not null,
  participant_id uuid not null,
  recipient_email text not null,
  message_hash text not null check (message_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'dispatching', 'sent', 'needs_checking', 'acknowledged', 'skipped')),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  summary text not null default 'Not sent.',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (acknowledged_at is null or sent_at is not null),
  check (status <> 'acknowledged' or acknowledged_at is not null),
  check (status not in ('sent', 'acknowledged') or sent_at is not null),
  foreign key (owner_id, workspace_id, event_id, run_id) references public.execution_runs(owner_id, workspace_id, event_id, id) on delete cascade,
  foreign key (owner_id, workspace_id, event_id, participant_id) references public.participants(owner_id, workspace_id, event_id, id) on delete no action deferrable initially deferred,
  unique (owner_id, receipt_id),
  unique (owner_id, run_id, participant_id),
  unique (owner_id, workspace_id, receipt_id)
);

create table changerelay_private.notification_provider_records (
  owner_id uuid not null,
  workspace_id uuid not null,
  receipt_id uuid not null,
  provider_reference_ciphertext bytea,
  encryption_key_version text,
  dispatch_started_at timestamptz,
  reconciled_at timestamptz,
  primary key (owner_id, workspace_id, receipt_id),
  foreign key (owner_id, workspace_id, receipt_id) references public.notification_outcomes(owner_id, workspace_id, receipt_id) on delete cascade
);

create table changerelay_private.run_leases (
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid not null,
  run_id uuid not null,
  worker_id text not null check (length(worker_id) between 1 and 128),
  lease_token uuid not null default gen_random_uuid(),
  generation bigint not null default 1 check (generation > 0),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  primary key (owner_id, event_id),
  unique (owner_id, run_id),
  foreign key (owner_id, workspace_id, event_id, run_id) references public.execution_runs(owner_id, workspace_id, event_id, id) on delete cascade
);

-- Operational persistence bridge. The server encrypts the complete engine aggregate.
-- Normalized public tables above remain optional reporting models until populated.
create table changerelay_private.runtime_state (
  owner_id uuid not null,
  workspace_id uuid not null,
  revision bigint not null check (revision > 0),
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 2097152),
  key_version text not null check (length(btrim(key_version)) between 1 and 100),
  updated_at timestamptz not null default now(),
  primary key (owner_id, workspace_id),
  foreign key (owner_id, workspace_id) references public.workspaces(owner_id, id) on delete cascade
);

create table public.audit_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  workspace_id uuid not null,
  event_id uuid,
  actor_id uuid,
  action text not null,
  safe_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_summary) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (owner_id, workspace_id) references public.workspaces(owner_id, id) on delete cascade,
  foreign key (owner_id, workspace_id, event_id) references public.events(owner_id, workspace_id, id) on delete cascade
);

-- Ownership indexes: owner_id is the leading column, not merely present later.
create index volunteer_assignments_owner_time on public.volunteer_assignments(owner_id, starts_at, ends_at);
create index audit_history_owner_created on public.audit_history(owner_id, created_at desc);

-- RLS applies to every public table. Private tables also have RLS and no client policy.
alter table public.workspaces enable row level security;
alter table public.connection_summaries enable row level security;
alter table public.events enable row level security;
alter table public.event_links enable row level security;
alter table public.participants enable row level security;
alter table public.volunteer_assignments enable row level security;
alter table public.change_requests enable row level security;
alter table public.plan_versions enable row level security;
alter table public.plan_approvals enable row level security;
alter table public.execution_runs enable row level security;
alter table public.execution_steps enable row level security;
alter table public.notification_outcomes enable row level security;
alter table public.audit_history enable row level security;
alter table changerelay_private.connection_credentials enable row level security;
alter table changerelay_private.resource_references enable row level security;
alter table changerelay_private.notification_provider_records enable row level security;
alter table changerelay_private.run_leases enable row level security;
alter table changerelay_private.runtime_state enable row level security;

-- Revoke inherited/default client grants before granting the narrow intended surface.
revoke all on table public.workspaces, public.connection_summaries, public.events, public.event_links,
  public.participants, public.volunteer_assignments, public.change_requests, public.plan_versions,
  public.plan_approvals, public.execution_runs, public.execution_steps, public.notification_outcomes,
  public.audit_history from public, anon, authenticated;
revoke all on all tables in schema changerelay_private from public, anon, authenticated;
grant select on table public.workspaces, public.connection_summaries, public.events, public.event_links,
  public.participants, public.volunteer_assignments, public.change_requests, public.plan_versions,
  public.plan_approvals, public.execution_runs, public.execution_steps, public.notification_outcomes,
  public.audit_history to authenticated;
grant insert (owner_id, name, timezone, notification_preferences) on public.workspaces to authenticated;
grant update (name, timezone, notification_preferences) on public.workspaces to authenticated;
grant insert (owner_id, workspace_id, event_id, name, email, role) on public.participants to authenticated;
grant update (name, email, role) on public.participants to authenticated;
grant insert (owner_id, workspace_id, event_id, participant_id, person_name, assignment_title, starts_at, ends_at) on public.volunteer_assignments to authenticated;
grant update (participant_id, person_name, assignment_title, starts_at, ends_at) on public.volunteer_assignments to authenticated;
grant insert (owner_id, workspace_id, event_id, request_text, requested_start_at, notify_participants) on public.change_requests to authenticated;
grant update (request_text, requested_start_at, notify_participants) on public.change_requests to authenticated;
grant select, insert, update, delete on table public.workspaces, public.connection_summaries, public.events,
  public.event_links, public.participants, public.volunteer_assignments, public.change_requests,
  public.execution_runs, public.execution_steps, public.notification_outcomes to service_role;
grant select, insert, delete on table public.plan_versions, public.plan_approvals, public.audit_history to service_role;
grant select, insert, update, delete on all tables in schema changerelay_private to service_role;

create policy workspaces_owner_select on public.workspaces for select to authenticated
using (owner_id = (select auth.uid()));
create policy workspaces_owner_insert on public.workspaces for insert to authenticated
with check (owner_id = (select auth.uid()) and deletion_requested_at is null);
create policy workspaces_owner_update on public.workspaces for update to authenticated
using (owner_id = (select auth.uid()) and deletion_requested_at is null)
with check (owner_id = (select auth.uid()) and deletion_requested_at is null);

-- Each read checks BOTH row ownership and the actual parent workspace, with no policy cycle.
create policy connection_summaries_owner_select on public.connection_summaries for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = connection_summaries.workspace_id and w.owner_id = connection_summaries.owner_id and w.deletion_requested_at is null));
create policy events_owner_select on public.events for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = events.workspace_id and w.owner_id = events.owner_id and w.deletion_requested_at is null));
create policy event_links_owner_select on public.event_links for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = event_links.workspace_id and w.owner_id = event_links.owner_id and w.deletion_requested_at is null));
create policy participants_owner_select on public.participants for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = participants.workspace_id and w.owner_id = participants.owner_id and w.deletion_requested_at is null));
create policy volunteer_assignments_owner_select on public.volunteer_assignments for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = volunteer_assignments.workspace_id and w.owner_id = volunteer_assignments.owner_id and w.deletion_requested_at is null));
create policy change_requests_owner_select on public.change_requests for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = change_requests.workspace_id and w.owner_id = change_requests.owner_id and w.deletion_requested_at is null));
create policy plan_versions_owner_select on public.plan_versions for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = plan_versions.workspace_id and w.owner_id = plan_versions.owner_id and w.deletion_requested_at is null));
create policy plan_approvals_owner_select on public.plan_approvals for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = plan_approvals.workspace_id and w.owner_id = plan_approvals.owner_id and w.deletion_requested_at is null));
create policy execution_runs_owner_select on public.execution_runs for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = execution_runs.workspace_id and w.owner_id = execution_runs.owner_id and w.deletion_requested_at is null));
create policy execution_steps_owner_select on public.execution_steps for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = execution_steps.workspace_id and w.owner_id = execution_steps.owner_id and w.deletion_requested_at is null));
create policy notification_outcomes_owner_select on public.notification_outcomes for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = notification_outcomes.workspace_id and w.owner_id = notification_outcomes.owner_id and w.deletion_requested_at is null));
create policy audit_history_owner_select on public.audit_history for select to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = audit_history.workspace_id and w.owner_id = audit_history.owner_id and w.deletion_requested_at is null));

create policy participants_owner_insert on public.participants for insert to authenticated
with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = participants.workspace_id and w.owner_id = participants.owner_id and w.deletion_requested_at is null));
create policy participants_owner_update on public.participants for update to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = participants.workspace_id and w.owner_id = participants.owner_id and w.deletion_requested_at is null))
with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = participants.workspace_id and w.owner_id = participants.owner_id and w.deletion_requested_at is null));
create policy volunteer_assignments_owner_insert on public.volunteer_assignments for insert to authenticated
with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = volunteer_assignments.workspace_id and w.owner_id = volunteer_assignments.owner_id and w.deletion_requested_at is null));
create policy volunteer_assignments_owner_update on public.volunteer_assignments for update to authenticated
using (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = volunteer_assignments.workspace_id and w.owner_id = volunteer_assignments.owner_id and w.deletion_requested_at is null))
with check (owner_id = (select auth.uid()) and exists (select 1 from public.workspaces w where w.id = volunteer_assignments.workspace_id and w.owner_id = volunteer_assignments.owner_id and w.deletion_requested_at is null));
create policy change_requests_owner_insert on public.change_requests for insert to authenticated
with check (owner_id = (select auth.uid()) and locked_at is null and exists (select 1 from public.workspaces w where w.id = change_requests.workspace_id and w.owner_id = change_requests.owner_id and w.deletion_requested_at is null));
create policy change_requests_owner_update on public.change_requests for update to authenticated
using (owner_id = (select auth.uid()) and locked_at is null and exists (select 1 from public.workspaces w where w.id = change_requests.workspace_id and w.owner_id = change_requests.owner_id and w.deletion_requested_at is null))
with check (owner_id = (select auth.uid()) and locked_at is null and exists (select 1 from public.workspaces w where w.id = change_requests.workspace_id and w.owner_id = change_requests.owner_id and w.deletion_requested_at is null));

-- Service-role-only RPC. The caller still supplies the authenticated owner explicitly.
-- RLS bypass is NOT an owner filter: every statement below scopes owner_id itself.
create function public.claim_execution_run(p_owner_id uuid, p_worker_id text, p_lease_seconds integer default 60)
returns table (run_id uuid, lease_token uuid, generation bigint, expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare
  candidate public.execution_runs%rowtype;
  acquired changerelay_private.run_leases%rowtype;
begin
  if p_owner_id is null or p_worker_id is null or length(p_worker_id) not between 1 and 128 or p_lease_seconds is null or p_lease_seconds not between 15 and 120 then
    raise exception 'Valid owner, worker identity and a 15–120 second lease are required.';
  end if;
  select r.* into candidate
  from public.execution_runs r
  join public.workspaces w on w.owner_id = r.owner_id and w.id = r.workspace_id
  left join changerelay_private.run_leases l on l.owner_id = r.owner_id and l.event_id = r.event_id
  where r.owner_id = p_owner_id and w.deletion_requested_at is null
    and r.status in ('pending', 'running') and r.next_attempt_at <= pg_catalog.clock_timestamp()
    and (l.run_id is null or l.expires_at <= pg_catalog.clock_timestamp())
  order by r.created_at, r.id
  limit 1 for update of r skip locked;
  if not found then return; end if;

  -- An expired lease cannot establish whether an external operation completed.
  -- Pause in-flight operations for reconciliation, especially an uncertain email send.
  if exists (select 1 from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = candidate.id and s.status = 'running')
    or exists (select 1 from public.notification_outcomes n where n.owner_id = p_owner_id and n.run_id = candidate.id and n.status = 'dispatching') then
    update public.execution_steps s set status = 'needs_checking', summary = 'Worker lease expired while an operation was in flight; reconcile before retry.', updated_at = pg_catalog.clock_timestamp()
      where s.owner_id = p_owner_id and s.run_id = candidate.id and s.status = 'running';
    update public.notification_outcomes n set status = 'needs_checking', summary = 'The send result is uncertain. Check the provider before any resend.', updated_at = pg_catalog.clock_timestamp()
      where n.owner_id = p_owner_id and n.run_id = candidate.id and n.status = 'dispatching';
    update public.execution_runs r set status = 'needs_checking', last_error_summary = 'Expired in-flight operation requires reconciliation.', updated_at = pg_catalog.clock_timestamp()
      where r.owner_id = p_owner_id and r.id = candidate.id;
    delete from changerelay_private.run_leases l where l.owner_id = p_owner_id and l.event_id = candidate.event_id and l.expires_at <= pg_catalog.clock_timestamp();
    return;
  end if;

  insert into changerelay_private.run_leases as current_lease (owner_id, workspace_id, event_id, run_id, worker_id, lease_token, generation, expires_at, heartbeat_at)
  values (p_owner_id, candidate.workspace_id, candidate.event_id, candidate.id, p_worker_id, pg_catalog.gen_random_uuid(), 1, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds), pg_catalog.clock_timestamp())
  on conflict (owner_id, event_id) do update set run_id = excluded.run_id, worker_id = excluded.worker_id, lease_token = excluded.lease_token,
    generation = current_lease.generation + 1, expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at
  where current_lease.owner_id = p_owner_id and current_lease.expires_at <= pg_catalog.clock_timestamp()
  returning * into acquired;
  if not found then return; end if;
  update public.execution_runs r set status = 'running', updated_at = pg_catalog.clock_timestamp()
    where r.owner_id = p_owner_id and r.id = candidate.id;
  return query select acquired.run_id, acquired.lease_token, acquired.generation, acquired.expires_at;
end;
$$;
revoke execute on function public.claim_execution_run(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_execution_run(uuid, text, integer) to service_role;

create function public.renew_execution_lease(p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_generation bigint, p_lease_seconds integer default 60)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare new_expiry timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 120 then raise exception 'Lease duration must be 15–120 seconds.'; end if;
  -- Lock order is always run -> lease -> step, matching claim/checkpoint/release.
  perform 1 from public.execution_runs r where r.owner_id = p_owner_id and r.id = p_run_id and r.status = 'running' for update;
  if not found then raise exception 'No running execution exists for this owner.'; end if;
  update changerelay_private.run_leases l set expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds), heartbeat_at = pg_catalog.clock_timestamp()
  where l.owner_id = p_owner_id and l.run_id = p_run_id and l.lease_token = p_lease_token and l.generation = p_generation
    and l.expires_at > pg_catalog.clock_timestamp()
    and exists (select 1 from public.execution_runs r join public.workspaces w on w.owner_id = r.owner_id and w.id = r.workspace_id where r.owner_id = p_owner_id and r.id = p_run_id and r.status = 'running' and w.deletion_requested_at is null)
  returning l.expires_at into new_expiry;
  if not found then raise exception 'Lease was lost or expired. Do not start another external action.'; end if;
  return new_expiry;
end;
$$;
revoke execute on function public.renew_execution_lease(uuid, uuid, uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.renew_execution_lease(uuid, uuid, uuid, bigint, integer) to service_role;

create function public.checkpoint_execution_step(p_owner_id uuid, p_run_id uuid, p_step_id uuid, p_lease_token uuid, p_generation bigint, p_status text, p_summary text, p_verification jsonb default null)
returns public.execution_steps language plpgsql security invoker set search_path = '' as $$
declare
  lease_row changerelay_private.run_leases%rowtype;
  step_row public.execution_steps%rowtype;
begin
  perform 1 from public.execution_runs r where r.owner_id = p_owner_id and r.id = p_run_id and r.status = 'running' for update;
  if not found then raise exception 'No running execution exists for this owner.'; end if;
  select l.* into lease_row from changerelay_private.run_leases l
  where l.owner_id = p_owner_id and l.run_id = p_run_id and l.lease_token = p_lease_token and l.generation = p_generation
    and l.expires_at > pg_catalog.clock_timestamp() for update;
  if not found then raise exception 'Lease was lost or expired; checkpoint rejected.'; end if;
  select s.* into step_row from public.execution_steps s
    where s.owner_id = p_owner_id and s.run_id = p_run_id and s.id = p_step_id for update;
  if not found then raise exception 'Step not found for this owner and run.'; end if;
  if step_row.status in ('verified', 'skipped') then
    if p_status = step_row.status then return step_row; end if;
    raise exception 'A completed step cannot be rerun or rewritten.';
  end if;
  if p_status is null or p_status not in ('running', 'verified', 'failed', 'needs_checking', 'skipped') then raise exception 'Invalid step transition.'; end if;
  if p_status = 'running' and not exists (select 1 from public.workspaces w where w.owner_id = p_owner_id and w.id = step_row.workspace_id and w.deletion_requested_at is null) then raise exception 'This workspace is being removed; do not start an external action.'; end if;
  if p_status = 'running' and step_row.status not in ('pending', 'failed') then raise exception 'Reconcile this step before running it.'; end if;
  if p_status in ('verified', 'failed') and step_row.status <> 'running' then raise exception 'An operation must be marked running before recording its result.'; end if;
  if p_status = 'skipped' and (step_row.required or step_row.status <> 'pending') then raise exception 'A required or started step cannot be skipped.'; end if;
  if p_status = 'running' and exists (select 1 from public.execution_steps earlier where earlier.owner_id = p_owner_id and earlier.run_id = p_run_id and earlier.ordinal < step_row.ordinal and earlier.status not in ('verified', 'skipped')) then raise exception 'Complete and verify preceding steps first.'; end if;
  if p_status = 'verified' and (p_verification is null or pg_catalog.jsonb_typeof(p_verification) <> 'object' or p_verification = '{}'::jsonb) then raise exception 'Read-back verification evidence is required.'; end if;
  update public.execution_steps s set status = p_status, summary = pg_catalog.left(coalesce(p_summary, ''), 1000), verification = coalesce(p_verification, s.verification),
    attempts = s.attempts + case when p_status = 'running' then 1 else 0 end,
    started_at = case when p_status = 'running' then pg_catalog.clock_timestamp() else s.started_at end,
    verified_at = case when p_status = 'verified' then pg_catalog.clock_timestamp() else s.verified_at end,
    updated_at = pg_catalog.clock_timestamp()
  where s.owner_id = p_owner_id and s.run_id = p_run_id and s.id = p_step_id returning s.* into step_row;
  return step_row;
end;
$$;
revoke execute on function public.checkpoint_execution_step(uuid, uuid, uuid, uuid, bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.checkpoint_execution_step(uuid, uuid, uuid, uuid, bigint, text, text, jsonb) to service_role;

create function public.release_execution_run(p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_generation bigint)
returns text language plpgsql security invoker set search_path = '' as $$
declare final_status text; expected_count integer; actual_count bigint;
begin
  select r.expected_step_count into expected_count from public.execution_runs r where r.owner_id = p_owner_id and r.id = p_run_id and r.status = 'running' for update;
  if not found then raise exception 'No running execution exists for this owner.'; end if;
  perform 1 from changerelay_private.run_leases l
  where l.owner_id = p_owner_id and l.run_id = p_run_id and l.lease_token = p_lease_token and l.generation = p_generation and l.expires_at > pg_catalog.clock_timestamp() for update;
  if not found then raise exception 'Lease was lost or expired; release rejected.'; end if;
  select count(*) into actual_count from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = p_run_id;
  if actual_count <> expected_count then raise exception 'The saved run does not contain all planned steps.'; end if;
  if exists (select 1 from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = p_run_id and s.status = 'running')
    or exists (select 1 from public.notification_outcomes n where n.owner_id = p_owner_id and n.run_id = p_run_id and n.status = 'dispatching') then raise exception 'An operation is still in flight; checkpoint or reconcile it before release.'; end if;
  if exists (select 1 from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = p_run_id and s.status = 'needs_checking')
    or exists (select 1 from public.notification_outcomes n where n.owner_id = p_owner_id and n.run_id = p_run_id and n.status = 'needs_checking') then final_status := 'needs_checking';
  elsif exists (select 1 from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = p_run_id and s.status = 'failed') then final_status := 'failed';
  elsif exists (select 1 from public.execution_steps s where s.owner_id = p_owner_id and s.run_id = p_run_id and s.status = 'pending') then final_status := 'pending';
  else final_status := 'verified'; end if;
  update public.execution_runs r set status = final_status, updated_at = pg_catalog.clock_timestamp() where r.owner_id = p_owner_id and r.id = p_run_id;
  delete from changerelay_private.run_leases l where l.owner_id = p_owner_id and l.run_id = p_run_id and l.lease_token = p_lease_token and l.generation = p_generation;
  return final_status;
end;
$$;
revoke execute on function public.release_execution_run(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.release_execution_run(uuid, uuid, uuid, bigint) to service_role;

-- Operational aggregate RPCs are callable only by the authenticated backend's service role.
-- They never decrypt, expose, or interpret provider credentials; private schema stays unexposed.
create function public.ensure_runtime_workspace(p_owner_id uuid, p_name text default 'ChangeRelay workspace')
returns public.workspaces language plpgsql security invoker set search_path = '' as $$
declare workspace_row public.workspaces%rowtype;
begin
  if p_owner_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception 'A valid owner and workspace name are required.';
  end if;
  insert into public.workspaces as existing (owner_id, name, is_runtime_primary)
  values (p_owner_id, p_name, true)
  on conflict (owner_id) where is_runtime_primary do update set name = existing.name
  where existing.owner_id = p_owner_id and existing.deletion_requested_at is null
  returning * into workspace_row;
  if not found then raise exception using errcode = '42501', message = 'This owner workspace is being removed.'; end if;
  return workspace_row;
end;
$$;
revoke execute on function public.ensure_runtime_workspace(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_runtime_workspace(uuid, text) to service_role;

create function public.read_runtime_state(p_owner_id uuid, p_workspace_id uuid)
returns table (revision bigint, ciphertext bytea, key_version text, updated_at timestamptz, server_time timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.workspaces w where w.owner_id = p_owner_id and w.id = p_workspace_id and w.deletion_requested_at is null) then
    raise exception using errcode = '42501', message = 'Workspace not owned by this active account.';
  end if;
  return query select r.revision, r.ciphertext, r.key_version, r.updated_at, pg_catalog.clock_timestamp()
    from changerelay_private.runtime_state r where r.owner_id = p_owner_id and r.workspace_id = p_workspace_id;
end;
$$;
revoke execute on function public.read_runtime_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.read_runtime_state(uuid, uuid) to service_role;

create function public.compare_and_swap_runtime_state(p_owner_id uuid, p_workspace_id uuid, p_expected_revision bigint, p_ciphertext bytea, p_key_version text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_expected_revision is null or p_expected_revision < 0 or p_ciphertext is null or octet_length(p_ciphertext) not between 1 and 2097152 or p_key_version is null or length(btrim(p_key_version)) not between 1 and 100 then
    raise exception 'Valid revision, ciphertext up to 2 MiB, and key version are required.';
  end if;
  -- Serialize brief CAS writes with removal; no provider operation occurs in this transaction.
  perform 1 from public.workspaces w where w.owner_id = p_owner_id and w.id = p_workspace_id and w.deletion_requested_at is null for update;
  if not found then raise exception using errcode = '42501', message = 'Workspace not owned by this active account.'; end if;
  if p_expected_revision = 0 then
    insert into changerelay_private.runtime_state (owner_id, workspace_id, revision, ciphertext, key_version)
    values (p_owner_id, p_workspace_id, 1, p_ciphertext, p_key_version)
    on conflict (owner_id, workspace_id) do nothing;
    return found;
  end if;
  update changerelay_private.runtime_state r set revision = r.revision + 1, ciphertext = p_ciphertext, key_version = p_key_version, updated_at = pg_catalog.clock_timestamp()
  where r.owner_id = p_owner_id and r.workspace_id = p_workspace_id and r.revision = p_expected_revision;
  return found;
end;
$$;
revoke execute on function public.compare_and_swap_runtime_state(uuid, uuid, bigint, bytea, text) from public, anon, authenticated;
grant execute on function public.compare_and_swap_runtime_state(uuid, uuid, bigint, bytea, text) to service_role;

commit;
