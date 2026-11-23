// TRYSA Nearby client: discovery over the TRYSA hub, file bytes over a direct,
// DTLS-encrypted WebRTC data channel between the two devices.

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
const ACCEPT_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 15_000;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

const uid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) try { fn(...a); } catch (e) { console.error(e); } }
}

export class Nearby extends Emitter {
  constructor({ url, getToken }) {
    super();
    this.url = url; this.getToken = getToken;
    this.peers = []; this.presence = { mode: 'off', device: deviceName() };
    this.transfers = new Map(); this.retry = 0; this.closed = false;
  }

  async connect() {
    const token = await this.getToken();
    if (!token || this.closed) return;
    const ws = new WebSocket(this.url, ['trysa', token]);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.emit('status', 'online'); if (this.presence.mode !== 'off') this.setPresence(this.presence.mode); };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = async () => {
      this.emit('status', 'offline');
      if (this.closed) return;
      this.retry = Math.min(this.retry + 1, 6);
      await sleep(500 * 2 ** this.retry);
      this.connect();
    };
  }

  close() { this.closed = true; this.ws?.close(); }
  raw(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  signal(to, data) { this.raw({ type: 'signal', to, data }); }

  setPresence(mode) {
    this.presence.mode = mode;
    this.raw({ type: 'presence', mode, minutes: 10, device: this.presence.device });
  }

  onMessage(msg) {
    if (msg.type === 'welcome') this.conn = msg.conn;
    else if (msg.type === 'peers') { this.peers = msg.peers; this.emit('peers', msg.peers); }
    else if (msg.type === 'presence') { this.presence.mode = msg.mode; this.emit('presence', msg); }
    else if (msg.type === 'error') this.emit('error', msg.message);
    else if (msg.type === 'signal') {
      const { data } = msg;
      if (data.kind === 'request') {
        const t = new IncomingTransfer(this, msg.from, msg.person, msg.device, data);
        this.transfers.set(data.id, t);
        this.emit('incoming', t);
      } else this.transfers.get(data.id)?.onSignal(data, msg.from);
    }
  }

  /** Start sending `files` to `peer`. Returns an OutgoingTransfer (an event emitter). */
  send(peer, files, extra = {}) {
    const t = new OutgoingTransfer(this, peer, files);
    this.transfers.set(t.id, t);
    t.start(extra);
    return t;
  }
}

class Transfer extends Emitter {
  constructor(hub, peerConn) { super(); this.hub = hub; this.peerConn = peerConn; this.pendingIce = []; this.state = 'new'; }
  signal(data) { this.hub.signal(this.peerConn, { ...data, id: this.id }); }
  setState(s, detail) { this.state = s; this.emit('state', s, detail); }
  makePc() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => { if (e.candidate) this.signal({ kind: 'ice', candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (['failed'].includes(pc.connectionState) && !['done', 'received'].includes(this.state)) this.fail('connection-lost'); };
    this.pc = pc; return pc;
  }
  async addIce(c) { if (this.pc?.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {}); else this.pendingIce.push(c); }
  async flushIce() { for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {}); }
  fail(reason) {
    if (['failed', 'done', 'received', 'declined', 'cancelled'].includes(this.state)) return;
    clearTimeout(this.timer); this.pc?.close(); this.setState('failed', reason);
  }
  cancel() { this.signal({ kind: 'cancel' }); clearTimeout(this.timer); this.pc?.close(); this.setState('cancelled'); }
}

export class OutgoingTransfer extends Transfer {
  constructor(hub, peer, files) {
    super(hub, peer.conn);
    this.id = uid(); this.peer = peer; this.files = files;
    this.total = files.reduce((n, f) => n + f.size, 0);
  }
  start({ preview, kinds } = {}) {
    this.setState('waiting');
    this.signal({ kind: 'request', count: this.files.length, total: this.total, kinds, preview: preview || null });
    this.timer = setTimeout(() => this.fail('no-response'), ACCEPT_TIMEOUT_MS);
  }
  async onSignal(d) {
    if (d.kind === 'decline') { clearTimeout(this.timer); this.setState('declined'); }
    else if (d.kind === 'cancel') this.fail('cancelled-by-peer');
    else if (d.kind === 'accept') {
      clearTimeout(this.timer);
      this.setState('connecting');
      const pc = this.makePc();
      const dc = pc.createDataChannel('trysa-files', { ordered: true });
      dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = LOW_WATER;
      this.dc = dc;
      dc.onopen = () => { clearTimeout(this.timer); this.pump().catch((e) => this.fail(e.message)); };
      dc.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'ack') { this.setState('done', m); pc.close(); } };
      this.timer = setTimeout(() => this.fail('no-direct-path'), CONNECT_TIMEOUT_MS);
      await pc.setLocalDescription(await pc.createOffer());
      this.signal({ kind: 'offer', sdp: pc.localDescription.toJSON() });
    } else if (d.kind === 'answer') { await this.pc.setRemoteDescription(d.sdp); await this.flushIce(); }
    else if (d.kind === 'ice') await this.addIce(d.candidate);
  }
  async pump() {
    const dc = this.dc;
    const chunk = Math.min(64 * 1024, this.pc.sctp?.maxMessageSize || 16 * 1024);
    this.setState('sending');
    dc.send(JSON.stringify({ t: 'meta', files: this.files.map((f) => ({ name: f.name, size: f.size, type: f.type })) }));
    let sent = 0;
    for (const [i, f] of this.files.entries()) {
      dc.send(JSON.stringify({ t: 'file', i }));
      for (let off = 0; off < f.size; off += chunk) {
        if (this.state !== 'sending') return;
        if (dc.bufferedAmount > HIGH_WATER) await new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
        const buf = await f.slice(off, off + chunk).arrayBuffer();
        dc.send(buf); sent += buf.byteLength;
        this.emit('progress', sent / this.total);
      }
      dc.send(JSON.stringify({ t: 'end', i }));
    }
    dc.send(JSON.stringify({ t: 'done' }));
    this.setState('confirming'); // "Delivered" only after the receiver acknowledges every byte
    this.timer = setTimeout(() => this.fail('no-ack'), 60_000);
  }
}

export class IncomingTransfer extends Transfer {
  constructor(hub, from, person, device, req) {
    super(hub, from);
    this.id = req.id; this.person = person; this.device = device; this.request = req;
    this.setState('asking');
  }
  decline() { this.signal({ kind: 'decline' }); this.setState('declined'); }
  accept() {
    this.setState('connecting');
    this.signal({ kind: 'accept' });
    this.timer = setTimeout(() => this.fail('no-direct-path'), CONNECT_TIMEOUT_MS + 3000);
  }
  async onSignal(d) {
    if (d.kind === 'cancel') return this.fail('cancelled-by-peer');
    if (d.kind === 'offer') {
      const pc = this.makePc();
      pc.ondatachannel = (e) => this.receive(e.channel);
      await pc.setRemoteDescription(d.sdp);
      await this.flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal({ kind: 'answer', sdp: pc.localDescription.toJSON() });
    } else if (d.kind === 'ice') await this.addIce(d.candidate);
  }
  receive(dc) {
    dc.binaryType = 'arraybuffer';
    let meta = null, current = -1, parts = [], got = 0, total = 0;
    const done = [];
    dc.onopen = () => { clearTimeout(this.timer); this.setState('receiving'); };
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        parts.push(e.data); got += e.data.byteLength;
        this.emit('progress', total ? got / total : 0);
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === 'meta') { meta = m.files; total = meta.reduce((n, f) => n + f.size, 0); }
      else if (m.t === 'file') { current = m.i; parts = []; }
      else if (m.t === 'end') {
        const f = meta[current];
        const blob = new Blob(parts, { type: f.type || 'application/octet-stream' });
        if (blob.size !== f.size) return this.fail('integrity');
        done.push(new File([blob], f.name, { type: f.type, lastModified: Date.now() }));
        parts = [];
      } else if (m.t === 'done') {
        if (done.length !== meta.length) return this.fail('integrity');
        dc.send(JSON.stringify({ t: 'ack', files: done.length, bytes: got }));
        this.files = done;
        this.setState('received', done);
        setTimeout(() => this.pc?.close(), 1000);
      }
    };
  }
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Device';
}
