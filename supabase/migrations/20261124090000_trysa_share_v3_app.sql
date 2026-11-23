-- TRYSA Share v3 — app features: opt-in previews, web push, resumable (TUS) uploads.
-- Status: PROPOSED. Apply after 20261123120000_trysa_share_v2_qr_send.sql.

begin;

-- ---------------------------------------------------------------- opt-in preview thumbnail
-- A small, EXIF-free JPEG made on the sender's phone. Shown before acceptance only if the sender allowed it.
alter table public.trysa_share_sessions
  add column if not exists show_preview boolean not null default false,
  add column if not exists preview_path text,
  add column if not exists preview_status text not null default 'none';
alter table public.trysa_share_sessions drop constraint if exists trysa_share_sessions_preview_status_check;
alter table public.trysa_share_sessions add constraint trysa_share_sessions_preview_status_check
  check (preview_status in ('none', 'pending', 'verified', 'deleted'));

-- ---------------------------------------------------------------- web push subscriptions
create table if not exists public.trysa_share_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0
);
create index if not exists trysa_share_push_user_idx on public.trysa_share_push_subscriptions (user_id);
alter table public.trysa_share_push_subscriptions enable row level security;
-- No grants: only the Worker (service role) reads or writes subscriptions.

-- ---------------------------------------------------------------- resumable uploads (TUS)
-- Lets a signed-in sender upload, with resume, ONLY the exact object paths the API reserved
-- for their own transfer while it is still uploading. Nothing else in the bucket is writable or readable.
create or replace function public.trysa_share_can_upload(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trysa_share_files f
      join public.trysa_share_sessions s on s.id = f.session_id
     where f.object_path = p_name and f.upload_status = 'pending'
       and s.status = 'uploading' and s.sender_user_id = auth.uid() and s.expires_at > now()
  ) or exists (
    select 1 from public.trysa_share_sessions s
     where s.preview_path = p_name and s.preview_status = 'pending'
       and s.status = 'uploading' and s.sender_user_id = auth.uid() and s.expires_at > now()
  );
$$;
revoke all on function public.trysa_share_can_upload(text) from public, anon;
grant execute on function public.trysa_share_can_upload(text) to authenticated;

drop policy if exists "trysa share: sender uploads reserved objects" on storage.objects;
create policy "trysa share: sender uploads reserved objects" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'trysa-share-private' and public.trysa_share_can_upload(name));

-- TUS resume needs to read the upload's own state while it is in progress.
drop policy if exists "trysa share: sender resumes reserved objects" on storage.objects;
create policy "trysa share: sender resumes reserved objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'trysa-share-private' and public.trysa_share_can_upload(name));

commit;
