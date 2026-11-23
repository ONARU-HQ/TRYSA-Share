// End-to-end API tests against an in-memory Supabase. Numbers refer to PRD §11 acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { createFakeDb } from './fake-db.js';

const SENDER = { id: '11111111-1111-4111-8111-111111111111', email: 'sender@example.com' };
const RECIPIENT = { id: '22222222-2222-4222-8222-222222222222' };
const STRANGER = { id: '33333333-3333-4333-8333-333333333333' };
const BASE = 'https://link.trysa.app';

function setup() {
  let clock = Date.parse('2026-11-23T12:00:00Z');
  const db = createFakeDb({ users: { 'tok-sender': SENDER, 'tok-recipient': RECIPIENT, 'tok-stranger': STRANGER }, now: () => clock });
  db.tables.profiles.push({ id: SENDER.id, full_name: 'Samson' }, { id: RECIPIENT.id, full_name: 'Ada' }, { id: STRANGER.id });
  const env = { PUBLIC_BASE_URL: BASE, ALLOWED_ORIGINS: BASE };
  const app = createApp({ db, env, now: () => clock });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (path, init = {}) => {
    const res = await app.handle(new Request(BASE + path, init), ctx);
    // Drain the body first (streamed downloads apply backpressure), then let waitUntil work finish.
    const buf = res.status === 204 ? null : await res.arrayBuffer();
    await Promise.all(pending.splice(0));
    return new Response(buf, { status: res.status, headers: res.headers });
  };
  const api = async (token, body) => {
    const res = await call('/api/share/v1', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { db, app, call, api, advance: (ms) => { clock += ms; }, cleanup: () => app.cleanup() };
}

const bytes = (n, seed = 1) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const PHOTOS = [bytes(1500, 1), bytes(2500, 2), bytes(900, 3)];
const photoMeta = PHOTOS.map((b, i) => ({ name: `IMG_000${i + 1}.jpg`, size: b.byteLength, type: 'image/jpeg' }));

async function sendQr(t, extra = {}, files = PHOTOS, meta = photoMeta) {
  const c = await t.api('tok-sender', { action: 'create', mode: 'qr', files: meta, ...extra });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  c.body.uploads.forEach((u, i) => t.db.upload(u.upload_url, files[i]));
  const p = await t.api('tok-sender', { action: 'publish', session_id: c.body.session_id });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return c.body;
}
async function browserAccept(t, code, body = {}) {
  const res = await t.call(`/s/${code}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, json: await res.json(), cookie };
}

test('#1/#2 QR send → browser receiver: preview, accept without signup, download, integrity, completion', async () => {
  const t = setup();
  const share = await sendQr(t, { name: 'Gallery' });
  assert.equal(share.share_url, `${BASE}/s/${share.short_code}`);

  const view = await t.call(`/s/${share.short_code}`);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.ok(html.includes('Samson') && html.includes('"count":3') && html.includes('3 photos'));
  assert.ok(!html.includes('IMG_0001.jpg'), 'file names are hidden before acceptance');
  assert.match(view.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const { res, json, cookie } = await browserAccept(t, share.short_code);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.deepEqual(json.files.map((f) => f.name), photoMeta.map((f) => f.name));

  for (const [i, f] of json.files.entries()) {
    const dl = await t.call(f.url, { headers: { cookie } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), new RegExp(f.name));
    assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), PHOTOS[i]);
  }
  const s = t.db.tables.trysa_share_sessions[0];
  assert.equal(s.status, 'completed');
  assert.equal(t.db.tables.trysa_share_receipts[0].status, 'downloaded');

  // #8 audit trail separates scan, acceptance and completion.
  const types = t.db.tables.trysa_share_events.map((e) => e.event_type);
  for (const e of ['created', 'ready', 'scanned', 'browser_accepted', 'file_delivered', 'receipt_downloaded', 'completed']) assert.ok(types.includes(e), e);

  const st = await t.api('tok-sender', { action: 'status', session_id: share.session_id });
  assert.deepEqual(st.body.activity, { scans: 1, accepted: 1, declined: 0, downloads_completed: 1 });
  assert.equal(st.body.session.pin_hash, undefined);
  assert.ok(!JSON.stringify(st.body).includes('claim_token_hash'));
});

test('QR is not receivable until every file is uploaded and verified', async () => {
  const t = setup();
  const c = await t.api('tok-sender', { action: 'create', mode: 'qr', files: photoMeta });
  t.db.upload(c.body.uploads[0].upload_url, PHOTOS[0]);
  const p = await t.api('tok-sender', { action: 'publish', session_id: c.body.session_id });
  assert.equal(p.status, 409);
  assert.equal(p.body.missing_file_ids.length, 2);
  assert.ok((await (await t.call(`/s/${c.body.short_code}`)).text()).includes('"availability":"preparing"'));
  assert.equal((await browserAccept(t, c.body.short_code)).res.status, 410);
});

test('a file whose stored size differs from the declared size is rejected', async () => {
  const t = setup();
  const c = await t.api('tok-sender', { action: 'create', mode: 'qr', files: photoMeta });
  c.body.uploads.forEach((u, i) => t.db.upload(u.upload_url, i === 1 ? bytes(10) : PHOTOS[i]));
  const p = await t.api('tok-sender', { action: 'publish', session_id: c.body.session_id });
  assert.equal(p.status, 422);
  assert.equal(t.db.tables.trysa_share_files[1].upload_status, 'rejected');
});

test('#5 decline gives zero file-byte access; no cookie means no download', async () => {
  const t = setup();
  const share = await sendQr(t);
  const fileId = t.db.tables.trysa_share_files[0].id;
  const d = await t.call(`/s/${share.short_code}/decline`, { method: 'POST' });
  assert.equal(d.status, 200);
  assert.equal((await t.call(`/s/${share.short_code}/f/${fileId}`)).status, 403);
  assert.equal((await t.call(`/s/${share.short_code}/f/${fileId}`, { headers: { cookie: `tsc_${share.short_code}=forged` } })).status, 403);
  assert.ok(t.db.tables.trysa_share_events.some((e) => e.event_type === 'browser_declined'));
});

test('#5 revoked link fails immediately for an already-accepted receiver and bytes are deleted', async () => {
  const t = setup();
  const share = await sendQr(t);
  const { json, cookie } = await browserAccept(t, share.short_code);
  const r = await t.api('tok-sender', { action: 'revoke', session_id: share.session_id });
  assert.equal(r.body.status, 'revoked');
  assert.equal((await t.call(json.files[0].url, { headers: { cookie } })).status, 410);
  assert.equal(t.db.objects.size, 0);
  assert.ok((await (await t.call(`/s/${share.short_code}`)).text()).includes('"availability":"accepted"') === false);
});

test('#5 expired link fails and the cleanup job removes files', async () => {
  const t = setup();
  const share = await sendQr(t);
  const { json, cookie } = await browserAccept(t, share.short_code);
  t.advance(31 * 60000);
  assert.equal((await t.call(json.files[0].url, { headers: { cookie } })).status, 410);
  assert.ok((await (await t.call(`/s/${share.short_code}`)).text()).includes('"availability":"expired"'));
  assert.equal(await t.cleanup(), 1);
  assert.equal(t.db.objects.size, 0);
  assert.equal(t.db.tables.trysa_share_sessions[0].status, 'expired');
  assert.ok(t.db.tables.trysa_share_files.every((f) => f.upload_status === 'deleted'));
  assert.equal(await t.cleanup(), 0, 'cleanup is idempotent');
});

test('one receiver by default; one-to-many when the sender allows it', async () => {
  const t = setup();
  const single = await sendQr(t);
  assert.equal((await browserAccept(t, single.short_code)).res.status, 200);
  assert.equal((await browserAccept(t, single.short_code)).res.status, 409);

  const multi = await sendQr(t, { max_receivers: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await browserAccept(t, multi.short_code)).res.status, 200);
  assert.equal((await browserAccept(t, multi.short_code)).res.status, 409);
});

test('re-accepting with an existing claim cookie is idempotent and does not use a new slot', async () => {
  const t = setup();
  const share = await sendQr(t);
  const first = await browserAccept(t, share.short_code);
  const again = await t.call(`/s/${share.short_code}/accept`, { method: 'POST', headers: { cookie: first.cookie }, body: '{}' });
  assert.equal(again.status, 200);
  assert.equal(t.db.tables.trysa_share_receipts.length, 1);
});

test('PIN-protected shares lock after 5 wrong attempts', async () => {
  const t = setup();
  const share = await sendQr(t, { pin: '4821' });
  assert.ok((await (await t.call(`/s/${share.short_code}`)).text()).includes('"pin_required":true'));
  assert.equal((await browserAccept(t, share.short_code, { pin: '0000' })).res.status, 403);
  assert.equal((await browserAccept(t, share.short_code, { pin: '4821' })).res.status, 200);

  const locked = await sendQr(t, { pin: '4821' });
  for (let i = 0; i < 4; i++) assert.equal((await browserAccept(t, locked.short_code, { pin: '1111' })).res.status, 403);
  assert.equal((await browserAccept(t, locked.short_code, { pin: '1111' })).res.status, 423);
  assert.equal((await browserAccept(t, locked.short_code, { pin: '4821' })).res.status, 423);
});

test('#6 repeated / resumed downloads never create duplicate receipts or completion events', async () => {
  const t = setup();
  const share = await sendQr(t, {}, [PHOTOS[0]], [photoMeta[0]]);
  const { json, cookie } = await browserAccept(t, share.short_code);
  const partial = await t.call(json.files[0].url, { headers: { cookie, range: 'bytes=500-' } });
  await partial.arrayBuffer();
  assert.equal(t.db.tables.trysa_share_receipts[0].status, 'downloading', 'partial range does not count as delivered');
  for (let i = 0; i < 3; i++) await (await t.call(json.files[0].url, { headers: { cookie } })).arrayBuffer();
  const ev = t.db.tables.trysa_share_events;
  assert.equal(ev.filter((e) => e.event_type === 'receipt_downloaded').length, 1);
  assert.equal(ev.filter((e) => e.event_type === 'completed').length, 1);
  assert.equal(ev.filter((e) => e.event_type === 'file_delivered').length, 1);
});

test('#8 unauthorised access and enumeration fail', async () => {
  const t = setup();
  const share = await sendQr(t);
  assert.equal((await t.api('nope', { action: 'sent' })).status, 401);
  assert.equal((await t.api('tok-stranger', { action: 'status', session_id: share.session_id })).status, 404);
  assert.equal((await t.api('tok-stranger', { action: 'revoke', session_id: share.session_id })).status, 404);
  assert.equal((await t.api('tok-stranger', { action: 'sent' })).body.transfers.length, 0);
  assert.equal((await t.call('/s/ZZZZZZZZZZ')).status, 404);
  assert.equal((await t.call('/s/bad-code!')).status, 404);
  assert.equal((await browserAccept(t, 'ZZZZZZZZZZ')).res.status, 404);
  const fileId = t.db.tables.trysa_share_files[0].id;
  assert.equal((await t.call(`/api/share/v1/sessions/${share.session_id}/files/${fileId}`, { headers: { authorization: 'Bearer tok-stranger' } })).status, 404);
});

test('workspace isolation: sender must belong to the workspace they share from', async () => {
  const t = setup();
  const ws = '44444444-4444-4444-8444-444444444444';
  const denied = await t.api('tok-sender', { action: 'create', mode: 'qr', workspace_id: ws, files: photoMeta });
  assert.equal(denied.status, 403);
  t.db.tables.workspace_members.push({ id: 'm1', workspace_id: ws, user_id: SENDER.id });
  assert.equal((await t.api('tok-sender', { action: 'create', mode: 'qr', workspace_id: ws, files: photoMeta })).status, 201);
});

test('#3-style remote send: inbox → accept → authenticated download → completed', async () => {
  const t = setup();
  const ws = '44444444-4444-4444-8444-444444444444';
  t.db.tables.workspace_members.push({ id: 'm1', workspace_id: ws, user_id: SENDER.id });
  const doc = new TextEncoder().encode('%PDF-1.7 contract');
  const c = await t.api('tok-sender', { action: 'create', mode: 'remote', recipient_user_id: RECIPIENT.id, workspace_id: ws,
    files: [{ name: 'Contract.pdf', size: doc.byteLength, type: 'application/pdf' }] });
  assert.equal(c.status, 201);
  assert.equal(c.body.share_url, null);
  t.db.upload(c.body.uploads[0].upload_url, doc);
  await t.api('tok-sender', { action: 'publish', session_id: c.body.session_id });
  assert.equal(t.db.tables.connect_notifications.length, 1);
  assert.match(t.db.tables.connect_notifications[0].title, /Samson wants to share 1 file/);

  const inbox = await t.api('tok-recipient', { action: 'inbox' });
  assert.equal(inbox.body.transfers.length, 1);
  const fileId = inbox.body.transfers[0].files[0].id;
  const url = `/api/share/v1/sessions/${c.body.session_id}/files/${fileId}`;
  assert.equal((await t.call(url, { headers: { authorization: 'Bearer tok-recipient' } })).status, 403, 'must accept first');
  assert.equal((await t.api('tok-stranger', { action: 'accept', session_id: c.body.session_id })).status, 404);
  assert.equal((await t.api('tok-recipient', { action: 'accept', session_id: c.body.session_id })).body.status, 'accepted');
  assert.equal((await t.api('tok-recipient', { action: 'accept', session_id: c.body.session_id })).status, 200, 'idempotent');
  assert.equal((await t.api('tok-recipient', { action: 'decline', session_id: c.body.session_id })).status, 409);

  const dl = await t.call(url, { headers: { authorization: 'Bearer tok-recipient' } });
  assert.equal(new TextDecoder().decode(await dl.arrayBuffer()), '%PDF-1.7 contract');
  assert.equal(t.db.tables.trysa_share_sessions[0].status, 'completed');
});

test('remote transfers cannot be opened through the public QR route', async () => {
  const t = setup();
  const c = await t.api('tok-sender', { action: 'create', mode: 'remote', recipient_user_id: RECIPIENT.id, files: [photoMeta[0]] });
  t.db.upload(c.body.uploads[0].upload_url, PHOTOS[0]);
  await t.api('tok-sender', { action: 'publish', session_id: c.body.session_id });
  assert.equal((await browserAccept(t, c.body.short_code)).res.status, 404);
});

test('CORS only reflects allow-listed origins', async () => {
  const t = setup();
  const ok = await t.call('/api/share/v1', { method: 'OPTIONS', headers: { origin: BASE } });
  assert.equal(ok.headers.get('access-control-allow-origin'), BASE);
  const bad = await t.call('/api/share/v1', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('#7 Worker routes never cover permanent QR paths like /hicc-gallery', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const patterns = [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(patterns, ['link.trysa.app/s/*', 'link.trysa.app/share*', 'link.trysa.app/api/share/*']);
  for (const p of patterns) {
    const re = new RegExp('^' + p.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
    assert.equal(re.test('link.trysa.app/hicc-gallery'), false, p);
  }
});
