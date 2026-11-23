// Minimal Supabase REST client (PostgREST, Storage, Auth) for Cloudflare Workers.
// Uses the service-role key, which only ever lives in the Worker as a secret.

export class SupabaseError extends Error {
  constructor(message, status, detail) { super(message); this.status = status; this.detail = detail; }
}

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export function createDb(env, fetchImpl = fetch) {
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.BUCKET || 'trysa-share-private';
  // New-format secret keys (sb_secret_…) are sent only as `apikey`; the Supabase gateway
  // turns them into a short-lived service-role JWT. Legacy JWT service keys also need Bearer.
  const svc = key && key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };

  async function json(res, what) {
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new SupabaseError(`${what} failed (${res.status})`, res.status, body);
    return body;
  }
  const qs = (filters) => new URLSearchParams(filters).toString();

  return {
    bucket,

    /** Resolve a user's access token to a user object, or null. */
    async getUser(accessToken) {
      if (!accessToken) return null;
      const res = await fetchImpl(`${base}/auth/v1/user`, {
        headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || key, authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const user = await res.json();
      return user && user.id && !user.is_anonymous ? user : null;
    },

    async select(table, filters) {
      const res = await fetchImpl(`${base}/rest/v1/${table}?${qs(filters)}`, { headers: svc });
      return json(res, `select ${table}`);
    },
    async one(table, filters) {
      const rows = await this.select(table, { ...filters, limit: '1' });
      return rows[0] || null;
    },
    async insert(table, rows, { ignoreDuplicates = false } = {}) {
      const res = await fetchImpl(`${base}/rest/v1/${table}${ignoreDuplicates ? '?on_conflict=session_id,idempotency_key' : ''}`, {
        method: 'POST',
        headers: { ...svc, 'content-type': 'application/json',
          prefer: `return=representation${ignoreDuplicates ? ',resolution=ignore-duplicates' : ''}` },
        body: JSON.stringify(rows),
      });
      return json(res, `insert ${table}`);
    },
    /** Conditional update; returns updated rows (empty when the guard did not match). */
    async update(table, filters, patch) {
      const res = await fetchImpl(`${base}/rest/v1/${table}?${qs(filters)}`, {
        method: 'PATCH',
        headers: { ...svc, 'content-type': 'application/json', prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return json(res, `update ${table}`);
    },
    async upsert(table, rows, onConflict) {
      const res = await fetchImpl(`${base}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: { ...svc, 'content-type': 'application/json', prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
      return json(res, `upsert ${table}`);
    },
    async delete(table, filters) {
      const res = await fetchImpl(`${base}/rest/v1/${table}?${qs(filters)}`, { method: 'DELETE', headers: { ...svc, prefer: 'return=representation' } });
      return json(res, `delete ${table}`);
    },
    async rpc(fn, args) {
      const res = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: { ...svc, 'content-type': 'application/json' }, body: JSON.stringify(args),
      });
      return json(res, `rpc ${fn}`);
    },

    // ------------------------------------------------------------ storage
    /** Short-lived signed upload URL (absolute). Upload with PUT + file body. */
    async signUpload(path) {
      const res = await fetchImpl(`${base}/storage/v1/object/upload/sign/${bucket}/${enc(path)}`, {
        method: 'POST', headers: { ...svc, 'content-type': 'application/json' }, body: '{}',
      });
      const body = await json(res, 'sign upload');
      return `${base}/storage/v1${body.url}`;
    },
    /** Returns stored byte size, or null when the object does not exist. */
    async objectSize(path) {
      const res = await fetchImpl(`${base}/storage/v1/object/authenticated/${bucket}/${enc(path)}`, { method: 'HEAD', headers: svc });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new SupabaseError(`head object failed (${res.status})`, res.status);
      const len = res.headers.get('content-length');
      return len == null ? null : Number(len);
    },
    /** Streams a private object. Caller must have authorised the receiver first. */
    async getObject(path, range) {
      const headers = { ...svc };
      if (range) headers.range = range;
      const res = await fetchImpl(`${base}/storage/v1/object/authenticated/${bucket}/${enc(path)}`, { headers });
      if (!res.ok && res.status !== 206) throw new SupabaseError(`get object failed (${res.status})`, res.status);
      return res;
    },
    async removeObjects(paths) {
      if (!paths.length) return [];
      const res = await fetchImpl(`${base}/storage/v1/object/${bucket}`, {
        method: 'DELETE', headers: { ...svc, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
      });
      return json(res, 'remove objects');
    },
  };
}
