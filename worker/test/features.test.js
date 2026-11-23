// Tests for app features: contacts, preview, ZIP download, content checks, web push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createFakeDb } from './fake-db.js';
import { vapidJwt, notifyUser, isAllowedEndpoint } from '../src/push.js';
import { b64url } from '../src/core.js';

const ME = { id: '11111111-1111-4111-8111-111111111111' };
const ADA = { id: '22222222-2222-4222-8222-222222222222' };
const BOB = { id: '33333333-3333-4333-8333-333333333333' };
const ZED = { id: '55555555-5555-4555-8555-555555555555' };
const WS = '44444444-4444-4444-8444-444444444444';
const BASE = 'https://link.trysa.app';

function setup(env = {}) {
  const db = createFakeDb({ users: { me: ME, ada: ADA, bob: BOB, zed: ZED } });
  db.tables.profiles.push(
    { id: ME.id, full_name: 'Samson', username: 'samson', avatar_url: 'https://cdn/s.jpg', show_avatar: true },
    { id: ADA.id, full_name: 'Ada Obi', username: 'ada', avatar_url: 'https://cdn/a.jpg', show_avatar: true },
    { id: BOB.id, full_name: 'Bob Stone', username: 'bobby', avatar_url: 'https://cdn/b.jpg', show_avatar: false },
    { id: ZED.id, full_name: 'Zed Private', username: 'zed', avatar_url: null });
  db.tables.workspace_members.push({ workspace_id: WS, user_id: ME.id }, { workspace_id: WS, user_id: ADA.id }, { workspace_id: WS, user_id: BOB.id });
  const app = createApp({ db, env: { PUBLIC_BASE_URL: BASE, ...env } });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (path, init = {}) => {
    const res = await app.handle(new Request(BASE + path, init), ctx);
    const buf = await res.arrayBuffer();
    await Promise.all(pending.splice(0));
    return new Response(buf, { status: res.status, headers: res.headers });
  };
  const api = async (tok, body) => {
    const r = await call('/api/share/v1', { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { db, call, api };
}

const JPEG = (n) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };

test('contacts: workspace co-members by name, exact @username for others, avatar privacy respected', async () => {
  const t = setup();
  const all = (await t.api('me', { action: 'contacts', q: '' })).body.people;
  assert.deepEqual(all.map((p) => p.name).sort(), ['Ada Obi', 'Bob Stone']);
  assert.equal(all.find((p) => p.username === 'bobby').avatar_url, null);
  assert.deepEqual((await t.api('me', { action: 'contacts', q: 'ad' })).body.people.map((p) => p.username), ['ada']);
  // not a co-member: only found by exact username, never by partial name
  assert.equal((await t.api('me', { action: 'contacts', q: 'Zed P' })).body.people.length, 0);
  assert.deepEqual((await t.api('me', { action: 'contacts', q: '@zed' })).body.people.map((p) => p.username), ['zed']);
  assert.equal((await t.api('me', { action: 'contacts', q: '@samson' })).body.people.length, 0, 'never yourself');
});

test('me returns the public profile and push key', async () => {
  const t = setup({ VAPID_PUBLIC_KEY: 'pub' });
  const r = await t.api('me', { action: 'me' });
  assert.deepEqual(r.body, { person: { id: ME.id, name: 'Samson', username: 'samson', avatar_url: 'https://cdn/s.jpg' }, push_public_key: 'pub' });
});

test('opt-in preview is shown before accept only when the sender allowed it', async () => {
  const t = setup();
  const files = [{ name: 'a.jpg', size: 100, type: 'image/jpeg' }, { name: 'b.jpg', size: 120, type: 'image/jpeg' }];
  const c = await t.api('me', { action: 'create', mode: 'qr', files, preview: { size: 2000 }, show_preview: true });
  assert.ok(c.body.preview_upload_url);
  assert.ok(c.body.resumable === null || c.body.resumable.bucket);
  c.body.uploads.forEach((u, i) => t.db.upload(u.upload_url, JPEG(files[i].size)));
  t.db.upload(c.body.preview_upload_url, JPEG(2000));
  assert.equal((await t.api('me', { action: 'publish', session_id: c.body.session_id })).status, 200);
  const html = await (await t.call(`/s/${c.body.short_code}`)).text();
  assert.ok(html.includes(`"preview_url":"/s/${c.body.short_code}/preview"`));
  const p = await t.call(`/s/${c.body.short_code}/preview`);
  assert.equal(p.status, 200);
  assert.equal(p.headers.get('content-type'), 'image/jpeg');

  const hidden = await t.api('me', { action: 'create', mode: 'qr', files: [files[0]], preview: { size: 2000 }, show_preview: false });
  hidden.body.uploads.forEach((u) => t.db.upload(u.upload_url, JPEG(100)));
  t.db.upload(hidden.body.preview_upload_url, JPEG(2000));
  await t.api('me', { action: 'publish', session_id: hidden.body.session_id });
  assert.equal((await t.call(`/s/${hidden.body.short_code}/preview`)).status, 404);
  assert.ok((await (await t.call(`/s/${hidden.body.short_code}`)).text()).includes('"preview_url":null'));
});

test('a broken preview never blocks the transfer', async () => {
  const t = setup();
  const c = await t.api('me', { action: 'create', mode: 'qr', files: [{ name: 'a.jpg', size: 100, type: 'image/jpeg' }], preview: { size: 50 } });
  t.db.upload(c.body.uploads[0].upload_url, JPEG(100));
  t.db.upload(c.body.preview_upload_url, new TextEncoder().encode('<svg onload=alert(1)>'.padEnd(50)));
  assert.equal((await t.api('me', { action: 'publish', session_id: c.body.session_id })).status, 200);
  assert.equal(t.db.tables.trysa_share_sessions[0].preview_status, 'none');
});

test('executables are rejected at publish', async () => {
  const t = setup();
  const c = await t.api('me', { action: 'create', mode: 'qr', files: [{ name: 'photo.jpg', size: 8, type: 'image/jpeg' }] });
  t.db.upload(c.body.uploads[0].upload_url, new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]));
  const p = await t.api('me', { action: 'publish', session_id: c.body.session_id });
  assert.equal(p.status, 422);
  assert.match(p.body.error, /Apps and programs/);
});

test('optional malware scanner verdict blocks infected files', async () => {
  const t = setup({ SCANNER_URL: 'https://scanner.internal/scan' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ clean: false });
  try {
    const c = await t.api('me', { action: 'create', mode: 'qr', files: [{ name: 'a.pdf', size: 8, type: 'application/pdf' }] });
    t.db.upload(c.body.uploads[0].upload_url, new TextEncoder().encode('%PDF-1.7'));
    const p = await t.api('me', { action: 'publish', session_id: c.body.session_id });
    assert.equal(p.status, 422);
    assert.match(p.body.error, /malware/);
  } finally { globalThis.fetch = realFetch; }
});

test('browser "Download all" ZIP delivers every file and completes the transfer', async () => {
  const t = setup();
  const files = [{ name: 'a.jpg', size: 300, type: 'image/jpeg' }, { name: 'a.jpg', size: 500, type: 'image/jpeg' }];
  const c = await t.api('me', { action: 'create', mode: 'qr', files });
  c.body.uploads.forEach((u, i) => t.db.upload(u.upload_url, JPEG(files[i].size)));
  await t.api('me', { action: 'publish', session_id: c.body.session_id });
  const acc = await t.call(`/s/${c.body.short_code}/accept`, { method: 'POST', body: '{}' });
  const cookie = acc.headers.get('set-cookie').split(';')[0];
  assert.equal((await t.call(`/s/${c.body.short_code}/zip`)).status, 403, 'no cookie, no zip');
  const z = await t.call(`/s/${c.body.short_code}/zip`, { headers: { cookie } });
  assert.equal(z.status, 200);
  const buf = new Uint8Array(await z.arrayBuffer());
  assert.equal(buf.length, Number(z.headers.get('content-length')));
  assert.deepEqual([...buf.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(t.db.tables.trysa_share_sessions[0].status, 'completed');
  assert.equal(t.db.tables.trysa_share_receipts[0].status, 'downloaded');
});

test('inbox shows the sender person card data and file kinds', async () => {
  const t = setup();
  const c = await t.api('me', { action: 'create', mode: 'remote', recipient_user_id: ADA.id, files: [{ name: 'a.jpg', size: 10, type: 'image/jpeg' }] });
  t.db.upload(c.body.uploads[0].upload_url, JPEG(10));
  await t.api('me', { action: 'publish', session_id: c.body.session_id });
  const [item] = (await t.api('ada', { action: 'inbox' })).body.transfers;
  assert.deepEqual(item.sender, { id: ME.id, name: 'Samson', username: 'samson', avatar_url: 'https://cdn/s.jpg' });
  assert.equal(item.session.kinds, '1 photo');
  assert.equal(item.session.sender_user_id, ME.id);
});

test('push subscriptions only accept real push services', async () => {
  const t = setup();
  assert.equal((await t.api('me', { action: 'push_subscribe', endpoint: 'https://evil.example/x' })).status, 400);
  assert.equal((await t.api('me', { action: 'push_subscribe', endpoint: 'http://fcm.googleapis.com/x' })).status, 400);
  const ok = 'https://fcm.googleapis.com/fcm/send/abc';
  assert.equal((await t.api('me', { action: 'push_subscribe', endpoint: ok })).status, 200);
  assert.equal((await t.api('me', { action: 'push_subscribe', endpoint: ok })).status, 200);
  assert.equal(t.db.tables.trysa_share_push_subscriptions.length, 1, 'idempotent');
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/QGx'));
});

test('VAPID JWT is a valid ES256 signature over the right audience', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const env = { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: 'mailto:ops@trysa.app' };
  const jwt = await vapidJwt('https://web.push.apple.com/abc', env);
  const [h, c, sig] = jwt.split('.');
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (x) => x.charCodeAt(0));
  assert.equal(JSON.parse(new TextDecoder().decode(dec(c))).aud, 'https://web.push.apple.com');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, dec(sig), new TextEncoder().encode(`${h}.${c}`)));
});

test('remote send wakes the recipient devices; gone subscriptions are removed', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const env = { VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d };
  const t = setup(env);
  t.db.tables.trysa_share_push_subscriptions.push(
    { id: 's1', user_id: ADA.id, endpoint: 'https://fcm.googleapis.com/fcm/send/live', failure_count: 0 },
    { id: 's2', user_id: ADA.id, endpoint: 'https://fcm.googleapis.com/fcm/send/gone', failure_count: 0 });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: url.endsWith('gone') ? 410 : 201 }); };
  try {
    const c = await t.api('me', { action: 'create', mode: 'remote', recipient_user_id: ADA.id, files: [{ name: 'a.jpg', size: 10, type: 'image/jpeg' }] });
    t.db.upload(c.body.uploads[0].upload_url, JPEG(10));
    await t.api('me', { action: 'publish', session_id: c.body.session_id });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 2);
  assert.match(calls[0].init.headers.authorization, /^vapid t=.+, k=/);
  assert.equal(calls[0].init.body, undefined, 'no payload: transfer details never pass through push services');
  assert.deepEqual(t.db.tables.trysa_share_push_subscriptions.map((s) => s.id), ['s1']);
  assert.equal(await notifyUser(t.db, {}, ADA.id), 0, 'no keys configured → no-op');
});
