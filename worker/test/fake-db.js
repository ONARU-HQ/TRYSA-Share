// In-memory stand-in for the Supabase REST client, enforcing the same constraints the
// migration adds (unique short_code, idempotency keys, atomic browser claim).
import { SupabaseError } from '../src/db.js';

function matches(row, key, cond) {
  const val = key.includes('->>') ? row[key.split('->>')[0]]?.[key.split('->>')[1]] : row[key];
  const [op, ...rest] = cond.split('.');
  const arg = rest.join('.');
  switch (op) {
    case 'eq': return String(val) === arg;
    case 'neq': return String(val) !== arg;
    case 'is': return arg === 'null' ? val == null : String(val) === arg;
    case 'lt': return val < arg;
    case 'gt': return val > arg;
    case 'ilike': return val != null && new RegExp('^' + arg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(val));
    case 'in': return arg.slice(1, -1).split(',').includes(String(val));
    default: throw new Error(`unsupported op ${op}`);
  }
}
function filter(rows, filters) {
  let out = rows;
  for (const [k, v] of Object.entries(filters)) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    if (k === 'or') {
      const parts = []; let depth = 0, cur = '';
      for (const ch of v.slice(1, -1)) {
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        if (ch === '(') depth++; if (ch === ')') depth--; cur += ch;
      }
      parts.push(cur);
      out = out.filter((r) => parts.some((p) => { const [col, ...c] = p.split('.'); return matches(r, col, c.join('.')); }));
      continue;
    }
    out = out.filter((r) => matches(r, k, v));
  }
  if (filters.limit) out = out.slice(0, Number(filters.limit));
  return out;
}

export function createFakeDb({ users = {}, now = () => Date.now() } = {}) {
  const t = { trysa_share_sessions: [], trysa_share_files: [], trysa_share_receipts: [], trysa_share_events: [],
    profiles: [], workspace_members: [], connect_notifications: [], trysa_share_push_subscriptions: [], trysa_share_login_requests: [] };
  const objects = new Map();
  const ts = () => new Date(now()).toISOString();
  const defaults = {
    trysa_share_sessions: () => ({ id: crypto.randomUUID(), pin_failures: 0, cleaned_at: null, created_at: ts(), updated_at: ts() }),
    trysa_share_files: () => ({ created_at: ts(), upload_status: 'pending' }),
    trysa_share_receipts: () => ({ id: crypto.randomUUID(), created_at: ts(), download_count: 0, receiver_user_id: null, claim_token_hash: null }),
    trysa_share_login_requests: () => ({ id: crypto.randomUUID(), created_at: ts() }),
    trysa_share_events: () => ({ id: crypto.randomUUID(), occurred_at: ts(), metadata: {} }),
  };
  const db = {
    tables: t, objects, bucket: 'trysa-share-private',
    async getUser(token) { return users[token] || null; },
    async select(table, filters) {
      const rows = structuredClone(filter(t[table], filters));
      if (!filters.select || filters.select === '*') return rows;
      const cols = filters.select.split(',');
      return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    },
    async one(table, filters) { return (await db.select(table, { ...filters, limit: '1' }))[0] || null; },
    async insert(table, rows, { ignoreDuplicates } = {}) {
      const out = [];
      for (const r of rows) {
        const row = { ...(defaults[table]?.() || {}), ...r };
        if (table === 'trysa_share_sessions' && t[table].some((s) => s.short_code === row.short_code)) throw new SupabaseError('dup', 409);
        if (table === 'trysa_share_events' && row.idempotency_key &&
          t[table].some((e) => e.session_id === row.session_id && e.idempotency_key === row.idempotency_key)) {
          if (ignoreDuplicates) continue; throw new SupabaseError('dup', 409);
        }
        t[table].push(row); out.push(structuredClone(row));
      }
      return out;
    },
    async update(table, filters, patch) {
      const rows = filter(t[table], filters);
      for (const r of rows) Object.assign(r, patch);
      return structuredClone(rows);
    },
    async upsert(table, rows, onConflict) {
      const out = [];
      for (const r of rows) {
        const hit = t[table].find((x) => x[onConflict] === r[onConflict]);
        if (hit) { Object.assign(hit, r); out.push(structuredClone(hit)); }
        else { const row = { id: crypto.randomUUID(), ...r }; t[table].push(row); out.push(structuredClone(row)); }
      }
      return out;
    },
    async delete(table, filters) {
      const gone = filter(t[table], filters);
      t[table] = t[table].filter((r) => !gone.includes(r));
      return structuredClone(gone);
    },
    async rpc(fn, args) {
      if (fn === 'trysa_share_pin_failure') {
        const s = t.trysa_share_sessions.find((x) => x.id === args.p_session_id); s.pin_failures++; return s.pin_failures;
      }
      if (fn === 'trysa_share_claim_browser') {
        const s = t.trysa_share_sessions.find((x) => x.id === args.p_session_id);
        if (!s) return 'not_found';
        if (s.status === 'revoked') return 'revoked';
        if (s.status === 'expired' || Date.parse(s.expires_at) <= now()) return 'expired';
        if (!['ready', 'claimed', 'transferring'].includes(s.status)) return 'unavailable';
        const taken = t.trysa_share_receipts.filter((r) => r.session_id === s.id && ['accepted', 'downloading', 'downloaded'].includes(r.status)).length;
        if (taken >= s.max_receivers) return 'full';
        await db.insert('trysa_share_receipts', [{ session_id: s.id, receiver_kind: 'browser', claim_token_hash: args.p_token_hash, status: 'accepted', accepted_at: ts() }]);
        if (s.status === 'ready') s.status = 'claimed';
        return 'accepted';
      }
      throw new Error(`unknown rpc ${fn}`);
    },
    magicLinks: [],
    async generateMagicLinkHash(email) { db.magicLinks.push(email); return `hash-${email}`; },
    async signUpload(path) { return `https://fake.supabase.co/storage/v1/object/upload/sign/trysa-share-private/${path}?token=x`; },
    async objectSize(path) { return objects.has(path) ? objects.get(path).byteLength : null; },
    async getObject(path, range) {
      const bytes = objects.get(path);
      if (!bytes) throw new SupabaseError('missing', 404);
      const m = range && range.match(/^bytes=(\d+)-(\d*)$/);
      if (m) {
        const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
        const part = bytes.slice(start, end + 1);
        return new Response(part, { status: 206, headers: { 'content-length': String(part.byteLength), 'content-range': `bytes ${start}-${end}/${bytes.byteLength}` } });
      }
      return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
    },
    async removeObjects(paths) { for (const p of paths) objects.delete(p); return paths; },
    /** Test helper: simulate the client's PUT to the signed upload URL. */
    upload(uploadUrl, bytes) { objects.set(uploadUrl.split('/trysa-share-private/')[1].split('?')[0], bytes); },
  };
  return db;
}
