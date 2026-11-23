// Cloudflare Worker entry for link.trysa.app (routes: /s/*, /share*, /api/share/*).
import { createApp } from './app.js';
import { createDb } from './db.js';

const appFor = (env) => createApp({ db: createDb(env), env });

export default {
  async fetch(request, env, ctx) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return new Response('TRYSA Share is not configured', { status: 503 });
    return appFor(env).handle(request, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(appFor(env).cleanup().then((n) => console.log(`TRYSA Share cleanup: ${n} sessions`)));
  },
};
