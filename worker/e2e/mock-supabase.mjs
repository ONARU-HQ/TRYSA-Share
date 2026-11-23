// Local stand-in for Supabase (Auth user lookup, PostgREST, Storage) backed by the same
// in-memory fake used by the unit tests. Dev/E2E only — never deployed.
import http from 'node:http';
import { createFakeDb } from '../test/fake-db.js';
import { SupabaseError } from '../src/db.js';

export const USERS = {
  'tok-sam': { id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com' },
  'tok-ada': { id: '22222222-2222-4222-8222-222222222222', email: 'ada@example.com' },
  'tok-kofi': { id: '33333333-3333-4333-8333-333333333333', email: 'kofi@example.com' },
};
const WS = '44444444-4444-4444-8444-444444444444';

export function startMockSupabase(port = 54321) {
  const db = createFakeDb({ users: USERS });
  db.tables.profiles.push(
    { id: USERS['tok-sam'].id, full_name: 'Samson Adeyemi', username: 'samson', avatar_url: `http://127.0.0.1:${port}/avatar/samson.svg`, show_avatar: true },
    { id: USERS['tok-ada'].id, full_name: 'Ada Okafor', username: 'ada', avatar_url: null, show_avatar: true },
    { id: USERS['tok-kofi'].id, full_name: 'Kofi Mensah', username: 'kofi', avatar_url: `http://127.0.0.1:${port}/avatar/kofi.svg`, show_avatar: true });
  for (const t of Object.keys(USERS)) db.tables.workspace_members.push({ workspace_id: WS, user_id: USERS[t].id });

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...cors, ...headers });
    res.end(body == null ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      if (p.startsWith('/avatar/')) {
        const hueA = p.includes('kofi') ? 28 : 205, hueB = p.includes('kofi') ? 350 : 255;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hueA} 70% 74%)"/><stop offset="1" stop-color="hsl(${hueB} 55% 38%)"/></linearGradient></defs><rect width="400" height="520" fill="url(#g)"/><circle cx="200" cy="210" r="86" fill="rgba(255,255,255,.55)"/><path d="M60 520c10-120 70-180 140-180s130 60 140 180z" fill="rgba(255,255,255,.45)"/></svg>`;
        return send(res, 200, svg, { 'content-type': 'image/svg+xml' });
      }
      if (p === '/auth/v1/user') {
        const u = USERS[(req.headers.authorization || '').replace(/^Bearer /, '')];
        return u ? send(res, 200, u) : send(res, 401, { message: 'invalid' });
      }
      if (p.startsWith('/rest/v1/rpc/')) {
        const out = await db.rpc(p.slice(13), JSON.parse((await readBody(req)).toString() || '{}'));
        return send(res, 200, JSON.stringify(out), { 'content-type': 'application/json' });
      }
      if (p.startsWith('/rest/v1/')) {
        const table = p.slice(9);
        const filters = Object.fromEntries(url.searchParams);
        const prefer = req.headers.prefer || '';
        if (req.method === 'GET') return send(res, 200, await db.select(table, filters));
        if (req.method === 'DELETE') return send(res, 200, await db.delete(table, filters));
        const body = JSON.parse((await readBody(req)).toString() || 'null');
        if (req.method === 'PATCH') { delete filters.select; return send(res, 200, await db.update(table, filters, body)); }
        if (req.method === 'POST') {
          if (prefer.includes('merge-duplicates')) return send(res, 201, await db.upsert(table, body, filters.on_conflict));
          return send(res, 201, await db.insert(table, body, { ignoreDuplicates: prefer.includes('ignore-duplicates') }));
        }
      }
      let m;
      if ((m = p.match(/^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/))) {
        if (req.method === 'POST') return send(res, 200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=dev` });
        if (req.method === 'PUT') { db.objects.set(m[2], new Uint8Array(await readBody(req))); return send(res, 200, { Key: m[2] }); }
      }
      if ((m = p.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/))) {
        const bytes = db.objects.get(m[2]);
        if (!bytes) return send(res, 404, { error: 'not found' });
        if (req.method === 'HEAD') return send(res, 200, null, { 'content-length': String(bytes.byteLength) });
        const r = await db.getObject(m[2], req.headers.range);
        return send(res, r.status, new Uint8Array(await r.arrayBuffer()), Object.fromEntries(r.headers));
      }
      if ((m = p.match(/^\/storage\/v1\/object\/([^/]+)$/)) && req.method === 'DELETE') {
        const { prefixes } = JSON.parse((await readBody(req)).toString());
        return send(res, 200, await db.removeObjects(prefixes));
      }
      send(res, 404, { error: `mock: no route ${req.method} ${p}` });
    } catch (e) {
      send(res, e instanceof SupabaseError ? e.status : 500, { message: e.message });
    }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, db })));
}

if (import.meta.url === `file://${process.argv[1]}`) startMockSupabase().then(() => console.log('mock supabase on :54321'));
