// Streaming "store" (no compression) ZIP writer. Photos and videos are already
// compressed, so storing keeps CPU low and lets us compute Content-Length up front.
// Uses data descriptors (bit 3) so CRC-32 is computed while bytes stream through.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const LOCAL = 30, DESC = 16, CENTRAL = 46, END = 22;
export const ZIP_MAX_BYTES = 0xfffffffe; // no ZIP64; TRYSA transfers are capped at 2 GiB

function dosTime(date) {
  const d = new Date(date);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const day = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

/** Make names unique inside the archive: "IMG.jpg", "IMG (2).jpg". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}

/** Exact archive size for the given entries, for Content-Length and progress bars. */
export function zipLength(entries) {
  let total = END;
  for (const e of entries) {
    const n = enc.encode(e.name).length;
    total += LOCAL + n + e.size + DESC + CENTRAL + n;
  }
  return total;
}

/**
 * @param entries [{ name, size, mtime }]
 * @param open (entry, index) => Promise<ReadableStream<Uint8Array>>
 * @param onEntryDone (entry, index) => void  called after an entry's bytes were fully written
 */
export function zipStream(entries, open, onEntryDone = () => {}) {
  const names = uniqueNames(entries.map((e) => e.name));
  const items = entries.map((e, i) => ({ ...e, name: names[i], nameBytes: enc.encode(names[i]), ...dosTime(e.mtime || Date.now()) }));
  const length = zipLength(items);
  if (length > ZIP_MAX_BYTES) throw new Error('Archive too large for ZIP without ZIP64');

  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    let offset = 0;
    const write = async (bytes) => { await w.write(bytes); offset += bytes.length; };
    try {
      for (const [i, it] of items.entries()) {
        it.offset = offset;
        const h = new DataView(new ArrayBuffer(LOCAL));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0808, true); // bit3 + UTF-8
        h.setUint16(8, 0, true); h.setUint16(10, it.time, true); h.setUint16(12, it.day, true);
        h.setUint16(26, it.nameBytes.length, true);
        await write(new Uint8Array(h.buffer)); await write(it.nameBytes);

        let crc = 0, size = 0;
        const reader = (await open(it, i)).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32Update(crc, value); size += value.length;
          await write(value);
        }
        if (size !== it.size) throw new Error(`Size mismatch for ${it.name}`);
        it.crc = crc;
        const d = new DataView(new ArrayBuffer(DESC));
        d.setUint32(0, 0x08074b50, true); d.setUint32(4, crc, true); d.setUint32(8, size, true); d.setUint32(12, size, true);
        await write(new Uint8Array(d.buffer));
        await onEntryDone(entries[i], i);
      }
      const cdStart = offset;
      for (const it of items) {
        const c = new DataView(new ArrayBuffer(CENTRAL));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0808, true);
        c.setUint16(10, 0, true); c.setUint16(12, it.time, true); c.setUint16(14, it.day, true);
        c.setUint32(16, it.crc, true); c.setUint32(20, it.size, true); c.setUint32(24, it.size, true);
        c.setUint16(28, it.nameBytes.length, true); c.setUint32(42, it.offset, true);
        await write(new Uint8Array(c.buffer)); await write(it.nameBytes);
      }
      const e = new DataView(new ArrayBuffer(END));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true); e.setUint16(10, items.length, true);
      e.setUint32(12, offset - cdStart, true); e.setUint32(16, cdStart, true);
      await write(new Uint8Array(e.buffer));
      await w.close();
    } catch (err) {
      await w.abort(err).catch(() => {});
    }
  })();
  return { stream: readable, length };
}
