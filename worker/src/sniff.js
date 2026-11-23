// Lightweight content checks run at publish time on the first bytes of each upload.
// This is NOT antivirus: it blocks native executables and files whose content
// contradicts their declared media type. A real scanner can be plugged in via
// SCANNER_URL (see scanWithService).

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b, from, to) => String.fromCharCode(...b.slice(from, to));

/** Best-effort type detection from magic bytes. */
export function detect(bytes) {
  const b = bytes;
  if (b.length < 4) return 'unknown';
  if (startsWith(b, [0x4d, 0x5a])) return 'executable/pe';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'executable/elf';
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]].some((s) => startsWith(b, s))) return 'executable/macho';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const kind = ascii(b, 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'AVI ') return 'video/x-msvideo';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(b, 0, 4) === '%PDF') return 'application/pdf';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (b[0] === 0x23 && b[1] === 0x21) return 'text/x-script';
  return 'unknown';
}

const FAMILIES = {
  image: (t) => t.startsWith('image/'),
  video: (t) => t.startsWith('video/') || t === 'image/heic', // Live Photos / HEVC containers share ftyp
  'application/pdf': (t) => t === 'application/pdf',
};

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkContent(declaredType, headBytes) {
  const actual = detect(headBytes);
  if (actual.startsWith('executable/')) return { ok: false, reason: 'Apps and programs cannot be shared with TRYSA Share' };
  const declared = (declaredType || '').toLowerCase();
  const family = declared.startsWith('image/') ? 'image' : declared.startsWith('video/') ? 'video' : declared === 'application/pdf' ? 'application/pdf' : null;
  if (!family) return { ok: true };
  if (actual === 'unknown') {
    // Formats we do not fingerprint (RAW photos, TIFF, SVG…) are allowed; known media must match.
    return { ok: true };
  }
  const match = FAMILIES[family](actual) || (family === 'image' && actual.startsWith('video/') && declared === 'image/heic');
  return match ? { ok: true } : { ok: false, reason: 'The file content does not match its type' };
}

/** Optional external scanner (e.g. a ClamAV REST service). Expects JSON { clean: boolean }. */
export async function scanWithService(env, body, name, fetchImpl = fetch) {
  if (!env.SCANNER_URL) return { ok: true, scanned: false };
  const res = await fetchImpl(env.SCANNER_URL, {
    method: 'POST', body,
    headers: { authorization: `Bearer ${env.SCANNER_TOKEN || ''}`, 'x-file-name': encodeURIComponent(name) },
  });
  if (!res.ok) throw new Error(`scanner unavailable (${res.status})`);
  const out = await res.json();
  return out.clean ? { ok: true, scanned: true } : { ok: false, scanned: true, reason: 'This file was flagged by the malware scanner' };
}
