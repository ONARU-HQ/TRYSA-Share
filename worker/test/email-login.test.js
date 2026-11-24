import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-db.js';
import { requestEmailLink, LOGIN_LIMITS } from '../src/email-login.js';

function setup() {
  const db = createFakeDb();
  db.tables.profiles.push({ id: 'u1', email: 'Ada@Example.com' });
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return new Response('{"id":"e1"}', { status: 200 }); };
  const call = (email, ip = '1.2.3.4') => requestEmailLink({ db, env: { RESEND_API_KEY: 're_test' }, email, ip, base: 'https://trysa-share.vercel.app', fetchImpl });
  return { db, sent, call };
}

test('existing TRYSA account gets a Resend email with a one-time token link (no Supabase email hook)', async () => {
  const t = setup();
  const r = await t.call(' ada@example.com ');
  assert.equal(r.status, 200);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].url, 'https://api.resend.com/emails');
  assert.equal(t.sent[0].auth, 'Bearer re_test');
  assert.deepEqual(t.sent[0].body.to, ['ada@example.com']);
  assert.match(t.sent[0].body.from, /@trysa\.app>$/);
  assert.ok(t.sent[0].body.html.includes('https://trysa-share.vercel.app/share/?token_hash=hash-ada%40example.com&amp;type=magiclink') ||
    t.sent[0].body.html.includes('https://trysa-share.vercel.app/share/?token_hash=hash-ada%40example.com&type=magiclink'));
  assert.ok(!JSON.stringify(t.db.tables.trysa_share_login_requests).includes('ada@'), 'only hashes stored');
});

test('unknown emails get the same answer and no email; no account is created', async () => {
  const t = setup();
  const known = await t.call('ada@example.com');
  const unknown = await t.call('nobody@example.com');
  assert.deepEqual(unknown, known);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.db.magicLinks, ['ada@example.com']);
});

test('rate limits per email and per IP; bad input rejected; missing key reported', async () => {
  const t = setup();
  for (let i = 0; i < LOGIN_LIMITS.perEmailPerHour; i++) assert.equal((await t.call('ada@example.com', `9.9.9.${i}`)).status, 200);
  assert.equal((await t.call('ada@example.com', '9.9.9.99')).status, 429);
  for (let i = 0; i < LOGIN_LIMITS.perIpPerHour; i++) await t.call(`x${i}@example.com`, '5.5.5.5');
  assert.equal((await t.call('ada2@example.com', '5.5.5.5')).status, 429);
  assert.equal((await t.call('not-an-email')).status, 400);
  const r = await requestEmailLink({ db: createFakeDb(), env: {}, email: 'a@b.co', ip: '', base: 'x' });
  assert.equal(r.status, 503);
});
