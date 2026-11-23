import test from 'node:test';
import assert from 'node:assert/strict';
import { NearbyHub, roomKey, isVisible, DISCOVERABLE_MAX_MINUTES } from '../src/nearby.js';
import { createApp } from '../src/app.js';
import { createFakeDb } from './fake-db.js';

const P = (id, name) => ({ id, name, username: name.toLowerCase(), avatar_url: null });
const SAM = P('u-sam', 'Sam'), ADA = P('u-ada', 'Ada'), EVE = P('u-eve', 'Eve');

function hub() {
  let clock = 1_000_000;
  const inbox = new Map();
  const h = new NearbyHub((conn, msg) => { if (!inbox.has(conn)) inbox.set(conn, []); inbox.get(conn).push(msg); }, () => clock);
  const last = (conn, type) => [...(inbox.get(conn) || [])].reverse().find((m) => m.type === type);
  const say = (conn, obj) => h.message(conn, JSON.stringify(obj));
  return { h, inbox, last, say, advance: (ms) => { clock += ms; } };
}

test('room key groups one IPv4 address or one IPv6 /64, and is salted', async () => {
  assert.equal(await roomKey('203.0.113.7'), await roomKey('203.0.113.7'));
  assert.notEqual(await roomKey('203.0.113.7'), await roomKey('203.0.113.8'));
  assert.equal(await roomKey('2001:db8:1:2::a'), await roomKey('2001:db8:1:2:ffff::1'));
  assert.notEqual(await roomKey('2001:db8:1:2::a'), await roomKey('2001:db8:1:3::a'));
  assert.notEqual(await roomKey('203.0.113.7', 's1'), await roomKey('203.0.113.7', 's2'));
  assert.equal(await roomKey(null), null);
});

test('nobody is visible until they switch Receiving on, and it times out', () => {
  const t = hub();
  t.h.join('c-sam', SAM); t.h.join('c-ada', ADA);
  assert.deepEqual(t.last('c-sam', 'peers').peers, []);
  t.say('c-ada', { type: 'presence', mode: 'everyone', minutes: 60, device: 'iPhone 15' });
  const peers = t.last('c-sam', 'peers').peers;
  assert.equal(peers.length, 1);
  assert.equal(peers[0].person.name, 'Ada');
  assert.equal(peers[0].device, 'iPhone 15');
  assert.equal(peers[0].until, 1_000_000 + DISCOVERABLE_MAX_MINUTES * 60000, 'window capped at 10 min');
  t.advance(DISCOVERABLE_MAX_MINUTES * 60000 + 1);
  t.h.tick();
  assert.deepEqual(t.last('c-sam', 'peers').peers, []);
  assert.equal(t.last('c-ada', 'presence').mode, 'off');
});

test('"Contacts only" hides you from strangers on the same network', () => {
  const t = hub();
  t.h.join('c-sam', SAM); t.h.join('c-eve', EVE); t.h.join('c-ada', ADA, ['u-sam']);
  t.say('c-ada', { type: 'presence', mode: 'contacts' });
  assert.equal(t.last('c-sam', 'peers').peers.length, 1);
  assert.equal(t.last('c-eve', 'peers').peers.length, 0);
  assert.equal(isVisible({ conn: 'x', person: ADA, mode: 'contacts', until: Infinity, contacts: [] }, { conn: 'y', person: ADA }), true, 'own other device');
});

test('transfer requests need the target to be discoverable; replies need an open request', () => {
  const t = hub();
  t.h.join('c-sam', SAM); t.h.join('c-ada', ADA); t.h.join('c-eve', EVE);
  t.say('c-sam', { type: 'signal', to: 'c-ada', data: { kind: 'request', files: [] } });
  assert.match(t.last('c-sam', 'error').message, /no longer available/);
  assert.equal(t.last('c-ada', 'signal'), undefined);

  t.say('c-ada', { type: 'presence', mode: 'everyone' });
  t.say('c-sam', { type: 'signal', to: 'c-ada', data: { kind: 'request', count: 3 } });
  const req = t.last('c-ada', 'signal');
  assert.equal(req.from, 'c-sam');
  assert.equal(req.person.name, 'Sam');
  assert.equal(req.data.count, 3);

  // Eve was never contacted by Ada and cannot inject an "accept" or SDP into Sam/Ada.
  t.say('c-eve', { type: 'signal', to: 'c-sam', data: { kind: 'accept' } });
  assert.match(t.last('c-eve', 'error').message, /Not connected/);

  t.say('c-ada', { type: 'signal', to: 'c-sam', data: { kind: 'accept' } });
  assert.equal(t.last('c-sam', 'signal').data.kind, 'accept');
  t.say('c-sam', { type: 'signal', to: 'c-ada', data: { kind: 'offer', sdp: 'v=0' } });
  assert.equal(t.last('c-ada', 'signal').data.kind, 'offer');
  t.say('c-ada', { type: 'signal', to: 'c-sam', data: { kind: 'answer', sdp: 'v=0' } });
  assert.equal(t.last('c-sam', 'signal').data.kind, 'answer');
});

test('request spam is rate limited and oversized/garbage messages are refused', () => {
  const t = hub();
  t.h.join('c-sam', SAM); t.h.join('c-ada', ADA);
  t.say('c-ada', { type: 'presence', mode: 'everyone' });
  for (let i = 0; i < 10; i++) t.say('c-sam', { type: 'signal', to: 'c-ada', data: { kind: 'request' } });
  t.say('c-sam', { type: 'signal', to: 'c-ada', data: { kind: 'request' } });
  assert.match(t.last('c-sam', 'error').message, /Too many/);
  assert.equal(t.inbox.get('c-ada').filter((m) => m.type === 'signal').length, 10);
  t.h.message('c-sam', 'x'.repeat(200 * 1024));
  assert.match(t.last('c-sam', 'error').message, /too large/);
  t.h.message('c-sam', '{nope');
  assert.match(t.last('c-sam', 'error').message, /Bad message/);
  t.say('c-sam', { type: 'presence', mode: 'broadcast-forever' });
  assert.match(t.last('c-sam', 'error').message, /Bad mode/);
});

test('leaving removes the device from everyone\'s list', () => {
  const t = hub();
  t.h.join('c-sam', SAM); t.h.join('c-ada', ADA);
  t.say('c-ada', { type: 'presence', mode: 'everyone' });
  assert.equal(t.last('c-sam', 'peers').peers.length, 1);
  t.h.leave('c-ada');
  assert.equal(t.last('c-sam', 'peers').peers.length, 0);
});

test('WebSocket connect: token via subprotocol, origin allow-list, identity injected server-side', async () => {
  const db = createFakeDb({ users: { tok: { id: 'u-sam' } } });
  db.tables.profiles.push({ id: 'u-sam', full_name: 'Sam', username: 'sam' });
  const forwarded = [];
  const NEARBY = { idFromName: (n) => n, get: (id) => ({ fetch: async (req) => { forwarded.push({ id, req }); return new Response('ok'); } }) };
  const app = createApp({ db, env: { NEARBY, ALLOWED_ORIGINS: 'https://link.trysa.app' } });
  const ws = (headers) => app.handle(new Request('https://link.trysa.app/api/share/v1/nearby', { headers: { upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7', ...headers } }));
  assert.equal((await ws({})).status, 401);
  assert.equal((await ws({ 'sec-websocket-protocol': 'trysa, bad' })).status, 401);
  assert.equal((await ws({ 'sec-websocket-protocol': 'trysa, tok', origin: 'https://evil.example' })).status, 403);
  assert.equal((await ws({ 'sec-websocket-protocol': 'trysa, tok', origin: 'https://link.trysa.app', 'x-trysa-person': '{"id":"forged"}' })).status, 200);
  const { id, req } = forwarded[0];
  assert.equal(id, await roomKey('203.0.113.7'));
  assert.equal(JSON.parse(req.headers.get('x-trysa-person')).id, 'u-sam', 'client cannot forge identity');
  assert.equal(req.headers.get('sec-websocket-protocol'), null, 'token not forwarded');
});
