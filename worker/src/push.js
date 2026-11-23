// Web Push (RFC 8030 + VAPID RFC 8292) for installed TRYSA Share web apps.
// We send *empty* pushes: no transfer data ever goes through browser push services.
// The service worker wakes up, fetches the inbox over the authenticated API and
// shows "Samson would like to share 3 photos" itself.
import { b64url } from './core.js';

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function vapidJwt(endpoint, env, now = Date.now()) {
  const pub = fromB64url(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 point');
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://link.trysa.app' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
}

/** Only allow well-known push services, so the Worker can't be used to POST to arbitrary hosts. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
export function isAllowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

/** Wake every registered device of a user. Returns number of successful deliveries. */
export async function notifyUser(db, env, userId, fetchImpl = fetch) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const subs = await db.select('trysa_share_push_subscriptions', { user_id: `eq.${userId}`, select: 'id,endpoint,failure_count' });
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetchImpl(s.endpoint, { method: 'POST', headers: {
        authorization: `vapid t=${await vapidJwt(s.endpoint, env)}, k=${env.VAPID_PUBLIC_KEY}`,
        ttl: '3600', urgency: 'high', 'content-length': '0' } });
      if (res.status === 404 || res.status === 410) {
        await db.delete('trysa_share_push_subscriptions', { id: `eq.${s.id}` }); // device unsubscribed
      } else if (res.ok) {
        ok++;
        await db.update('trysa_share_push_subscriptions', { id: `eq.${s.id}` }, { last_success_at: new Date().toISOString(), failure_count: 0 });
      } else {
        await db.update('trysa_share_push_subscriptions', { id: `eq.${s.id}` }, { failure_count: (s.failure_count || 0) + 1 });
      }
    } catch (e) { console.error('push failed', e.message); }
  }));
  return ok;
}
