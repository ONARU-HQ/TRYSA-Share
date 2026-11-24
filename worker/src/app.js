// TRYSA Share request handling. Platform glue lives in index.js; everything here
// takes an injected `db` so it can be exercised with an in-memory fake in tests.
import {
  LIMITS, CODE_RE, ValidationError, validateCreate, randomCode, randomToken, sha256Hex,
  hashPin, verifyPin, isUuid, isReceivable, publicAvailability, sessionAfterDownload,
  contentDisposition, kindSummary, canTransition, SESSION_TERMINAL,
} from './core.js';
import { SupabaseError } from './db.js';
import { zipStream } from './zip.js';
import { checkContent, scanWithService } from './sniff.js';
import { notifyUser, isAllowedEndpoint } from './push.js';
import { roomKey } from './nearby.js';
import { requestEmailLink } from './email-login.js';
import { receiverPage } from './pages/receiver.js';

const MAX_PIN_FAILURES = 5;
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (message, status = 400, headers) => json({ error: message }, status, headers);
const cookieName = (code) => `tsc_${code}`;

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function createApp({ db, env, now = () => Date.now() }) {
  const base = (env.PUBLIC_BASE_URL || 'https://link.trysa.app').replace(/\/$/, '');
  const allowed = new Set((env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const iso = (ms) => new Date(ms).toISOString();

  // ---------------------------------------------------------------- helpers
  async function event(session_id, event_type, { actor = null, metadata = {}, key = null } = {}) {
    try {
      await db.insert('trysa_share_events', [{ session_id, actor_user_id: actor, event_type, metadata, idempotency_key: key }], { ignoreDuplicates: !!key });
    } catch (e) { console.error('event log failed', event_type, e.message); }
  }

  async function rateLimited(request, cls) {
    if (!env.SHARE_RL) return false;
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.SHARE_RL.limit({ key: `${cls}:${ip}` });
    return !success;
  }

  function cors(request) {
    const origin = request.headers.get('origin');
    if (!origin || !allowed.has(origin)) return {};
    return { 'access-control-allow-origin': origin, vary: 'origin',
      'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-max-age': '600' };
  }

  async function requireUser(request) {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = await db.getUser(token);
    if (!user) throw new ValidationError('Sign in to TRYSA', 401);
    return user;
  }

  const sessionByCode = (code) => db.one('trysa_share_sessions', { short_code: `eq.${code}`, select: '*' });
  const filesOf = (sessionId) => db.select('trysa_share_files', { session_id: `eq.${sessionId}`, select: '*', order: 'created_at.asc' });
  const acceptedCount = async (sessionId) => (await db.select('trysa_share_receipts', {
    session_id: `eq.${sessionId}`, status: 'in.(accepted,downloading,downloaded)', select: 'id' })).length;

  // Public-facing identity for a TRYSA user, honouring their avatar privacy setting.
  const personOf = (p) => p && ({ id: p.id, name: p.full_name || p.username || 'TRYSA user', username: p.username || null,
    avatar_url: p.show_avatar === false ? null : p.avatar_url || null });
  const PROFILE_COLS = 'id,full_name,username,avatar_url,show_avatar';

  async function contacts(uid, rawQuery) {
    const q = String(rawQuery || '').trim().replace(/^@/, '').replace(/[,()*%\\]/g, '').slice(0, 40);
    const ids = new Set();
    // 1) people you already exchanged files with
    const mine = await db.select('trysa_share_sessions', { sender_user_id: `eq.${uid}`, mode: 'eq.remote', select: 'id', order: 'created_at.desc', limit: '50' });
    if (mine.length) for (const r of await db.select('trysa_share_receipts', { session_id: `in.(${mine.map((m) => m.id).join(',')})`, select: 'receiver_user_id' })) if (r.receiver_user_id) ids.add(r.receiver_user_id);
    // 2) members of your workspaces
    const ws = await db.select('workspace_members', { user_id: `eq.${uid}`, select: 'workspace_id' });
    if (ws.length) for (const m of await db.select('workspace_members', { workspace_id: `in.(${ws.map((w) => w.workspace_id).join(',')})`, select: 'user_id', limit: '500' })) ids.add(m.user_id);
    ids.delete(uid);
    let people = [];
    if (ids.size) {
      const filters = { id: `in.(${[...ids].join(',')})`, select: PROFILE_COLS, limit: '20', order: 'full_name.asc' };
      if (q.length >= 2) filters.or = `(full_name.ilike.*${q}*,username.ilike.*${q}*)`;
      people = await db.select('profiles', filters);
    }
    // 3) anyone else only by their exact @username (no open directory search)
    if (q.length >= 3) {
      const exact = await db.one('profiles', { username: `ilike.${q}`, select: PROFILE_COLS });
      if (exact && exact.id !== uid && !people.some((p) => p.id === exact.id)) people.unshift(exact);
    }
    return people.map(personOf);
  }

  // ================================================================ sender / account API
  async function api(request, ctx) {
    const user = await requireUser(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.action !== 'string') throw new ValidationError('action required');
    const uid = user.id;

    switch (body.action) {
      case 'create': return create(body, user);
      case 'me': {
        const p = await db.one('profiles', { id: `eq.${uid}`, select: PROFILE_COLS });
        return json({ person: personOf(p || { id: uid }), push_public_key: env.VAPID_PUBLIC_KEY || null });
      }
      case 'contacts': return json({ people: await contacts(uid, body.q) });
      case 'push_subscribe': {
        if (!isAllowedEndpoint(body.endpoint)) throw new ValidationError('Unsupported push service');
        await db.upsert('trysa_share_push_subscriptions', [{ user_id: uid, endpoint: body.endpoint, failure_count: 0 }], 'endpoint');
        return json({ subscribed: true });
      }
      case 'push_unsubscribe': {
        await db.delete('trysa_share_push_subscriptions', { user_id: `eq.${uid}`, endpoint: `eq.${String(body.endpoint || '')}` });
        return json({ subscribed: false });
      }
      case 'sent': {
        const rows = await db.select('trysa_share_sessions', {
          sender_user_id: `eq.${uid}`, order: 'created_at.desc', limit: '50',
          select: 'id,mode,name,status,short_code,total_bytes,max_receivers,expires_at,created_at' });
        return json({ transfers: rows.map((r) => ({ ...r, share_url: r.mode === 'qr' ? `${base}/s/${r.short_code}` : null })) });
      }
      case 'inbox': {
        const receipts = await db.select('trysa_share_receipts', {
          receiver_user_id: `eq.${uid}`, order: 'created_at.desc', limit: '50', select: 'id,session_id,status,created_at' });
        if (!receipts.length) return json({ transfers: [] });
        const ids = receipts.map((r) => r.session_id).join(',');
        const sessions = await db.select('trysa_share_sessions', { id: `in.(${ids})`,
          select: 'id,name,status,sender_user_id,sender_display_name,expires_at,total_bytes,created_at,show_preview,preview_status' });
        const files = await db.select('trysa_share_files', { session_id: `in.(${ids})`, select: 'id,session_id,original_name,mime_type,byte_size' });
        const senderIds = [...new Set(sessions.map((s) => s.sender_user_id))];
        const senders = senderIds.length ? await db.select('profiles', { id: `in.(${senderIds.join(',')})`, select: PROFILE_COLS }) : [];
        const t = now();
        return json({ transfers: receipts.map((receipt) => {
          const session = sessions.find((s) => s.id === receipt.session_id);
          if (!session || ['draft', 'uploading', 'failed'].includes(session.status)) return null;
          const { show_preview, preview_status, ...rest } = session;
          const sessionFiles = files.filter((f) => f.session_id === session.id);
          return { receipt, sender: personOf(senders.find((p) => p.id === session.sender_user_id) || { id: session.sender_user_id, full_name: session.sender_display_name }),
            session: { ...rest, receivable: isReceivable(session, t), kinds: kindSummary(sessionFiles),
              preview_url: show_preview && preview_status === 'verified' ? `/api/share/v1/sessions/${session.id}/preview` : null },
            files: sessionFiles };
        }).filter(Boolean) });
      }
    }

    if (!isUuid(body.session_id)) throw new ValidationError('session_id required');
    const session = await db.one('trysa_share_sessions', { id: `eq.${body.session_id}`, select: '*' });
    if (!session) throw new ValidationError('Transfer not found', 404);
    const isSender = session.sender_user_id === uid;

    if (['publish', 'status', 'revoke'].includes(body.action) && !isSender) throw new ValidationError('Transfer not found', 404);
    if (body.action === 'publish') return publish(session, uid, ctx);
    if (body.action === 'status') return status(session);
    if (body.action === 'revoke') return revoke(session, uid, ctx);

    if (body.action === 'accept' || body.action === 'decline') {
      const receipt = await db.one('trysa_share_receipts', { session_id: `eq.${session.id}`, receiver_user_id: `eq.${uid}`, select: '*' });
      if (!receipt) throw new ValidationError('Transfer not found', 404);
      if (!isReceivable(session, now())) throw new ValidationError('This transfer has expired or was cancelled', 410);
      const accept = body.action === 'accept';
      const updated = await db.update('trysa_share_receipts', { id: `eq.${receipt.id}`, status: 'eq.requested' },
        accept ? { status: 'accepted', accepted_at: iso(now()) } : { status: 'declined', declined_at: iso(now()) });
      if (!updated.length) {
        // Idempotent replay of the same decision is fine; a conflicting one is not.
        if (receipt.status === (accept ? 'accepted' : 'declined')) return json({ status: receipt.status });
        throw new ValidationError('You already answered this transfer', 409);
      }
      if (accept) await db.update('trysa_share_sessions', { id: `eq.${session.id}`, status: 'eq.ready' }, { status: 'claimed', updated_at: iso(now()) });
      await event(session.id, accept ? 'accepted' : 'declined', { actor: uid, metadata: { receipt_id: receipt.id }, key: `${body.action}:${receipt.id}` });
      return json({ status: accept ? 'accepted' : 'declined' });
    }
    throw new ValidationError('Unknown action');
  }

  async function create(body, user) {
    const input = validateCreate(body, user.id);
    if (input.workspaceId) {
      const member = await db.one('workspace_members', { workspace_id: `eq.${input.workspaceId}`, user_id: `eq.${user.id}`, select: 'id' });
      if (!member) throw new ValidationError('You are not a member of that workspace', 403);
    }
    if (input.recipient) {
      const person = await db.one('profiles', { id: `eq.${input.recipient}`, select: 'id' });
      if (!person) throw new ValidationError('Recipient must be a TRYSA user', 404);
    }
    const me = await db.one('profiles', { id: `eq.${user.id}`, select: 'full_name,username' });
    const display = (me?.full_name || me?.username || 'A TRYSA user').slice(0, 80);
    const id = crypto.randomUUID();
    const expires = iso(now() + input.expiryMinutes * 60000);
    const pin_hash = input.pin ? await hashPin(input.pin) : null;

    let code;
    for (let attempt = 0; ; attempt++) {
      code = randomCode(10);
      try {
        await db.insert('trysa_share_sessions', [{ id, sender_user_id: user.id, workspace_id: input.workspaceId, mode: input.mode,
          name: input.name, short_code: code, status: 'uploading', expires_at: expires, max_receivers: input.maxReceivers,
          total_bytes: input.total, sender_display_name: display, pin_hash, show_preview: input.showPreview,
          preview_path: input.previewSize ? `${user.id}/${id}/preview.jpg` : null, preview_status: input.previewSize ? 'pending' : 'none' }]);
        break;
      } catch (e) {
        if (!(e instanceof SupabaseError && e.status === 409) || attempt >= 3) throw e;
      }
    }

    try {
      const rows = input.files.map((f) => {
        const file_id = crypto.randomUUID();
        return { id: file_id, session_id: id, original_name: f.name, object_path: `${user.id}/${id}/${file_id}`,
          mime_type: f.type, byte_size: f.size, sha256: f.sha256, upload_status: 'pending' };
      });
      await db.insert('trysa_share_files', rows);
      if (input.recipient) await db.insert('trysa_share_receipts', [{ session_id: id, receiver_kind: 'account', receiver_user_id: input.recipient, status: 'requested' }]);
      const uploads = [];
      for (const r of rows) uploads.push({ file_id: r.id, name: r.original_name, object_path: r.object_path, upload_url: await db.signUpload(r.object_path) });
      const preview_upload_url = input.previewSize ? await db.signUpload(`${user.id}/${id}/preview.jpg`) : null;
      await event(id, 'created', { actor: user.id, metadata: { mode: input.mode, files: rows.length, bytes: input.total }, key: 'created' });
      return json({ session_id: id, short_code: code, status: 'uploading', expires_at: expires, mode: input.mode,
        share_url: input.mode === 'qr' ? `${base}/s/${code}` : null, uploads, preview_upload_url,
        // Large files: resumable TUS upload with the sender's own session (see migration v3 storage policy).
        resumable: env.SUPABASE_URL ? { endpoint: `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/upload/resumable`, bucket: db.bucket } : null }, 201);
    } catch (e) {
      await db.update('trysa_share_sessions', { id: `eq.${id}` }, { status: 'failed', updated_at: iso(now()) }).catch(() => {});
      throw e;
    }
  }

  async function contentVerdict(file) {
    const head = new Uint8Array(await (await db.getObject(file.object_path, 'bytes=0-15')).arrayBuffer());
    const basic = checkContent(file.mime_type, head);
    if (!basic.ok || !env.SCANNER_URL) return basic;
    try {
      return await scanWithService(env, (await db.getObject(file.object_path)).body, file.original_name);
    } catch (e) {
      console.error('scanner', e.message);
      return env.SCANNER_REQUIRED === 'true' ? { ok: false, reason: 'Malware scanning is unavailable. Try again shortly.' } : { ok: true };
    }
  }

  async function publish(session, uid, ctx) {
    if (session.status === 'ready') return json({ status: 'ready', session_id: session.id }); // idempotent
    if (!['draft', 'uploading'].includes(session.status) || Date.parse(session.expires_at) <= now())
      throw new ValidationError('This transfer can no longer be published', 409);
    const files = await filesOf(session.id);
    if (!files.length) throw new ValidationError('No files in transfer', 409);
    const missing = [];
    for (const f of files) {
      if (f.upload_status === 'verified') continue;
      const size = await db.objectSize(f.object_path);
      if (size == null) { missing.push(f.id); continue; }
      const verdict = size === Number(f.byte_size) ? await contentVerdict(f) : { ok: true };
      if (!verdict.ok) {
        await db.update('trysa_share_files', { id: `eq.${f.id}` }, { upload_status: 'rejected' });
        await event(session.id, 'content_rejected', { actor: uid, metadata: { file_id: f.id, reason: verdict.reason }, key: `content:${f.id}` });
        throw new ValidationError(`${f.original_name}: ${verdict.reason}`, 422);
      }
      if (size !== Number(f.byte_size) || !(await hashMatches(f))) {
        await db.update('trysa_share_files', { id: `eq.${f.id}` }, { upload_status: 'rejected' });
        await event(session.id, 'integrity_failed', { actor: uid, metadata: { file_id: f.id, expected: f.byte_size, actual: size }, key: `integrity:${f.id}` });
        throw new ValidationError(`${f.original_name} did not upload correctly. Please try again.`, 422);
      }
      await db.update('trysa_share_files', { id: `eq.${f.id}` }, { upload_status: 'verified', verified_at: iso(now()) });
    }
    if (missing.length) return json({ error: 'Some files are still uploading', missing_file_ids: missing }, 409);
    if (session.preview_path && session.preview_status === 'pending') {
      // A bad or missing preview never blocks the transfer; it is simply not shown.
      let ok = false;
      try {
        const size = await db.objectSize(session.preview_path);
        if (size && size <= LIMITS.maxPreviewBytes) {
          const head = new Uint8Array(await (await db.getObject(session.preview_path, 'bytes=0-15')).arrayBuffer());
          ok = head[0] === 0xff && head[1] === 0xd8;
        }
      } catch { ok = false; }
      await db.update('trysa_share_sessions', { id: `eq.${session.id}` }, { preview_status: ok ? 'verified' : 'none' });
    }

    const updated = await db.update('trysa_share_sessions', { id: `eq.${session.id}`, status: 'in.(draft,uploading)' },
      { status: 'ready', updated_at: iso(now()) });
    if (!updated.length) return json({ status: 'ready', session_id: session.id });
    await event(session.id, 'ready', { actor: uid, key: 'ready' });

    if (session.mode === 'remote' && session.workspace_id) {
      const receipt = await db.one('trysa_share_receipts', { session_id: `eq.${session.id}`, select: 'receiver_user_id' });
      if (receipt?.receiver_user_id) {
        try {
          await db.insert('connect_notifications', [{ workspace_id: session.workspace_id, user_id: receipt.receiver_user_id,
            type: 'trysa_share_incoming', title: `${session.sender_display_name || 'Someone'} wants to share ${files.length} file${files.length === 1 ? '' : 's'}`,
            body: session.name, link: `/share/receive?session=${session.id}`, metadata: { session_id: session.id } }]);
        } catch (e) { console.error('notification failed', e.message); }
      }
    }
    if (session.mode === 'remote') {
      const receipt = await db.one('trysa_share_receipts', { session_id: `eq.${session.id}`, select: 'receiver_user_id' });
      if (receipt?.receiver_user_id) ctx?.waitUntil?.(notifyUser(db, env, receipt.receiver_user_id).catch((e) => console.error('push', e.message)));
    }
    return json({ status: 'ready', session_id: session.id, share_url: session.mode === 'qr' ? `${base}/s/${session.short_code}` : null });
  }

  // Full-content hash check for files whose sender supplied a SHA-256 (Workers DigestStream).
  async function hashMatches(file) {
    if (!file.sha256 || Number(file.byte_size) > LIMITS.hashVerifyMaxBytes || typeof crypto.DigestStream !== 'function') return true;
    const res = await db.getObject(file.object_path);
    const digest = new crypto.DigestStream('SHA-256');
    await res.body.pipeTo(digest);
    const hex = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === file.sha256;
  }

  async function status(session) {
    const [files, receipts, events] = await Promise.all([
      filesOf(session.id),
      db.select('trysa_share_receipts', { session_id: `eq.${session.id}`,
        select: 'id,receiver_kind,receiver_user_id,status,created_at,accepted_at,declined_at,download_started_at,downloaded_at,download_count' }),
      db.select('trysa_share_events', { session_id: `eq.${session.id}`, select: 'event_type,occurred_at', order: 'occurred_at.asc' }),
    ]);
    const counts = {};
    for (const e of events) counts[e.event_type] = (counts[e.event_type] || 0) + 1;
    const { pin_hash, pin_failures, ...safe } = session;
    return json({ session: { ...safe, pin_protected: !!pin_hash, share_url: session.mode === 'qr' ? `${base}/s/${session.short_code}` : null },
      files: files.map(({ id, original_name, mime_type, byte_size, upload_status }) => ({ id, original_name, mime_type, byte_size, upload_status })),
      receipts, activity: { scans: counts.scanned || 0, accepted: (counts.accepted || 0) + (counts.browser_accepted || 0),
        declined: (counts.declined || 0) + (counts.browser_declined || 0), downloads_completed: counts.receipt_downloaded || 0 } });
  }

  async function revoke(session, uid, ctx) {
    if (session.status === 'revoked') return json({ status: 'revoked' });
    if (SESSION_TERMINAL.has(session.status) && session.status !== 'completed') throw new ValidationError(`Transfer already ${session.status}`, 409);
    await db.update('trysa_share_sessions', { id: `eq.${session.id}` }, { status: 'revoked', updated_at: iso(now()) });
    await event(session.id, 'revoked', { actor: uid, key: 'revoked' });
    // Files are only ever served through this Worker, so revocation is immediate; bytes are deleted right away.
    ctx?.waitUntil?.(cleanupSession({ ...session, status: 'revoked' }));
    return json({ status: 'revoked' });
  }

  // ================================================================ browser receiver
  async function receiverView(request, code) {
    const session = CODE_RE.test(code) ? await sessionByCode(code) : null;
    const nonce = randomToken(16);
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` };
    if (!session) return new Response(receiverPage({ nonce, code, state: { availability: 'not_found' } }), { status: 404, headers });

    const files = await filesOf(session.id);
    const claimed = await claimFromCookie(request, session);
    const availability = claimed ? 'accepted' : publicAvailability(session, await acceptedCount(session.id), now());
    if (!claimed && availability === 'available') {
      const ip = request.headers.get('cf-connecting-ip') || '';
      const visitor = (await sha256Hex(`${session.id}|${ip}|${request.headers.get('user-agent') || ''}`)).slice(0, 24);
      await event(session.id, 'scanned', { key: `scan:${visitor}` }); // privacy: hashed, never raw IP
    }
    const state = {
      availability, code,
      sender: session.sender_display_name || 'A TRYSA user', name: session.name,
      count: files.length, total_bytes: Number(session.total_bytes), kinds: kindSummary(files),
      types: files.map((f) => f.mime_type),
      expires_at: session.expires_at, pin_required: !!session.pin_hash,
      preview_url: session.show_preview && session.preview_status === 'verified' ? `/s/${code}/preview` : null,
      zip_url: files.length > 1 ? `/s/${code}/zip` : null,
      files: claimed ? publicFiles(files, code) : null,
    };
    return new Response(receiverPage({ nonce, code, state }), { status: 200, headers });
  }

  const publicFiles = (files, code) => files.filter((f) => f.upload_status === 'verified')
    .map((f) => ({ id: f.id, name: f.original_name, type: f.mime_type, size: Number(f.byte_size), url: `/s/${code}/f/${f.id}` }));

  async function claimFromCookie(request, session) {
    const token = readCookie(request, cookieName(session.short_code));
    if (!token) return null;
    const receipt = await db.one('trysa_share_receipts', { session_id: `eq.${session.id}`, claim_token_hash: `eq.${await sha256Hex(token)}`, select: '*' });
    return receipt && ['accepted', 'downloading', 'downloaded'].includes(receipt.status) ? receipt : null;
  }

  async function browserAccept(request, code) {
    const session = CODE_RE.test(code) ? await sessionByCode(code) : null;
    if (!session || session.mode !== 'qr') return fail('This share link is not valid', 404);
    const existing = await claimFromCookie(request, session);
    if (existing && isReceivable(session, now())) return json({ status: 'accepted', files: publicFiles(await filesOf(session.id), code) });

    const body = await request.json().catch(() => ({}));
    if (session.pin_hash) {
      if (session.pin_failures >= MAX_PIN_FAILURES) return fail('Too many incorrect PIN attempts. Ask the sender for a new QR.', 423);
      if (!(await verifyPin(body?.pin, session.pin_hash))) {
        const n = await db.rpc('trysa_share_pin_failure', { p_session_id: session.id });
        await event(session.id, 'pin_failed');
        return fail(n >= MAX_PIN_FAILURES ? 'Too many incorrect PIN attempts. Ask the sender for a new QR.' : 'Incorrect PIN', n >= MAX_PIN_FAILURES ? 423 : 403);
      }
    }
    const token = randomToken(32);
    const outcome = await db.rpc('trysa_share_claim_browser', { p_session_id: session.id, p_token_hash: await sha256Hex(token) });
    if (outcome !== 'accepted') {
      const messages = { full: 'This share has already been received', expired: 'This share has expired', revoked: 'The sender cancelled this share' };
      return fail(messages[outcome] || 'This share is not available', outcome === 'full' ? 409 : 410);
    }
    await event(session.id, 'browser_accepted', { metadata: { claim: (await sha256Hex(token)).slice(0, 12) } });
    const maxAge = Math.max(60, Math.floor((Date.parse(session.expires_at) - now()) / 1000));
    return json({ status: 'accepted', files: publicFiles(await filesOf(session.id), code) }, 200, {
      'set-cookie': `${cookieName(code)}=${token}; Path=/s/${code}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict` });
  }

  async function browserDecline(code) {
    const session = CODE_RE.test(code) ? await sessionByCode(code) : null;
    if (session) await event(session.id, 'browser_declined');
    return json({ status: 'declined' });
  }

  // ================================================================ streamed downloads
  // Bytes always flow through the Worker: no long-lived URLs, instant revocation, and
  // the server (not the client) records when every byte of a file was delivered.
  async function streamFile(request, ctx, session, receipt, fileId, actor) {
    if (!isUuid(fileId)) return fail('File not found', 404);
    if (!isReceivable(session, now())) return fail('This share has expired or was cancelled', 410);
    const file = await db.one('trysa_share_files', { id: `eq.${fileId}`, session_id: `eq.${session.id}`, select: '*' });
    if (!file || file.upload_status !== 'verified') return fail('File not found', 404);

    const range = request.headers.get('range');
    const upstream = await db.getObject(file.object_path, range);
    await markStarted(session, receipt);

    const size = Number(file.byte_size);
    const fullRequest = !range || /^bytes=0-(\d*)$/.test(range) && (!range.split('-')[1] || Number(range.split('-')[1]) >= size - 1);
    let sent = 0;
    const { readable, writable } = new TransformStream({ transform(chunk, c) { sent += chunk.byteLength; c.enqueue(chunk); } });
    const done = upstream.body.pipeTo(writable).then(async () => {
      if (fullRequest && sent === size) await fileDelivered(session, receipt, file, actor);
    }).catch(() => event(session.id, 'download_interrupted', { actor, metadata: { receipt_id: receipt.id, file_id: file.id, bytes: sent } }));
    ctx?.waitUntil?.(done);

    const headers = new Headers({ 'content-type': file.mime_type || 'application/octet-stream',
      'content-disposition': contentDisposition(file.original_name), 'cache-control': 'private, no-store',
      'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' });
    for (const h of ['content-length', 'content-range']) { const v = upstream.headers.get(h); if (v) headers.set(h, v); }
    return new Response(readable, { status: upstream.status === 206 ? 206 : 200, headers });
  }

  async function markStarted(session, receipt) {
    if (receipt.status === 'accepted') {
      await db.update('trysa_share_receipts', { id: `eq.${receipt.id}`, status: 'eq.accepted' }, { status: 'downloading', download_started_at: iso(now()) });
    }
    if (canTransition(session.status, 'transferring') && session.status !== 'transferring') {
      await db.update('trysa_share_sessions', { id: `eq.${session.id}`, status: 'in.(ready,claimed)' }, { status: 'transferring', updated_at: iso(now()) });
    }
  }

  // "Download all" as one streamed ZIP; each file counts as delivered once its bytes are written.
  async function streamZip(session, receipt, actor) {
    if (!isReceivable(session, now())) return fail('This share has expired or was cancelled', 410);
    const files = (await filesOf(session.id)).filter((f) => f.upload_status === 'verified');
    if (!files.length) return fail('File not found', 404);
    await markStarted(session, receipt);
    const { stream, length } = zipStream(
      files.map((f) => ({ name: f.original_name, size: Number(f.byte_size), mtime: Date.parse(f.created_at) || now() })),
      async (_e, i) => (await db.getObject(files[i].object_path)).body,
      (_e, i) => fileDelivered(session, receipt, files[i], actor).catch((e) => console.error('delivery record', e.message)));
    const zipName = `${(session.name || 'TRYSA Share').replace(/\.zip$/i, '').slice(0, 100)}.zip`;
    return new Response(stream, { headers: { 'content-type': 'application/zip', 'content-length': String(length),
      'content-disposition': contentDisposition(zipName), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }

  async function servePreview(session) {
    if (!session.show_preview || session.preview_status !== 'verified' || !isReceivable(session, now())) return fail('No preview', 404);
    const up = await db.getObject(session.preview_path);
    return new Response(up.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
  }

  async function fileDelivered(session, receipt, file, actor) {
    await event(session.id, 'file_delivered', { actor, metadata: { receipt_id: receipt.id, file_id: file.id }, key: `delivered:${receipt.id}:${file.id}` });
    const [files, delivered] = await Promise.all([
      db.select('trysa_share_files', { session_id: `eq.${session.id}`, upload_status: 'eq.verified', select: 'id' }),
      db.select('trysa_share_events', { session_id: `eq.${session.id}`, event_type: 'eq.file_delivered', 'metadata->>receipt_id': `eq.${receipt.id}`, select: 'metadata' }),
    ]);
    const got = new Set(delivered.map((e) => e.metadata?.file_id));
    if (!files.every((f) => got.has(f.id))) return;
    const updated = await db.update('trysa_share_receipts', { id: `eq.${receipt.id}`, status: 'neq.downloaded' }, { status: 'downloaded', downloaded_at: iso(now()) });
    if (!updated.length) return; // already counted — no duplicate receipts
    await event(session.id, 'receipt_downloaded', { actor, metadata: { receipt_id: receipt.id }, key: `downloaded:${receipt.id}` });
    const done = (await db.select('trysa_share_receipts', { session_id: `eq.${session.id}`, status: 'eq.downloaded', select: 'id' })).length;
    if (sessionAfterDownload(session, done) === 'completed') {
      const s = await db.update('trysa_share_sessions', { id: `eq.${session.id}`, status: 'in.(claimed,transferring)' }, { status: 'completed', updated_at: iso(now()) });
      if (s.length) await event(session.id, 'completed', { key: 'completed' });
    }
  }

  async function browserDownload(request, ctx, code, fileId) {
    const session = CODE_RE.test(code) ? await sessionByCode(code) : null;
    if (!session) return fail('Not found', 404);
    const receipt = await claimFromCookie(request, session);
    if (!receipt) return fail('Open the share link and tap Accept first', 403);
    if (fileId === 'zip') return streamZip(session, receipt, null);
    return streamFile(request, ctx, session, receipt, fileId, null);
  }

  async function accountDownload(request, ctx, sessionId, fileId) {
    const user = await requireUser(request);
    if (!isUuid(sessionId)) return fail('Not found', 404);
    const session = await db.one('trysa_share_sessions', { id: `eq.${sessionId}`, select: '*' });
    const receipt = session && await db.one('trysa_share_receipts', { session_id: `eq.${sessionId}`, receiver_user_id: `eq.${user.id}`, select: '*' });
    if (!receipt) return fail('Not found', 404);
    if (!['accepted', 'downloading', 'downloaded'].includes(receipt.status)) return fail('Accept the transfer first', 403);
    if (fileId === 'zip') return streamZip(session, receipt, user.id);
    return streamFile(request, ctx, session, receipt, fileId, user.id);
  }

  async function accountPreview(request, sessionId) {
    const user = await requireUser(request);
    if (!isUuid(sessionId)) return fail('Not found', 404);
    const session = await db.one('trysa_share_sessions', { id: `eq.${sessionId}`, select: '*' });
    if (!session) return fail('Not found', 404);
    const allowed = session.sender_user_id === user.id ||
      !!(await db.one('trysa_share_receipts', { session_id: `eq.${sessionId}`, receiver_user_id: `eq.${user.id}`, select: 'id' }));
    return allowed ? servePreview(session) : fail('Not found', 404);
  }

  // ================================================================ cleanup (cron)
  async function cleanupSession(session) {
    const files = await filesOf(session.id);
    const live = files.filter((f) => f.upload_status !== 'deleted');
    if (live.length) {
      await db.removeObjects(live.map((f) => f.object_path));
      await db.update('trysa_share_files', { session_id: `eq.${session.id}` }, { upload_status: 'deleted' });
    }
    if (session.preview_path && session.preview_status !== 'deleted') {
      await db.removeObjects([session.preview_path]);
    }
    const patch = { cleaned_at: iso(now()), updated_at: iso(now()), ...(session.preview_path ? { preview_status: 'deleted' } : {}) };
    if (!['revoked', 'failed', 'expired'].includes(session.status)) patch.status = 'expired';
    await db.update('trysa_share_sessions', { id: `eq.${session.id}` }, patch);
    await event(session.id, 'cleaned', { metadata: { files: live.length }, key: 'cleaned' });
  }

  async function cleanup(limit = 100) {
    const t = iso(now());
    const due = await db.select('trysa_share_sessions', { cleaned_at: 'is.null',
      or: `(expires_at.lt.${t},status.in.(revoked,failed))`, select: '*', limit: String(limit) });
    let cleaned = 0;
    for (const s of due) {
      try { await cleanupSession(s); cleaned++; } catch (e) { console.error('cleanup failed', s.id, e.message); }
    }
    return cleaned;
  }

  // ================================================================ nearby (WebSocket → Durable Object)
  // Browsers cannot set headers on WebSockets, so the access token travels as a subprotocol:
  //   new WebSocket(url, ['trysa', accessToken])   — kept out of URLs and access logs.
  async function nearbyConnect(request) {
    if (request.headers.get('upgrade') !== 'websocket') return fail('Expected WebSocket', 426);
    if (!env.NEARBY) return fail('Nearby is not enabled', 503);
    const origin = request.headers.get('origin');
    if (origin && !allowed.has(origin)) return fail('Origin not allowed', 403);
    const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map((x) => x.trim());
    if (protocols[0] !== 'trysa' || !protocols[1]) return fail('Sign in to TRYSA', 401);
    const user = await db.getUser(protocols[1]);
    if (!user) return fail('Sign in to TRYSA', 401);
    const room = await roomKey(request.headers.get('cf-connecting-ip'), env.NEARBY_SALT || '');
    if (!room) return fail('Network not supported for Nearby', 400);
    const profile = await db.one('profiles', { id: `eq.${user.id}`, select: PROFILE_COLS });
    const people = await contacts(user.id, '');
    const headers = new Headers(request.headers);
    headers.delete('sec-websocket-protocol'); // the token never reaches the room
    headers.set('x-trysa-person', JSON.stringify(personOf(profile || { id: user.id })));
    headers.set('x-trysa-contacts', JSON.stringify(people.map((p) => p.id)));
    const stub = env.NEARBY.get(env.NEARBY.idFromName(room));
    return stub.fetch(new Request(request.url, { headers }));
  }

  // ================================================================ installable web app (static assets)
  async function appShell(request, path) {
    // Share-target POST arriving before the service worker is installed: just open the app.
    if (path === '/share/receive-share') return Response.redirect(`${base}/share/`, 303);
    if (!env.ASSETS) return fail('Not found', 404);
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    const supa = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin : '';
    out.headers.set('content-security-policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'",
      `img-src 'self' data: blob: ${supa} https:`, "media-src 'self' blob:", `connect-src 'self' ${supa}`,
      "worker-src 'self'", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"].join('; '));
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('referrer-policy', 'no-referrer');
    out.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (path.endsWith('/sw.js')) out.headers.set('cache-control', 'no-cache');
    return out;
  }

  // ================================================================ router
  async function handle(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = (re) => path.match(re);
    let r;
    try {
      if (path === '/api/share/v1/nearby') {
        if (await rateLimited(request, 'nearby')) return fail('Too many requests', 429);
        return await nearbyConnect(request);
      }
      if (path.startsWith('/api/share/')) {
        const h = cors(request);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
        if (await rateLimited(request, 'api')) return fail('Too many requests', 429, h);
        let res;
        if (path === '/api/share/v1/email-link' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const r = await requestEmailLink({ db, env, email: body?.email, base, ip: request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() });
          res = json(r.body, r.status);
        } else if (path === '/api/share/v1/config' && request.method === 'GET') {
          res = json({ supabase_url: env.SUPABASE_URL, publishable_key: env.SUPABASE_PUBLISHABLE_KEY, push_public_key: env.VAPID_PUBLIC_KEY || null },
            200, { 'cache-control': 'public, max-age=300' });
        } else if (path === '/api/share/v1' && request.method === 'POST') res = await api(request, ctx);
        else if ((r = m(/^\/api\/share\/v1\/sessions\/([^/]+)\/files\/([^/]+)$/)) && request.method === 'GET') res = await accountDownload(request, ctx, r[1], r[2]);
        else if ((r = m(/^\/api\/share\/v1\/sessions\/([^/]+)\/zip$/)) && request.method === 'GET') res = await accountDownload(request, ctx, r[1], 'zip');
        else if ((r = m(/^\/api\/share\/v1\/sessions\/([^/]+)\/preview$/)) && request.method === 'GET') res = await accountPreview(request, r[1]);
        else res = fail('Not found', 404);
        for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
        return res;
      }
      if (path === '/share' || path.startsWith('/share/')) return await appShell(request, path);
      if ((r = m(/^\/s\/([A-Za-z0-9]{1,16})\/?$/)) && request.method === 'GET') {
        if (await rateLimited(request, 'view')) return new Response('Too many requests', { status: 429 });
        return await receiverView(request, r[1].toUpperCase());
      }
      if ((r = m(/^\/s\/([A-Z0-9]{1,16})\/accept$/)) && request.method === 'POST') {
        if (await rateLimited(request, 'accept')) return fail('Too many requests', 429);
        return await browserAccept(request, r[1]);
      }
      if ((r = m(/^\/s\/([A-Z0-9]{1,16})\/decline$/)) && request.method === 'POST') return await browserDecline(r[1]);
      if ((r = m(/^\/s\/([A-Z0-9]{1,16})\/f\/([^/]+)$/)) && request.method === 'GET') return await browserDownload(request, ctx, r[1], r[2]);
      if ((r = m(/^\/s\/([A-Z0-9]{1,16})\/zip$/)) && request.method === 'GET') return await browserDownload(request, ctx, r[1], 'zip');
      if ((r = m(/^\/s\/([A-Z0-9]{1,16})\/preview$/)) && request.method === 'GET') {
        const session = CODE_RE.test(r[1]) ? await sessionByCode(r[1]) : null;
        return session && session.mode === 'qr' ? await servePreview(session) : fail('Not found', 404);
      }
      return fail('Not found', 404);
    } catch (e) {
      if (e instanceof ValidationError) return fail(e.message, e.status, path.startsWith('/api/') ? cors(request) : {});
      console.error('TRYSA Share error', e?.message, e?.detail);
      return fail('Something went wrong. Please try again.', e instanceof SupabaseError ? 502 : 500, path.startsWith('/api/') ? cors(request) : {});
    }
  }

  return { handle, cleanup };
}
