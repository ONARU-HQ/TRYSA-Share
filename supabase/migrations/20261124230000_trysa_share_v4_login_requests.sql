-- TRYSA Share v4 — rate limits for email sign-in links sent through Resend. Applied 2026-11-23.
-- Only hashes are stored (never raw emails or IPs). Service role only (RLS on, no grants).
create table if not exists public.trysa_share_login_requests (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists trysa_share_login_requests_email_idx on public.trysa_share_login_requests (email_hash, created_at desc);
create index if not exists trysa_share_login_requests_ip_idx on public.trysa_share_login_requests (ip_hash, created_at desc);
alter table public.trysa_share_login_requests enable row level security;
