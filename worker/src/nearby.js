// TRYSA Nearby — discovery + signalling for direct phone-to-phone transfer.
//
// "Nearby" = signed-in TRYSA users on the same network (same public IPv4, or same IPv6 /64)
// who switched on Receiving for a limited time. The hub only exchanges presence and
// WebRTC signalling; file bytes go directly between the two devices over an encrypted
// (DTLS) WebRTC data channel. If no direct path works, the app falls back to TRYSA cloud.
//
// Honest limits: this is not Bluetooth/AWDL. Devices on different networks never see each
// other here, and a carrier NAT can put strangers on one public IP — which is why being
// discoverable is opt-in, time-limited, can be restricted to contacts, and every transfer
// still needs an explicit Accept.

import { sha256Hex } from './core.js';

export const DISCOVERABLE_MAX_MINUTES = 10;
const MAX_SIGNAL_BYTES = 96 * 1024;            // SDP / ICE / request metadata (+ small preview)
const MAX_REQUESTS_PER_MINUTE = 10;
const MODES = new Set(['off', 'contacts', 'everyone']);

/** Network room key: IPv4 address, or IPv6 /64 prefix. Salted + hashed — never stored raw. */
export async function roomKey(ip, salt = '') {
  if (!ip) return null;
  let net = ip;
  if (ip.includes(':')) {
    const full = expandIPv6(ip);
    if (!full) return null;
    net = full.slice(0, 4).join(':') + '::/64';
  }
  return (await sha256Hex(`nearby|${salt}|${net}`)).slice(0, 32);
}

function expandIPv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (!ip.includes('::') && h.length !== 8) return null;
  const fill = Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0').toLowerCase());
}

/** Is `peer` visible to `viewer` right now? */
export function isVisible(peer, viewer, now = Date.now()) {
  if (!peer || !viewer || peer.conn === viewer.conn) return false;
  if (peer.mode === 'off' || !peer.until || peer.until <= now) return false;
  if (peer.mode === 'everyone') return true;
  return peer.person.id === viewer.person.id || (peer.contacts || []).includes(viewer.person.id);
}

/**
 * Transport-independent hub. `send(connId, message)` delivers to one connection.
 * Connections: Map<connId, { conn, person, device, mode, until, contacts, requests: number[] }>
 */
export class NearbyHub {
  constructor(send, now = () => Date.now()) {
    this.send = send; this.now = now; this.conns = new Map();
  }

  join(conn, person, contacts = []) {
    this.conns.set(conn, { conn, person, contacts, device: 'Phone', mode: 'off', until: 0, requests: [] });
    this.send(conn, { type: 'welcome', conn });
    this.sendPeers(conn);
  }

  leave(conn) {
    if (!this.conns.delete(conn)) return;
    this.broadcastPeers();
  }

  peersFor(conn) {
    const viewer = this.conns.get(conn);
    if (!viewer) return [];
    const t = this.now();
    return [...this.conns.values()].filter((p) => isVisible(p, viewer, t))
      .map((p) => ({ conn: p.conn, person: p.person, device: p.device, until: p.until }));
  }

  sendPeers(conn) { this.send(conn, { type: 'peers', peers: this.peersFor(conn) }); }
  broadcastPeers() { for (const c of this.conns.keys()) this.sendPeers(c); }

  /** Handle one raw client message. Returns false if the connection should be closed. */
  message(conn, raw) {
    const me = this.conns.get(conn);
    if (!me) return false;
    if (typeof raw !== 'string' || raw.length > MAX_SIGNAL_BYTES) return this.error(conn, 'Message too large');
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.error(conn, 'Bad message'); }

    if (msg.type === 'presence') {
      if (!MODES.has(msg.mode)) return this.error(conn, 'Bad mode');
      const minutes = Math.min(DISCOVERABLE_MAX_MINUTES, Math.max(1, Number(msg.minutes) || DISCOVERABLE_MAX_MINUTES));
      me.mode = msg.mode;
      me.until = msg.mode === 'off' ? 0 : this.now() + minutes * 60000;
      if (typeof msg.device === 'string') me.device = msg.device.replace(/[^\w .'()-]/g, '').slice(0, 40) || 'Phone';
      this.send(conn, { type: 'presence', mode: me.mode, until: me.until });
      this.broadcastPeers();
      return true;
    }
    if (msg.type === 'peers') { this.sendPeers(conn); return true; }

    if (msg.type === 'signal') {
      const target = this.conns.get(msg.to);
      const data = msg.data;
      if (!target || !data || typeof data.kind !== 'string') return this.error(conn, 'That device is no longer available');
      // Opening a transfer requires the target to be discoverable to me. Replies (answers, ICE,
      // accept/decline) are allowed to whoever already contacted me.
      const opening = data.kind === 'request';
      if (opening) {
        if (!isVisible(target, me, this.now())) return this.error(conn, 'That device is no longer available');
        const t = this.now();
        me.requests = me.requests.filter((x) => t - x < 60000);
        if (me.requests.length >= MAX_REQUESTS_PER_MINUTE) return this.error(conn, 'Too many requests — wait a moment');
        me.requests.push(t);
        target.pendingFrom = new Set([...(target.pendingFrom || []), conn]);
        me.talkingTo = new Set([...(me.talkingTo || []), msg.to]);
      } else {
        const allowed = me.talkingTo?.has(msg.to) || me.pendingFrom?.has(msg.to);
        if (!allowed) return this.error(conn, 'Not connected to that device');
        if (data.kind === 'accept') me.talkingTo = new Set([...(me.talkingTo || []), msg.to]);
      }
      this.send(msg.to, { type: 'signal', from: conn, person: me.person, device: me.device, data });
      return true;
    }
    return this.error(conn, 'Unknown message');
  }

  error(conn, message) { this.send(conn, { type: 'error', message }); return true; }

  /** Expire discoverable windows; returns true if anything changed. */
  tick() {
    const t = this.now();
    let changed = false;
    for (const c of this.conns.values()) if (c.mode !== 'off' && c.until <= t) { c.mode = 'off'; c.until = 0; changed = true; this.send(c.conn, { type: 'presence', mode: 'off', until: 0 }); }
    if (changed) this.broadcastPeers();
    return changed;
  }
}

/**
 * Durable Object: one instance per network room. Uses WebSocket hibernation so idle
 * rooms cost nothing; hub state is rebuilt from socket attachments after wake-up.
 */
export class NearbyRoom {
  constructor(state) {
    this.state = state;
    this.hub = new NearbyHub((conn, msg) => {
      const ws = this.state.getWebSockets(conn)[0];
      try { ws?.send(JSON.stringify(msg)); } catch { /* socket closing */ }
    });
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) this.hub.conns.set(a.conn, { ...a, requests: [], pendingFrom: new Set(a.pendingFrom || []), talkingTo: new Set(a.talkingTo || []) });
    }
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const person = JSON.parse(request.headers.get('x-trysa-person'));
    const contacts = JSON.parse(request.headers.get('x-trysa-contacts') || '[]');
    const conn = crypto.randomUUID();
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [conn]);
    pair[1].serializeAttachment({ conn, person, contacts, device: 'Phone', mode: 'off', until: 0 });
    this.hub.join(conn, person, contacts);
    await this.state.storage.setAlarm(Date.now() + 30000);
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': 'trysa' } });
  }

  persist(conn) {
    const c = this.hub.conns.get(conn);
    const ws = this.state.getWebSockets(conn)[0];
    if (c && ws) ws.serializeAttachment({ conn: c.conn, person: c.person, contacts: c.contacts, device: c.device, mode: c.mode, until: c.until,
      pendingFrom: [...(c.pendingFrom || [])], talkingTo: [...(c.talkingTo || [])] });
  }

  webSocketMessage(ws, raw) {
    const [conn] = this.state.getTags(ws);
    if (!this.hub.message(conn, typeof raw === 'string' ? raw : '')) ws.close(1008, 'policy');
    // Persist every socket's state so a request survives hibernation while the receiver decides.
    for (const c of this.hub.conns.keys()) this.persist(c);
  }
  webSocketClose(ws) { const [conn] = this.state.getTags(ws); this.hub.leave(conn); }
  webSocketError(ws) { const [conn] = this.state.getTags(ws); this.hub.leave(conn); }
  async alarm() {
    this.hub.tick();
    for (const conn of this.hub.conns.keys()) this.persist(conn);
    if (this.hub.conns.size) await this.state.storage.setAlarm(Date.now() + 30000);
  }
}
