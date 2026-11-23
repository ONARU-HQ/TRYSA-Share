-- TRYSA Share v2 — QR Send, browser (no-account) receivers and the full PRD §9 state machine.
-- Status: PROPOSED. Not yet applied to project ccaxvjrgjpaixvyrgizn.
-- Safe to run on the Phase 0 tables: only widens constraints and adds nullable/defaulted columns.
-- RLS stays enabled with no ordinary-user grants; only the service role (Worker) touches these tables.

begin;

-- ---------------------------------------------------------------- sessions
-- Consumer TRYSA users may not belong to a workspace; membership is checked by the API when supplied.
alter table public.trysa_share_sessions alter column workspace_id drop not null;

alter table public.trysa_share_sessions
  add column if not exists mode text not null default 'remote',
  add column if not exists sender_display_name text,
  add column if not exists pin_hash text,
  add column if not exists pin_failures integer not null default 0,
  add column if not exists cleaned_at timestamptz;

alter table public.trysa_share_sessions drop constraint if exists trysa_share_sessions_mode_check;
alter table public.trysa_share_sessions add constraint trysa_share_sessions_mode_check
  check (mode in ('qr', 'remote'));

alter table public.trysa_share_sessions drop constraint if exists trysa_share_sessions_sender_display_name_check;
alter table public.trysa_share_sessions add constraint trysa_share_sessions_sender_display_name_check
  check (sender_display_name is null or char_length(sender_display_name) <= 80);

alter table public.trysa_share_sessions drop constraint if exists trysa_share_sessions_status_check;
alter table public.trysa_share_sessions add constraint trysa_share_sessions_status_check
  check (status in ('draft', 'uploading', 'ready', 'claimed', 'transferring', 'completed',
                    'failed', 'expired', 'revoked'));

create index if not exists trysa_share_sessions_sender_idx
  on public.trysa_share_sessions (sender_user_id, created_at desc);
create index if not exists trysa_share_sessions_cleanup_idx
  on public.trysa_share_sessions (expires_at) where cleaned_at is null;

-- ---------------------------------------------------------------- files
alter table public.trysa_share_files add column if not exists verified_at timestamptz;
alter table public.trysa_share_files drop constraint if exists trysa_share_files_upload_status_check;
alter table public.trysa_share_files add constraint trysa_share_files_upload_status_check
  check (upload_status in ('pending', 'uploaded', 'verified', 'rejected', 'deleted'));
create index if not exists trysa_share_files_session_idx on public.trysa_share_files (session_id);

-- ---------------------------------------------------------------- receipts
-- Browser receivers have no TRYSA account: they hold a random claim token (only its SHA-256 is stored).
alter table public.trysa_share_receipts alter column receiver_user_id drop not null;
alter table public.trysa_share_receipts
  add column if not exists receiver_kind text not null default 'account',
  add column if not exists claim_token_hash text,
  add column if not exists declined_at timestamptz,
  add column if not exists download_started_at timestamptz,
  add column if not exists download_count integer not null default 0;

alter table public.trysa_share_receipts drop constraint if exists trysa_share_receipts_status_check;
alter table public.trysa_share_receipts add constraint trysa_share_receipts_status_check
  check (status in ('requested', 'accepted', 'declined', 'downloading', 'downloaded'));

alter table public.trysa_share_receipts drop constraint if exists trysa_share_receipts_receiver_kind_check;
alter table public.trysa_share_receipts add constraint trysa_share_receipts_receiver_kind_check
  check ((receiver_kind = 'account' and receiver_user_id is not null and claim_token_hash is null)
      or (receiver_kind = 'browser' and receiver_user_id is null and claim_token_hash is not null));

create unique index if not exists trysa_share_receipts_claim_token_idx
  on public.trysa_share_receipts (claim_token_hash) where claim_token_hash is not null;
create index if not exists trysa_share_receipts_receiver_idx
  on public.trysa_share_receipts (receiver_user_id, created_at desc) where receiver_user_id is not null;

-- ---------------------------------------------------------------- events
-- Idempotency: replays of the same logical event (retries, double taps) are ignored.
alter table public.trysa_share_events add column if not exists idempotency_key text;
create unique index if not exists trysa_share_events_idem_idx
  on public.trysa_share_events (session_id, idempotency_key) where idempotency_key is not null;
create index if not exists trysa_share_events_session_idx
  on public.trysa_share_events (session_id, occurred_at);

-- ---------------------------------------------------------------- RPC: atomic browser claim
-- Locks the session row so concurrent scans can never exceed max_receivers.
create or replace function public.trysa_share_claim_browser(p_session_id uuid, p_token_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.trysa_share_sessions%rowtype;
  taken integer;
begin
  select * into s from public.trysa_share_sessions where id = p_session_id for update;
  if not found then return 'not_found'; end if;
  if s.status = 'revoked' then return 'revoked'; end if;
  if s.status = 'expired' or s.expires_at <= now() then return 'expired'; end if;
  if s.status not in ('ready', 'claimed', 'transferring') then return 'unavailable'; end if;

  select count(*) into taken from public.trysa_share_receipts
   where session_id = p_session_id and status in ('accepted', 'downloading', 'downloaded');
  if taken >= s.max_receivers then return 'full'; end if;

  insert into public.trysa_share_receipts (session_id, receiver_kind, claim_token_hash, status, accepted_at)
  values (p_session_id, 'browser', p_token_hash, 'accepted', now());

  if s.status = 'ready' then
    update public.trysa_share_sessions set status = 'claimed', updated_at = now() where id = p_session_id;
  end if;
  return 'accepted';
end;
$$;

-- ---------------------------------------------------------------- RPC: PIN failure counter
create or replace function public.trysa_share_pin_failure(p_session_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.trysa_share_sessions set pin_failures = pin_failures + 1, updated_at = now()
   where id = p_session_id returning pin_failures;
$$;

revoke all on function public.trysa_share_claim_browser(uuid, text) from public, anon, authenticated;
revoke all on function public.trysa_share_pin_failure(uuid) from public, anon, authenticated;
grant execute on function public.trysa_share_claim_browser(uuid, text) to service_role;
grant execute on function public.trysa_share_pin_failure(uuid) to service_role;

commit;
