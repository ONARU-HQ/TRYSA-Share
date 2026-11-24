-- TRYSA Share v5 — applied 2026-11-24. The Phase 0 tables were created without any grants,
-- so even the API's service_role got "permission denied". The API is the only client of these
-- tables; RLS stays enabled and anon/authenticated still have no access.
grant select, insert, update, delete on table
  public.trysa_share_sessions,
  public.trysa_share_files,
  public.trysa_share_receipts,
  public.trysa_share_events,
  public.trysa_share_push_subscriptions,
  public.trysa_share_login_requests
to service_role;
