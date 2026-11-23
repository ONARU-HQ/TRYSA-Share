# Deploying TRYSA Share (staging → production)

Each step changes shared infrastructure and needs the project owner's sign-off.

## 1. Database
Review and apply the migrations to project `ccaxvjrgjpaixvyrgizn`, in order:
1. `20261123120000_trysa_share_v2_qr_send.sql`: status set, browser receipts, event idempotency, receiver-claim RPC.
2. `20261124090000_trysa_share_v3_app.sql`: preview columns, push subscriptions table, and resumable-upload storage policies. The policies only allow a sender to upload the exact file paths the API reserved for their transfer.

## 2. Worker configuration (`worker/wrangler.toml` + secrets)

| Name | Kind | Notes |
|---|---|---|
| `SUPABASE_PUBLISHABLE_KEY` | var | Public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | var / **secret** | Generate with `npm run vapid-keys`. Without them, push is simply off. |
| `VAPID_SUBJECT` | var | e.g. `mailto:support@trysa.app` |
| `NEARBY_SALT` | **secret** | Any random string. It's mixed into the hashed network key. |
| `SCANNER_URL` / `SCANNER_TOKEN` | var / secret | Optional malware scanner. It receives the file body and must return `{ "clean": bool }`. Set `SCANNER_REQUIRED=true` to block publishing while the scanner is down. |

**Plan requirement:** Durable Objects must be available on the account (the SQLite-backed ones are on the free plan).

Add the staging and production origins to Supabase Auth → URL Configuration → Redirect URLs (`…/share/`).

## 3. Staging
1. `npm run deploy:staging`
2. Real-phone checks:
   - iPhone ↔ Android **Nearby** on the same Wi-Fi.
   - Nearby on a guest network that blocks device-to-device traffic. It should offer "Send via TRYSA".
   - **QR** to a phone browser: decline, PIN, expiry, revoke.
   - **Contacts** send with the receiver's app closed. The push notification should open the Accept alert.
   - A large video over mobile data: turn on airplane mode mid-upload, then off again. The upload should resume.
   - Android: install the app, then share from Google Photos → TRYSA Share.
3. Confirm against real Supabase: resumable uploads with the user's own session (`/storage/v1/upload/resumable`), the `HEAD /object/authenticated/...` size check, and the signed-upload PUT from mobile Safari and Chrome.

## 4. Production
Uncomment the three routes in `wrangler.toml` (`/s/*`, `/share*`, `/api/share/*`) and deploy. Then confirm `https://link.trysa.app/hicc-gallery` still resolves.
