# Deploying TRYSA Share (staging → production)

Each step changes shared infrastructure, so each one needs the project owner's sign-off.

1. **Review and apply the migration** `supabase/migrations/20261123120000_trysa_share_v2_qr_send.sql` to project `ccaxvjrgjpaixvyrgizn`.
   - It only widens constraints and adds columns, indexes and two `service_role`-only RPCs.
   - RLS stays enabled with no grants to ordinary users.
2. **Configure the Worker** (`worker/wrangler.toml`):
   - Set `SUPABASE_PUBLISHABLE_KEY`. This is the *public* key.
   - Run `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging`. Never commit this key or send it to a browser.
3. **Deploy to staging** with `npm run deploy:staging`, then add the staging origin to the Supabase Auth redirect URLs.
4. **Test on staging with real phones** (PRD §11):
   - #1 iPhone sender → Android browser receiver, with 3 photos.
   - #2 Android sender → iPhone browser receiver, with a PDF and photos.
   - #5 Decline / expire / revoke.
   - #6 Turn off Wi-Fi mid-download, then resume.
   - Large video over mobile data.
   - **Verify on staging:** the Storage `HEAD /object/authenticated/...` size check, and that signed-upload `PUT` works from mobile Safari and Chrome.
5. **Production:**
   - Uncomment the three routes in `wrangler.toml`: `/s/*`, `/share*` and `/api/share/*` only.
   - Deploy.
   - Confirm `https://link.trysa.app/hicc-gallery` still resolves (#7).
