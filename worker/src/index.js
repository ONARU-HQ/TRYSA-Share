// Cloudflare Worker entry for link.trysa.app (routes: /s/*, /share*, /api/share/*).
import { createApp } from './app.js';
import { createDb } from './db.js';
export { NearbyRoom } from './nearby.js';

// The address the Worker is served from (e.g. a *.workers.dev staging URL) is always its own
// public base and an allowed origin, so staging works without hard-coding the hostname.
function withOrigin(env, request) {
  if (!request) return env;
  const origin = new URL(request.url).origin;
  return { ...env, PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || origin, ALLOWED_ORIGINS: [env.ALLOWED_ORIGINS, origin].filter(Boolean).join(',') };
}
const appFor = (env, request) => { const e = withOrigin(env, request); return createApp({ db: createDb(e), env: e }); };

export default {
  async fetch(request, env, ctx) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return new Response('TRYSA Share is not configured', { status: 503 });
    return appFor(env, request).handle(request, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(appFor(env).cleanup().then((n) => console.log(`TRYSA Share cleanup: ${n} sessions`)));
  },
};
