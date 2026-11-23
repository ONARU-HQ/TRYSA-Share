// TRYSA Share service worker: app-shell cache, Android/desktop share target, push wake-ups.
const SHELL = 'trysa-share-shell-v1';
const SHELL_FILES = ['/share/', '/share/app.css', '/share/app.js', '/share/nearby-client.js', '/share/icon.svg',
  '/share/vendor/supabase.js', '/share/vendor/tus.min.js', '/share/vendor/qrcode.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('trysa-share-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // System share sheet → TRYSA Share (Web Share Target, POST multipart).
  if (url.pathname === '/share/receive-share' && e.request.method === 'POST') { e.respondWith(receiveShare(e.request)); return; }
  // App shell: network first (fresh deploys), cache fallback (offline / flaky networks). Never cache API calls.
  if (e.request.method === 'GET' && url.pathname.startsWith('/share/') && !url.pathname.startsWith('/share/_')) {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) caches.open(SHELL).then((c) => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('media').filter((f) => f instanceof File);
  const c = await caches.open('trysa-share-target');
  const index = [];
  for (const [i, f] of files.entries()) {
    const key = `/share/_shared/${Date.now()}-${i}`;
    await c.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
    index.push({ key, name: f.name, type: f.type });
  }
  await c.put('/share/_shared/index', new Response(JSON.stringify(index)));
  return Response.redirect('/share/?shared=1', 303);
}

// Pushes carry no data. We wake up, read the inbox with the app's mirrored short-lived
// token, and describe the request ourselves; if the token is stale we show a generic alert.
self.addEventListener('push', (e) => { e.waitUntil(onPush()); });
async function onPush() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: 'inbox' });
  let title = 'TRYSA Share', body = 'Someone would like to share files with you.';
  try {
    const auth = await (await (await caches.open('trysa-share-auth')).match('/share/_auth'))?.json();
    if (auth && auth.expires_at * 1000 > Date.now()) {
      const r = await fetch('/api/share/v1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.access_token}` }, body: JSON.stringify({ action: 'inbox' }) });
      const { transfers } = await r.json();
      const t = transfers.find((x) => x.receipt.status === 'requested' && x.session.receivable);
      if (t) body = `${t.sender.name.split(' ')[0]} would like to share ${t.session.kinds.replace(/^1 (\w+)$/, 'a $1')}.`;
    }
  } catch { /* fall back to generic text */ }
  if (clients.some((c) => c.visibilityState === 'visible')) return; // the open app shows its own Accept/Decline alert
  await self.registration.showNotification(title, { body, tag: 'trysa-share-incoming', renotify: true, icon: '/share/icon-192.png', badge: '/share/icon-192.png', data: { url: '/share/?inbox=1' } });
}
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).pathname.startsWith('/share'));
    if (open) { await open.focus(); open.postMessage({ type: 'inbox' }); } else await self.clients.openWindow(e.notification.data.url);
  })());
});
