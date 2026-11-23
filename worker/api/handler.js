// Vercel adapter: runs the same TRYSA Share handler (src/app.js) as a Vercel Function.
// vercel.json rewrites /s/*, /api/share/* and the cron path here, passing the original path in ?__p=.
// Not available on Vercel: Nearby (needs Cloudflare Durable Objects + WebSockets) and the
// Cloudflare rate-limit binding — the app reports Nearby as unavailable and falls back to cloud sends.
import { waitUntil } from '@vercel/functions';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';

function envFor(origin) {
  const e = process.env;
  return {
    SUPABASE_URL: e.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: e.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: e.SUPABASE_SERVICE_ROLE_KEY, BUCKET: e.BUCKET || 'trysa-share-private',
    PUBLIC_BASE_URL: e.PUBLIC_BASE_URL || origin,
    ALLOWED_ORIGINS: [e.ALLOWED_ORIGINS, origin].filter(Boolean).join(','),
    VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: e.VAPID_PRIVATE_KEY, VAPID_SUBJECT: e.VAPID_SUBJECT,
    SCANNER_URL: e.SCANNER_URL, SCANNER_TOKEN: e.SCANNER_TOKEN, SCANNER_REQUIRED: e.SCANNER_REQUIRED,
  };
}

/** Rebuild the original request URL from the rewrite's ?__p= parameter. */
export function originalRequest(request) {
  const url = new URL(request.url);
  const p = url.searchParams.get('__p');
  if (!p || !p.startsWith('/')) return request;
  url.searchParams.delete('__p');
  url.pathname = p;
  const init = { method: request.method, headers: request.headers };
  if (!['GET', 'HEAD'].includes(request.method)) { init.body = request.body; init.duplex = 'half'; }
  return new Request(url, init);
}

async function handle(request) {
  const req = originalRequest(request);
  const origin = new URL(req.url).origin;
  const env = envFor(origin);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: 'TRYSA Share is not configured' }, { status: 503 });
  const app = createApp({ db: createDb(env), env });
  if (new URL(req.url).pathname === '/api/cron/cleanup') {
    if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}` || !process.env.CRON_SECRET) return new Response('Unauthorized', { status: 401 });
    return Response.json({ cleaned: await app.cleanup() });
  }
  return app.handle(req, { waitUntil });
}

export const GET = handle, POST = handle, OPTIONS = handle, HEAD = handle;
export const config = { maxDuration: 300 };
