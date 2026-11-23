// Pure, platform-independent TRYSA Share logic: validation, codes, tokens and
// the session/receipt state machines. No I/O here so it is fully unit-testable.

export const LIMITS = Object.freeze({
  maxFiles: 50,
  maxFileBytes: 1073741824, // 1 GiB – matches bucket + table constraint
  maxTotalBytes: 2147483648, // 2 GiB per transfer
  maxReceivers: 20,
  minExpiryMinutes: 5,
  maxExpiryMinutes: 7 * 24 * 60,
  defaultQrExpiryMinutes: 30, // PRD §10
  defaultRemoteExpiryMinutes: 24 * 60,
  hashVerifyMaxBytes: 256 * 1024 * 1024,
  maxPreviewBytes: 300 * 1024,
});

// Unambiguous alphabet (no 0/O/1/I/L). 10 chars ≈ 50 bits; codes are also rate limited.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z0-9]{6,12}$/;

export function randomCode(length = 10, rng = crypto.getRandomValues.bind(crypto)) {
  const out = [];
  const max = 256 - (256 % CODE_ALPHABET.length); // rejection sampling: no modulo bias
  while (out.length < length) {
    const buf = rng(new Uint8Array(length * 2));
    for (const b of buf) if (b < max && out.length < length) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
  }
  return out.join('');
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// PIN hashing: PBKDF2 with per-session salt. PINs are low-entropy, so the real
// protection is the per-code attempt limit enforced by the API.
export async function hashPin(pin, salt = b64url(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 },
    key, 256);
  return `pbkdf2$${salt}$${b64url(new Uint8Array(bits))}`;
}

export async function verifyPin(pin, stored) {
  if (!stored) return true;
  if (typeof pin !== 'string') return false;
  const [, salt] = stored.split('$');
  const candidate = await hashPin(pin, salt);
  return timingSafeEqual(candidate, stored);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const isUuid = (s) => typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

// Strip path separators / control chars; keep the user's real filename otherwise.
export function sanitizeFileName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 255);
  if (!clean || clean === '.' || clean === '..') return null;
  return clean;
}

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
export const sanitizeMime = (t) => (typeof t === 'string' && MIME_RE.test(t) && t.length <= 120 ? t.toLowerCase() : 'application/octet-stream');

export class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Validate a create request; returns normalised values or throws ValidationError. */
export function validateCreate(body, senderId) {
  if (!body || typeof body !== 'object') throw new ValidationError('JSON body required');
  const mode = body.mode === 'remote' ? 'remote' : body.mode === 'qr' ? 'qr' : null;
  if (!mode) throw new ValidationError('mode must be "qr" or "remote"');

  let recipient = null;
  if (mode === 'remote') {
    if (!isUuid(body.recipient_user_id)) throw new ValidationError('Choose a TRYSA recipient');
    if (body.recipient_user_id === senderId) throw new ValidationError('You cannot send to yourself');
    recipient = body.recipient_user_id;
  }

  const files = body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > LIMITS.maxFiles)
    throw new ValidationError(`Select 1–${LIMITS.maxFiles} files`);
  const normalised = files.map((f, i) => {
    const name = sanitizeFileName(f?.name);
    if (!name) throw new ValidationError(`File ${i + 1} has an invalid name`);
    if (!Number.isSafeInteger(f.size) || f.size < 1 || f.size > LIMITS.maxFileBytes)
      throw new ValidationError(`${name} must be between 1 byte and 1 GB`);
    const sha256 = typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null;
    return { name, size: f.size, type: sanitizeMime(f.type), sha256 };
  });
  const total = normalised.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.maxTotalBytes) throw new ValidationError('Transfers are limited to 2 GB');

  const defExp = mode === 'qr' ? LIMITS.defaultQrExpiryMinutes : LIMITS.defaultRemoteExpiryMinutes;
  const expiry = body.expires_minutes == null ? defExp : Number(body.expires_minutes);
  if (!Number.isInteger(expiry) || expiry < LIMITS.minExpiryMinutes || expiry > LIMITS.maxExpiryMinutes)
    throw new ValidationError('Expiry must be between 5 minutes and 7 days');

  const maxReceivers = mode === 'remote' ? 1 : body.max_receivers == null ? 1 : Number(body.max_receivers);
  if (!Number.isInteger(maxReceivers) || maxReceivers < 1 || maxReceivers > LIMITS.maxReceivers)
    throw new ValidationError('Receivers must be between 1 and 20');

  let pin = null;
  if (body.pin != null && body.pin !== '') {
    if (mode !== 'qr') throw new ValidationError('PIN applies to QR transfers only');
    if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) throw new ValidationError('PIN must be 4–8 digits');
    pin = body.pin;
  }

  const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 120) ||
    (normalised.length === 1 ? normalised[0].name.slice(0, 120) : `${normalised.length} files`);
  const workspaceId = body.workspace_id == null ? null : body.workspace_id;
  if (workspaceId !== null && !isUuid(workspaceId)) throw new ValidationError('Invalid workspace');

  // Optional preview: a small JPEG thumbnail generated (and EXIF-stripped) on the sender's device.
  let previewSize = null;
  if (body.preview != null) {
    previewSize = Number(body.preview?.size);
    if (!Number.isInteger(previewSize) || previewSize < 1 || previewSize > LIMITS.maxPreviewBytes)
      throw new ValidationError('Preview image is too large');
  }
  const showPreview = previewSize != null && body.show_preview !== false;

  return { mode, recipient, files: normalised, total, expiryMinutes: expiry, maxReceivers, pin, name, workspaceId, previewSize, showPreview };
}

// ---------------------------------------------------------------------------
// State machines (PRD §9)
// Session: draft → uploading → ready → claimed → transferring → completed
//          with failed / expired / revoked terminal paths.
export const SESSION_TERMINAL = new Set(['completed', 'failed', 'expired', 'revoked']);
const SESSION_NEXT = {
  draft: ['uploading', 'failed', 'expired', 'revoked'],
  uploading: ['ready', 'failed', 'expired', 'revoked'],
  ready: ['claimed', 'expired', 'revoked'],
  claimed: ['claimed', 'transferring', 'expired', 'revoked'],
  transferring: ['transferring', 'claimed', 'completed', 'expired', 'revoked'],
  completed: ['expired'], // retained until expiry, then cleaned up
  failed: [], expired: [], revoked: [],
};
export const canTransition = (from, to) => (SESSION_NEXT[from] || []).includes(to);

// Receipt: requested → accepted/declined → downloading → downloaded
const RECEIPT_NEXT = {
  requested: ['accepted', 'declined'],
  accepted: ['downloading', 'downloaded'],
  downloading: ['downloading', 'downloaded'],
  downloaded: ['downloading'], // re-download allowed until expiry; never regresses status column
  declined: [],
};
export const canTransitionReceipt = (from, to) => (RECEIPT_NEXT[from] || []).includes(to);

/** Can file bytes be served to receivers of this session right now? */
export function isReceivable(session, now = Date.now()) {
  return !!session && ['ready', 'claimed', 'transferring', 'completed'].includes(session.status) &&
    Date.parse(session.expires_at) > now;
}

/** Status shown to a receiver before acceptance, without leaking internals. */
export function publicAvailability(session, acceptedCount, now = Date.now()) {
  if (!session) return 'not_found';
  if (session.status === 'revoked') return 'revoked';
  if (session.status === 'expired' || Date.parse(session.expires_at) <= now) return 'expired';
  if (['draft', 'uploading'].includes(session.status)) return 'preparing';
  if (session.status === 'failed') return 'unavailable';
  if (acceptedCount >= session.max_receivers) return 'full';
  return 'available';
}

/** Session status after a receiver finished downloading every file. */
export function sessionAfterDownload(session, downloadedReceivers) {
  return downloadedReceivers >= session.max_receivers ? 'completed' : 'transferring';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Content-Disposition header that is safe for any filename (RFC 6266 / 5987). */
export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Summarise file kinds for the pre-accept preview (no names before acceptance). */
export function kindSummary(files) {
  const counts = { photo: 0, video: 0, document: 0, other: 0 };
  for (const f of files) {
    const t = f.mime_type || '';
    if (t.startsWith('image/')) counts.photo++;
    else if (t.startsWith('video/')) counts.video++;
    else if (t === 'application/pdf' || t.startsWith('text/') || t.includes('document') || t.includes('sheet') || t.includes('presentation')) counts.document++;
    else counts.other++;
  }
  return Object.entries(counts).filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
}
