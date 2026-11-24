// TRYSA Share web app: share sheet, Nearby, QR, Contacts, Inbox, incoming requests.
import { Nearby } from '/share/nearby-client.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = '/api/share/v1';
const TUS_CHUNK = 6 * 1024 * 1024; // Supabase resumable uploads require 6 MB chunks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ formatting
export function size(n) {
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; n = Number(n) || 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const kindOf = (type = '') => type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'file';
function counts(items) {
  const c = { photo: 0, video: 0, file: 0 };
  for (const it of items) c[kindOf(it.type || it.mime_type)]++;
  return c;
}
/** "a photo", "3 photos", "2 photos and a video", "5 items" */
export function describe(items) {
  const c = counts(items);
  const parts = Object.entries(c).filter(([, n]) => n);
  const word = (k, n) => n === 1 ? `a ${k}` : `${n} ${k}s`;
  if (parts.length === 1) return word(parts[0][0], parts[0][1]);
  if (parts.length === 2 && !c.file) return `${word('photo', c.photo)} and ${word('video', c.video)}`;
  return `${items.length} items`;
}
/** "1 Photo Selected", "3 Videos Selected", "4 Items Selected" */
export function selectedTitle(items) {
  const c = counts(items);
  const kinds = Object.entries(c).filter(([, n]) => n);
  const n = items.length;
  const noun = kinds.length === 1 ? { photo: 'Photo', video: 'Video', file: 'File' }[kinds[0][0]] : 'Item';
  return `${n} ${noun}${n === 1 ? '' : 's'} Selected`;
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}
function hue(str) { let h = 0; for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''); }
function paintAvatar(el, person) {
  const keepsChildren = !!el.querySelector('.online');
  if (person?.avatar_url) { el.style.backgroundImage = `url("${person.avatar_url}")`; if (!keepsChildren) el.textContent = ''; el.classList.remove('initials'); return; }
  const h = hue(person?.id || person?.name);
  el.style.backgroundImage = `linear-gradient(160deg, hsl(${h} 70% 68%), hsl(${(h + 40) % 360} 62% 46%))`;
  el.classList.add('initials');
  if (!keepsChildren) el.textContent = initials(person?.name);
}
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };

// ------------------------------------------------------------------ boot
const config = await fetch(`${API}/config`).then((r) => r.json());
const sb = supabase.createClient(config.supabase_url, config.publishable_key);
const state = { me: null, files: [], nearby: null, peers: [], inbox: [], prompted: new Set(), history: [], tab: 'inbox' };

async function token() { const { data: { session } } = await sb.auth.getSession(); return session?.access_token || null; }
async function api(action, body = {}) {
  const t = await token(); if (!t) throw new Error('Please sign in again');
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; e.body = j; throw e; }
  return j;
}
async function authed(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${await token()}` } });
  if (!r.ok) throw new Error('Download failed');
  return r;
}

// Mirror the short-lived access token for the service worker (used only to read the inbox on push).
async function mirrorToken(session) {
  try {
    const c = await caches.open('trysa-share-auth');
    if (session) await c.put('/share/_auth', new Response(JSON.stringify({ access_token: session.access_token, expires_at: session.expires_at })));
    else await c.delete('/share/_auth');
  } catch { /* storage unavailable (private mode) */ }
}

sb.auth.onAuthStateChange((_e, session) => { mirrorToken(session); route(session); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/share/sw.js', { scope: '/share/' }).catch(() => {});
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'inbox') refreshInbox(true); });

let booted = false;
async function route(session) {
  $('signin').hidden = !!session; $('home').hidden = !session;
  if (!session || booted) return;
  booted = true;
  const me = await api('me'); state.me = me.person; config.push_public_key ||= me.push_public_key;
  paintAvatar($('meBtn'), state.me);
  startNearby();
  refreshInbox(true); refreshHistory();
  setInterval(() => refreshInbox(true), 15000);
  await takeSharedFiles();
}
route((await sb.auth.getSession()).data.session);

// Sign-in link from our Resend email: exchange the one-time token hash for a session.
{
  const q = new URLSearchParams(location.search);
  if (q.get('token_hash')) {
    const { error } = await sb.auth.verifyOtp({ token_hash: q.get('token_hash'), type: q.get('type') || 'magiclink' });
    history.replaceState(null, '', '/share/');
    if (error) setTimeout(() => { $('loginMsg').textContent = 'That sign-in link has expired or was already used. Request a new one.'; }, 0);
  }
}
const oauth = (provider) => async () => {
  $('loginMsg').textContent = '';
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: `${location.origin}/share/` } });
  if (error) $('loginMsg').textContent = error.message;
};
$('googleLogin').onclick = oauth('google');
$('appleLogin').onclick = oauth('apple');
const friendlyAuthError = (e) => /hook/i.test(e.message)
  ? 'Email sign-in links are unavailable right now. Please sign in with your TRYSA password.'
  : /invalid login/i.test(e.message) ? 'Email or password is incorrect.' : e.message;
$('passwordLogin').onclick = async () => {
  $('loginMsg').textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  $('loginMsg').textContent = error ? friendlyAuthError(error) : '';
};
$('password').onkeydown = (e) => { if (e.key === 'Enter') $('passwordLogin').click(); };
$('login').onclick = async () => {
  $('login').disabled = true; $('loginMsg').textContent = 'Sending…';
  try {
    const r = await fetch(`${API}/email-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim() }) });
    const j = await r.json().catch(() => ({}));
    $('loginMsg').textContent = r.ok ? 'Check your email for a sign-in link from TRYSA Share.' : (j.error || 'Could not send the email.');
  } catch { $('loginMsg').textContent = 'No connection. Try again.'; }
  $('login').disabled = false;
};
$('meBtn').onclick = async () => { if (confirm(`Signed in as ${state.me?.name || ''}. Sign out?`)) { await sb.auth.signOut(); location.reload(); } };

// ------------------------------------------------------------------ picking + share sheet

async function takeSharedFiles() {
  // Android/desktop: files shared from the system share sheet arrive via the service worker.
  if (!new URLSearchParams(location.search).has('shared')) return;
  try {
    const c = await caches.open('trysa-share-target');
    const index = await (await c.match('/share/_shared/index'))?.json();
    const files = [];
    for (const e of index || []) {
      const r = await c.match(e.key);
      if (r) files.push(new File([await r.blob()], e.name, { type: e.type }));
      await c.delete(e.key);
    }
    await c.delete('/share/_shared/index');
    history.replaceState(null, '', '/share/');
    if (files.length) openSheet(files);
  } catch { toast('Could not open the shared files'); }
}

const urls = new Map();
const urlFor = (f) => { if (!urls.has(f)) urls.set(f, URL.createObjectURL(f)); return urls.get(f); };

function slideFor(f) {
  const el = document.createElement('div');
  const k = kindOf(f.type);
  if (k === 'photo') { el.className = 'slide'; el.innerHTML = `<img alt="" loading="lazy">`; el.firstChild.src = urlFor(f); el.firstChild.onerror = () => { el.className = 'slide doc'; el.innerHTML = `<b>${esc(ext(f.name))}</b><span>${esc(f.name)}</span>`; }; }
  else if (k === 'video') { el.className = 'slide'; el.innerHTML = `<video muted playsinline preload="metadata"></video>`; el.firstChild.src = urlFor(f) + '#t=0.1'; }
  else { el.className = 'slide doc'; el.innerHTML = `<b>${esc(ext(f.name))}</b><span>${esc(f.name)}</span>`; }
  el.insertAdjacentHTML('beforeend', `<span class="size">${size(f.size)}</span>`);
  return el;
}
const ext = (n) => (n.includes('.') ? n.split('.').pop() : 'FILE').slice(0, 5).toUpperCase();

function openSheet(files) {
  if (!files.length) return;
  if (files.length > 50) { toast('Choose up to 50 items'); files = files.slice(0, 50); }
  state.files = files;
  $('sheetTitle').textContent = selectedTitle(files);
  const first = files.find((f) => kindOf(f.type) === 'photo');
  if (first) $('sheetThumb').src = urlFor(first); else $('sheetThumb').removeAttribute('src');
  $('carousel').replaceChildren(...files.map(slideFor));
  renderDestPeople();
  show('sheetBackdrop');
}
$('sheetClose').onclick = () => hide('sheetBackdrop');
$('sheetBackdrop').onclick = (e) => { if (e.target === $('sheetBackdrop')) hide('sheetBackdrop'); };
$('optionsBtn').onclick = () => show('optionsBackdrop');
$('optionsDone').onclick = () => hide('optionsBackdrop');

function renderDestPeople() {
  $('destPeople').replaceChildren(...state.peers.map((p) => {
    const b = document.createElement('button');
    b.className = 'dest-person';
    b.innerHTML = `<span class="av"></span><span>${esc(p.person.name.split(' ')[0])}</span>`;
    paintAvatar(b.firstChild, p.person);
    b.onclick = () => sendNearby(p);
    return b;
  }));
}

$('destNearby').onclick = () => {
  if (state.peers.length === 1) return sendNearby(state.peers[0]);
  if (state.peers.length) { $('destPeople').scrollIntoView({ behavior: 'smooth' }); return toast('Tap a person to send'); }
  toast('No one nearby yet. Ask them to open TRYSA Share and turn Receiving on.', 4200);
};
$('destQr').onclick = () => sendCloud('qr');
$('destLink').onclick = () => sendCloud('qr', null, { link: true });
$('destContacts').onclick = () => { show('contactsBackdrop'); $('contactSearch').value = ''; searchContacts(''); setTimeout(() => $('contactSearch').focus(), 250); };

// ------------------------------------------------------------------ contacts picker
let searchTimer;
$('contactSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchContacts($('contactSearch').value), 220); };
$('contactsCancel').onclick = () => hide('contactsBackdrop');
async function searchContacts(q) {
  try {
    const { people } = await api('contacts', { q });
    $('contactList').replaceChildren(...(people.length ? people.map((p) => {
      const b = document.createElement('button');
      b.className = 'row';
      b.innerHTML = `<span class="av"></span><span class="txt"><b>${esc(p.name)}</b><small>${p.username ? '@' + esc(p.username) : 'TRYSA'}</small></span>`;
      paintAvatar(b.firstChild, p);
      b.onclick = () => { hide('contactsBackdrop'); sendCloud('remote', p); };
      return b;
    }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: q.length < 3 ? 'Type a name, or an exact @username' : 'No one found' })]));
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ person card
const card = {
  open({ person, variant = 'bleed', meta = '', media = null }) {
    const pc = $('personCard');
    pc.className = `person-card ${variant === 'framed' ? 'framed' : ''}`;
    $('pcName').textContent = person?.name || '';
    $('pcHandle').textContent = person?.username ? `@${person.username}` : (person?.name || '');
    $('pcMeta').textContent = meta;
    paintAvatar($('pcAvatar'), person);
    const m = $('pcMedia'); m.innerHTML = ''; m.className = 'pc-media'; m.style.backgroundImage = '';
    if (media) m.append(media);
    else if (person?.avatar_url) { m.style.backgroundImage = `url("${person.avatar_url}")`; tintFrom(person.avatar_url); }
    else { m.classList.add('initials'); m.textContent = initials(person?.name); const h = hue(person?.id || person?.name);
      pc.style.setProperty('--g1', `hsl(${h} 70% 70%)`); pc.style.setProperty('--g2', `hsl(${(h + 40) % 360} 60% 42%)`); pc.style.setProperty('--fade', `hsl(${(h + 40) % 360} 55% 32% / .95)`); }
    this.progress(null); $('pcSecondary').hidden = true; $('pcOnline').hidden = variant === 'framed';
    show('personOverlay');
  },
  status(text, busy = true) { $('pcStatusText').textContent = text; $('pcSpinner').hidden = !busy; $('pcCheck').hidden = text !== 'Delivered'; },
  progress(f) { $('pcProgress').hidden = f == null; if (f != null) $('pcProgress').firstChild.style.width = `${Math.round(f * 100)}%`; },
  action(text, icon, fn) { $('pcActionText').textContent = text; $('pcActionIcon').textContent = icon || ''; $('pcAction').onclick = fn; },
  secondary(text, fn) { const b = $('pcSecondary'); b.hidden = !text; b.textContent = text || ''; b.onclick = fn; },
  close() { hide('personOverlay'); },
};
$('personOverlay').onclick = (e) => { if (e.target === $('personOverlay') && card.closable) card.close(); };

/** Tint the bottom fade with the photo's own colour, like the reference cards. */
function tintFrom(src) {
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = 24; c.height = 24;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 14, 24, 10).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      $('personCard').style.setProperty('--fade', `rgb(${r / n * .78 | 0} ${g / n * .78 | 0} ${b / n * .78 | 0} / .96)`);
    } catch { /* cross-origin avatar: keep default */ }
  };
  img.src = src;
}
const addPersonAction = () => card.action('Add person', '＋', () => { card.close(); show('sheetBackdrop'); });

// ------------------------------------------------------------------ preview thumbnail (EXIF-free)
async function makePreview(files, maxSide = 480, maxBytes = 280 * 1024) {
  const f = files.find((x) => kindOf(x.type) === 'photo') || files.find((x) => kindOf(x.type) === 'video');
  if (!f) return null;
  try {
    let source;
    if (kindOf(f.type) === 'photo') source = await createImageBitmap(f);
    else {
      source = document.createElement('video'); source.muted = true; source.playsInline = true; source.src = urlFor(f);
      await new Promise((res, rej) => { source.onloadeddata = res; source.onerror = rej; setTimeout(rej, 4000); });
      source.currentTime = Math.min(0.5, source.duration || 0); await new Promise((r) => { source.onseeked = r; setTimeout(r, 1500); });
    }
    const w = source.width || source.videoWidth, h = source.height || source.videoHeight;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    for (const q of [0.72, 0.55, 0.4]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) return blob;
    }
  } catch { /* format not decodable in this browser (e.g. HEIC on Chrome) */ }
  return null;
}
const blobToDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

// ------------------------------------------------------------------ uploads (resumable for large files)
function putUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('PUT', url);
    x.setRequestHeader('content-type', file.type || 'application/octet-stream');
    if (url.startsWith(config.supabase_url)) x.setRequestHeader('apikey', config.publishable_key);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`Upload failed (${x.status})`)));
    x.onerror = () => reject(new Error('Connection lost'));
    x.send(file);
  });
}
async function tusUpload(resumable, objectPath, file, onProgress) {
  const t = await token();
  return new Promise((resolve, reject) => {
    const up = new tus.Upload(file, {
      endpoint: resumable.endpoint, chunkSize: TUS_CHUNK, retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
      headers: { authorization: `Bearer ${t}`, apikey: config.publishable_key, 'x-upsert': 'false' },
      uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
      metadata: { bucketName: resumable.bucket, objectName: objectPath, contentType: file.type || 'application/octet-stream', cacheControl: '3600' },
      onProgress: (sent) => onProgress(sent), onSuccess: resolve, onError: reject,
    });
    up.findPreviousUploads().then((prev) => { if (prev.length) up.resumeFromPreviousUpload(prev[0]); up.start(); });
  });
}
async function uploadAll(created, files, onProgress) {
  const total = files.reduce((n, f) => n + f.size, 0); let done = 0;
  for (const [i, f] of files.entries()) {
    const u = created.uploads[i];
    const report = (sent) => onProgress((done + sent) / total);
    if (created.resumable && f.size > TUS_CHUNK) {
      try { await tusUpload(created.resumable, u.object_path, f, report); done += f.size; continue; }
      catch (e) { console.warn('resumable upload unavailable, using single upload', e); }
    }
    await putUpload(u.upload_url, f, report); done += f.size;
  }
}

// ------------------------------------------------------------------ send via TRYSA cloud (QR / link / contact)
async function sendCloud(mode, recipient = null, { link = false } = {}) {
  const files = state.files; if (!files.length) return;
  hide('sheetBackdrop');
  const qrCardPerson = { ...state.me, name: link ? 'Share link' : 'Scan to receive' };
  card.open(mode === 'qr' ? { person: qrCardPerson, variant: 'framed', meta: 'Preparing…' } : { person: recipient, meta: 'TRYSA' });
  if (mode === 'qr') $('pcHandle').textContent = state.me?.username ? `@${state.me.username}` : state.me?.name || '';
  card.status('Connecting'); card.closable = false;
  let created;
  const cancel = async () => { if (created) await api('revoke', { session_id: created.session_id }).catch(() => {}); card.closable = true; card.close(); };
  card.action('Cancel', '', cancel);
  try {
    const showPreview = mode === 'remote' ? true : $('optPreview').checked;
    const preview = showPreview ? await makePreview(files) : null;
    const body = { mode, name: files.length === 1 ? files[0].name : `${describe(files)} from ${state.me?.name || 'TRYSA'}`.replace(/^a /, 'A ').slice(0, 120),
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) };
    if (preview) { body.preview = { size: preview.size }; body.show_preview = true; }
    if (mode === 'remote') body.recipient_user_id = recipient.id;
    else { body.expires_minutes = Number($('optExpiry').value); body.max_receivers = Number($('optReceivers').value); if ($('optPin').value) body.pin = $('optPin').value; }
    created = await api('create', body);
    if (preview && created.preview_upload_url) await putUpload(created.preview_upload_url, new File([preview], 'preview.jpg', { type: 'image/jpeg' }), () => {}).catch(() => {});
    card.status('Uploading'); card.progress(0);
    await uploadAll(created, files, (f) => { card.progress(f); card.status(`Uploading · ${Math.round(f * 100)}%`); });
    for (let i = 0; ; i++) {
      try { await api('publish', { session_id: created.session_id }); break; }
      catch (e) { if (e.status !== 409 || i >= 3) throw e; await sleep(1200); }
    }
    card.progress(null);
  } catch (e) {
    card.status(e.message, false); card.closable = true;
    card.action('Close', '', () => card.close());
    return;
  }

  if (mode === 'qr') {
    const q = qrcode(0, 'M'); q.addData(created.share_url); q.make();
    const box = document.createElement('div'); box.className = 'qr-box'; box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 1, scalable: true });
    $('pcMedia').replaceChildren(box);
    card.status(link ? 'Link ready' : 'Waiting for scan', !link);
    $('pcMeta').textContent = `Expires in ${Math.round((Date.parse(created.expires_at) - Date.now()) / 60000)} min`;
    card.action(link ? 'Share link' : 'Copy link', '', async () => {
      if (navigator.share) await navigator.share({ title: 'TRYSA Share', url: created.share_url }).catch(() => {});
      else { await navigator.clipboard.writeText(created.share_url); toast('Link copied'); }
    });
    if (link) { navigator.clipboard?.writeText(created.share_url).then(() => toast('Link copied')).catch(() => {}); }
  } else {
    card.status(`Waiting for ${recipient.name.split(' ')[0]}`);
    card.action('Cancel', '', cancel);
  }
  if (mode === 'qr') card.secondary('Cancel share', cancel);
  else card.secondary('Done', () => card.close());
  card.closable = true;
  watchCloud(created, mode, recipient);
}

async function watchCloud(created, mode, recipient) {
  const first = recipient?.name.split(' ')[0];
  for (;;) {
    await sleep(3000);
    if ($('personOverlay').hidden) return;
    let s; try { s = await api('status', { session_id: created.session_id }); } catch { continue; }
    const st = s.session.status, a = s.activity;
    if (st === 'completed') { card.status('Delivered', false); card.secondary(''); addPersonAction(); refreshHistory(); return; }
    if (st === 'revoked' || st === 'expired') { card.status(st === 'revoked' ? 'Cancelled' : 'Expired', false); return; }
    if (a.declined && mode === 'remote') { card.status(`${first} declined`, false); card.secondary(''); addPersonAction(); return; }
    if (st === 'transferring') card.status(mode === 'remote' ? `${first} is downloading` : 'Downloading on their phone');
    else if (a.accepted) card.status(mode === 'remote' ? `${first} accepted` : `Accepted${s.session.max_receivers > 1 ? ` · ${a.accepted}/${s.session.max_receivers}` : ''}`);
    else if (a.scans && mode === 'qr') card.status('Opened on a phone');
  }
}

// ------------------------------------------------------------------ Nearby
function startNearby() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const nb = new Nearby({ url: `${proto}//${location.host}${API}/nearby`, getToken: token });
  state.nearby = nb;
  nb.on('status', (s) => { $('nearbyState').textContent = s === 'online' ? (state.peers.length ? '' : 'Looking…') : 'Offline'; });
  nb.on('peers', (peers) => { state.peers = peers; renderNearby(); renderDestPeople(); });
  nb.on('presence', ({ mode, until }) => renderReceiving(mode, until));
  nb.on('error', (m) => toast(m));
  nb.on('incoming', onIncomingNearby);
  nb.connect();
}

function renderNearby() {
  $('nearbyState').textContent = state.peers.length ? `${state.peers.length} nearby` : 'Looking…';
  $('nearbyRow').replaceChildren(...state.peers.map((p) => {
    const b = document.createElement('button');
    b.className = 'mini-card';
    paintAvatar(b, p.person);
    if (!p.person.avatar_url) { b.style.fontSize = '48px'; b.style.display = 'grid'; b.style.placeItems = 'center'; }
    b.insertAdjacentHTML('beforeend', `<b>${esc(p.person.name)}</b><small>${esc(p.device)}</small>`);
    b.onclick = () => { if (state.files.length) sendNearby(p); else { state.pendingPeer = p; $('files').click(); } };
    return b;
  }));
}
// Picking files after tapping a person sends straight to them.
$('files').onchange = () => {
  const files = [...$('files').files]; $('files').value = '';
  if (state.pendingPeer && files.length) { state.files = files; const p = state.pendingPeer; state.pendingPeer = null; return sendNearby(p); }
  openSheet(files);
};

const FAIL_TEXT = { 'no-response': 'No response', 'no-direct-path': "Couldn't connect directly", 'connection-lost': 'Connection lost',
  'cancelled-by-peer': 'Cancelled', 'no-ack': 'Not confirmed', integrity: 'Transfer damaged' };

async function sendNearby(peer) {
  const files = state.files; if (!files.length) return;
  hide('sheetBackdrop');
  const first = peer.person.name.split(' ')[0];
  card.open({ person: peer.person, meta: `Nearby · ${peer.device}` });
  card.status('Connecting'); card.closable = false;
  const previewBlob = await makePreview(files, 360, 48 * 1024);
  const t = state.nearby.send(peer, files, { preview: previewBlob ? await blobToDataUrl(previewBlob) : null, kinds: describe(files) });
  card.action('Cancel', '', () => { t.cancel(); card.closable = true; card.close(); });
  t.on('state', (s, detail) => {
    if (s === 'waiting') card.status(`Waiting for ${first}`);
    else if (s === 'connecting') card.status('Connecting');
    else if (s === 'sending') { card.status('Sending'); card.progress(0); }
    else if (s === 'confirming') card.status('Finishing');
    else if (s === 'done') { card.progress(null); card.status('Delivered', false); card.closable = true; addPersonAction(); }
    else if (s === 'declined') { card.status(`${first} declined`, false); card.closable = true; addPersonAction(); }
    else if (s === 'failed') {
      card.progress(null); card.status(FAIL_TEXT[detail] || 'Failed', false); card.closable = true;
      card.action('Send via TRYSA', '', () => { card.close(); sendCloud('remote', peer.person); });
      card.secondary('Close', () => card.close());
    }
  });
  t.on('progress', (f) => { card.progress(f); card.status(`Sending · ${Math.round(f * 100)}%`); });
}

// ------------------------------------------------------------------ incoming (alert)
const alertBox = {
  open({ message, previewUrl, onAccept, onDecline }) {
    $('alertTitle').textContent = 'TRYSA Share';
    $('alertMsg').textContent = message;
    $('alertPreview').hidden = !previewUrl; if (previewUrl) $('alertImg').src = previewUrl;
    $('alertProgress').hidden = true;
    $('alertActions').className = 'alert-actions'; $('alertDecline').hidden = false;
    $('alertDecline').textContent = 'Decline'; $('alertAccept').textContent = 'Accept';
    $('alertDecline').onclick = () => { hide('alertOverlay'); onDecline(); };
    $('alertAccept').onclick = () => onAccept();
    show('alertOverlay');
    navigator.vibrate?.(30);
  },
  progress(f, text) { $('alertActions').hidden = true; $('alertProgress').hidden = false; $('alertProgress').querySelector('i').style.width = `${Math.round(f * 100)}%`; $('alertProgressText').textContent = text; },
  done(message) {
    $('alertMsg').textContent = message; $('alertProgress').hidden = true; $('alertActions').hidden = false;
    $('alertActions').className = 'alert-actions single'; $('alertDecline').hidden = true; $('alertAccept').textContent = 'OK';
    $('alertAccept').onclick = () => hide('alertOverlay');
  },
};

function onIncomingNearby(t) {
  const name = t.person.name.split(' ')[0];
  alertBox.open({
    message: `${name} would like to share ${t.request.kinds || 'files'}.`,
    previewUrl: typeof t.request.preview === 'string' && t.request.preview.startsWith('data:image/jpeg') ? t.request.preview : null,
    onDecline: () => t.decline(),
    onAccept: () => { t.accept(); alertBox.progress(0, 'Connecting…'); },
  });
  t.on('progress', (f) => alertBox.progress(f, `Receiving · ${Math.round(f * 100)}%`));
  t.on('state', (s, detail) => {
    if (s === 'received') { hide('alertOverlay'); openReceived(detail, `From ${t.person.name}`); }
    else if (s === 'failed') alertBox.done(detail === 'no-direct-path' ? `Couldn't connect directly to ${name}. They can send it through TRYSA instead.` : `${FAIL_TEXT[detail] || 'Transfer failed'}.`);
    else if (s === 'cancelled') hide('alertOverlay');
  });
}

async function promptCloud(item) {
  const name = item.sender.name.split(' ')[0];
  let previewUrl = null;
  if (item.session.preview_url) { try { previewUrl = URL.createObjectURL(await (await authed(item.session.preview_url)).blob()); } catch { /* no preview */ } }
  alertBox.open({
    message: `${name} would like to share ${describe(item.files)}.`,
    previewUrl,
    onDecline: async () => { await api('decline', { session_id: item.session.id }).catch((e) => toast(e.message)); refreshInbox(); },
    onAccept: async () => {
      try {
        await api('accept', { session_id: item.session.id });
        const total = item.files.reduce((n, f) => n + Number(f.byte_size), 0); let got = 0;
        const out = [];
        for (const f of item.files) {
          const r = await authed(`${API}/sessions/${item.session.id}/files/${f.id}`);
          const reader = r.body.getReader(); const parts = [];
          for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; alertBox.progress(got / total, `Receiving · ${Math.round(got / total * 100)}%`); }
          out.push(new File(parts, f.original_name, { type: f.mime_type }));
        }
        hide('alertOverlay'); openReceived(out, `From ${item.sender.name}`); refreshInbox();
      } catch (e) { alertBox.done(e.message); }
    },
  });
}

// ------------------------------------------------------------------ received files
function openReceived(files, subtitle) {
  state.received = files;
  $('rcTitle').textContent = selectedTitle(files).replace('Selected', 'Received');
  $('receivedCarousel').replaceChildren(...files.map(slideFor));
  const canShare = navigator.canShare?.({ files });
  const allMedia = files.every((f) => ['photo', 'video'].includes(kindOf(f.type)));
  $('saveShare').hidden = !canShare;
  $('saveShare').textContent = allMedia ? 'Save to Photos' : 'Save or Open';
  $('receivedHint').textContent = canShare ? `${subtitle}. Choose “Save Image” or “Save Video” in the next sheet to add them to Photos.` : subtitle;
  show('receivedBackdrop');
}
$('saveShare').onclick = () => navigator.share({ files: state.received }).catch(() => {});
$('saveFiles').onclick = async () => {
  for (const f of state.received) {
    const a = document.createElement('a'); a.href = urlFor(f); a.download = f.name; document.body.append(a); a.click(); a.remove();
    await sleep(700);
  }
};
$('receivedDone').onclick = () => hide('receivedBackdrop');

// ------------------------------------------------------------------ inbox / history
document.querySelectorAll('.segment button').forEach((b) => { b.onclick = () => {
  document.querySelectorAll('.segment button').forEach((x) => x.classList.toggle('on', x === b));
  state.tab = b.dataset.tab; $('inboxList').hidden = state.tab !== 'inbox'; $('historyList').hidden = state.tab !== 'history';
  if (state.tab === 'history') refreshHistory();
}; });

async function refreshInbox(promptNew = false) {
  let transfers; try { ({ transfers } = await api('inbox')); } catch { return; }
  state.inbox = transfers;
  const waiting = transfers.filter((t) => t.receipt.status === 'requested' && t.session.receivable);
  $('inboxBadge').hidden = !waiting.length; $('inboxBadge').textContent = waiting.length;
  $('inboxList').replaceChildren(...(transfers.length ? transfers.map((t) => {
    const b = document.createElement('button'); b.className = 'row';
    const tag = t.receipt.status === 'requested' ? (t.session.receivable ? '<span class="tag go">Review</span>' : '<span class="tag">Expired</span>') : `<span class="tag">${esc({ accepted: 'Accepted', downloading: 'Saved', downloaded: 'Saved', declined: 'Declined' }[t.receipt.status])}</span>`;
    b.innerHTML = `<span class="av"></span><span class="txt"><b>${esc(t.sender.name)}</b><small>${esc(describe(t.files))} · ${size(t.session.total_bytes)} · ${ago(t.session.created_at)}</small></span>${tag}`;
    paintAvatar(b.firstChild, t.sender);
    b.onclick = () => t.session.receivable && t.receipt.status !== 'declined' ? promptCloud(t) : toast('This transfer is no longer available');
    return b;
  }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Files people send you appear here.' })]));
  if (promptNew && $('alertOverlay').hidden) {
    const next = waiting.find((t) => !state.prompted.has(t.session.id));
    if (next) { state.prompted.add(next.session.id); promptCloud(next); }
  }
}

async function refreshHistory() {
  let transfers; try { ({ transfers } = await api('sent')); } catch { return; }
  $('historyList').replaceChildren(...(transfers.length ? transfers.map((t) => {
    const b = document.createElement('div'); b.className = 'row';
    const label = { uploading: 'Uploading', ready: 'Waiting', claimed: 'Accepted', transferring: 'Downloading', completed: 'Delivered', expired: 'Expired', revoked: 'Cancelled', failed: 'Failed' }[t.status] || t.status;
    b.innerHTML = `<span class="av initials">${t.mode === 'qr' ? 'QR' : '→'}</span><span class="txt"><b>${esc(t.name)}</b><small>${size(t.total_bytes)} · ${ago(t.created_at)}</small></span><span class="tag">${esc(label)}</span>`;
    b.firstChild.style.background = 'var(--pill)'; b.firstChild.style.color = 'var(--pill-ink)'; b.firstChild.style.fontSize = '14px';
    return b;
  }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing sent yet.' })]));
}

// ------------------------------------------------------------------ receiving mode + push
function renderReceiving(mode, until) {
  const label = { off: 'Receiving Off', contacts: 'Contacts Only', everyone: 'Everyone' }[mode];
  $('receivingLabel').textContent = label;
  $('receivingDot').classList.toggle('on', mode !== 'off');
  $('receivingSub').textContent = mode === 'off' ? 'Tap to be discoverable nearby' : `Discoverable until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  document.querySelectorAll('#recvModes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}
$('receivingBtn').onclick = async () => {
  show('recvBackdrop');
  const reg = await navigator.serviceWorker?.getRegistration('/share/');
  $('pushToggle').checked = !!(await reg?.pushManager?.getSubscription());
  $('pushToggle').disabled = !config.push_public_key || !reg?.pushManager;
  if ($('pushToggle').disabled) $('pushHint').textContent = /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add TRYSA Share to your Home Screen to get notifications.' : 'Notifications are not available in this browser.';
};
$('recvDone').onclick = () => hide('recvBackdrop');
document.querySelectorAll('#recvModes button').forEach((b) => { b.onclick = () => { state.nearby?.setPresence(b.dataset.mode); renderReceiving(b.dataset.mode, Date.now() + 600000); }; });

$('pushToggle').onchange = async () => {
  const reg = await navigator.serviceWorker.getRegistration('/share/');
  try {
    if ($('pushToggle').checked) {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked in settings');
      const key = Uint8Array.from(atob(config.push_public_key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('push_subscribe', { endpoint: sub.endpoint });
      toast('Notifications on');
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('push_unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    }
  } catch (e) { $('pushToggle').checked = false; toast(e.message); }
};
