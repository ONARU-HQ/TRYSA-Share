import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipStream, zipLength, crc32Update, uniqueNames } from '../src/zip.js';
import { detect, checkContent } from '../src/sniff.js';

const bytes = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 255; return b; };
const streamOf = (b, chunk = 1000) => new ReadableStream({ start(c) { for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close(); } });

test('crc32 matches the reference value', () => {
  assert.equal(crc32Update(0, new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('duplicate names are made unique', () => {
  assert.deepEqual(uniqueNames(['a.jpg', 'A.jpg', 'a.jpg', 'b']), ['a.jpg', 'A (2).jpg', 'a (3).jpg', 'b']);
});

test('streamed ZIP is valid, exact-length and preserves UTF-8 names and bytes', async () => {
  const files = [
    { name: 'IMG_0001.jpg', data: bytes(5000, 1) },
    { name: 'Café — menu.pdf', data: bytes(1234, 2) },
    { name: 'IMG_0001.jpg', data: bytes(1, 3) },
  ];
  const entries = files.map((f) => ({ name: f.name, size: f.data.length, mtime: Date.parse('2026-11-23T10:00:00Z') }));
  const done = [];
  const { stream, length } = zipStream(entries, (_e, i) => streamOf(files[i].data), (_e, i) => done.push(i));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.equal(out.length, length);
  assert.equal(length, zipLength(entries.map((e, i) => ({ ...e, name: uniqueNames(files.map((f) => f.name))[i] }))));
  assert.deepEqual(done, [0, 1, 2]);

  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(dir, 'a.zip'), out);
  const listing = execFileSync('python3', ['-I', '-c', `
import zipfile,sys,hashlib
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for i in z.infolist(): print(i.filename, i.file_size, hashlib.sha256(z.read(i)).hexdigest()[:12])
`, join(dir, 'a.zip')]).toString().trim().split('\n');
  assert.equal(listing.length, 3);
  assert.ok(listing[1].startsWith('Café — menu.pdf 1234'));
  assert.ok(listing[2].startsWith('IMG_0001 (2).jpg 1'));
});

test('ZIP aborts (never silently truncates) when a source is shorter than declared', async () => {
  const { stream } = zipStream([{ name: 'x', size: 10 }], () => streamOf(bytes(5, 1)));
  await assert.rejects(new Response(stream).arrayBuffer());
});

test('magic-byte detection', () => {
  const ftyp = (brand) => new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftyp' + brand)]);
  assert.equal(detect(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detect(ftyp('heic')), 'image/heic');
  assert.equal(detect(ftyp('qt  ')), 'video/quicktime');
  assert.equal(detect(new TextEncoder().encode('%PDF-1.7')), 'application/pdf');
  assert.equal(detect(new Uint8Array([0x4d, 0x5a, 0x90, 0])), 'executable/pe');
});

test('content checks block executables and mislabeled media, allow unknown formats', () => {
  const exe = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]);
  assert.equal(checkContent('image/jpeg', exe).ok, false);
  assert.equal(checkContent('application/octet-stream', exe).ok, false);
  assert.equal(checkContent('image/jpeg', new TextEncoder().encode('%PDF-1.7')).ok, false);
  assert.equal(checkContent('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe1])).ok, true);
  assert.equal(checkContent('image/x-canon-cr2', new Uint8Array([0x49, 0x49, 0x2a, 0])).ok, true);
  assert.equal(checkContent('text/plain', new TextEncoder().encode('hello')).ok, true);
});
