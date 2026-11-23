import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randomCode, CODE_RE, validateCreate, ValidationError, canTransition, canTransitionReceipt,
  publicAvailability, hashPin, verifyPin, sanitizeFileName, contentDisposition, kindSummary, isReceivable,
} from '../src/core.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const file = (o = {}) => ({ name: 'IMG_0001.HEIC', size: 2048, type: 'image/heic', ...o });

test('short codes are unambiguous, uniform length and match the DB constraint', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = randomCode();
    assert.match(c, CODE_RE);
    assert.equal(c.length, 10);
    assert.doesNotMatch(c, /[01OIL]/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test('QR create defaults: 30 min expiry, 1 receiver (PRD §10)', () => {
  const v = validateCreate({ mode: 'qr', files: [file()] }, SENDER);
  assert.equal(v.expiryMinutes, 30);
  assert.equal(v.maxReceivers, 1);
  assert.equal(v.name, 'IMG_0001.HEIC');
});

test('remote create requires a different, valid recipient and forces one receiver', () => {
  assert.throws(() => validateCreate({ mode: 'remote', files: [file()] }, SENDER), ValidationError);
  assert.throws(() => validateCreate({ mode: 'remote', recipient_user_id: SENDER, files: [file()] }, SENDER), /yourself/);
  const v = validateCreate({ mode: 'remote', recipient_user_id: OTHER, max_receivers: 9, files: [file()] }, SENDER);
  assert.equal(v.maxReceivers, 1);
  assert.equal(v.expiryMinutes, 1440);
});

test('file validation rejects bad sizes, names, totals and PINs', () => {
  assert.throws(() => validateCreate({ mode: 'qr', files: [] }, SENDER));
  assert.throws(() => validateCreate({ mode: 'qr', files: [file({ size: 0 })] }, SENDER));
  assert.throws(() => validateCreate({ mode: 'qr', files: [file({ size: 2 ** 30 + 1 })] }, SENDER));
  assert.throws(() => validateCreate({ mode: 'qr', files: [file({ name: '..' })] }, SENDER));
  assert.throws(() => validateCreate({ mode: 'qr', files: [file({ size: 2 ** 30 }), file({ size: 2 ** 30 }), file()] }, SENDER), /2 GB/);
  assert.throws(() => validateCreate({ mode: 'qr', pin: '12', files: [file()] }, SENDER), /PIN/);
  assert.throws(() => validateCreate({ mode: 'qr', max_receivers: 21, files: [file()] }, SENDER));
  assert.throws(() => validateCreate({ mode: 'qr', expires_minutes: 1, files: [file()] }, SENDER));
  assert.equal(validateCreate({ mode: 'qr', pin: '4821', files: [file()] }, SENDER).pin, '4821');
});

test('filenames are preserved but path separators and control chars are neutralised', () => {
  assert.equal(sanitizeFileName('Café menu.pdf'), 'Café menu.pdf');
  assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFileName('a\u0000b'), 'a_b');
  assert.equal(sanitizeFileName('   '), null);
});

test('content-disposition is safe for unicode and quotes', () => {
  const h = contentDisposition('Ada "best" 📸.jpg');
  assert.match(h, /^attachment; filename="Ada _best_ __\.jpg"; filename\*=UTF-8''/);
  assert.ok(h.includes(encodeURIComponent('📸')));
});

test('session state machine follows PRD §9 and terminal states are final', () => {
  for (const [a, b] of [['draft', 'uploading'], ['uploading', 'ready'], ['ready', 'claimed'], ['claimed', 'transferring'], ['transferring', 'completed']])
    assert.ok(canTransition(a, b), `${a}→${b}`);
  for (const s of ['expired', 'revoked', 'failed']) assert.equal(canTransition(s, 'ready'), false);
  assert.equal(canTransition('ready', 'completed'), false);
  assert.equal(canTransition('uploading', 'claimed'), false);
});

test('receipt state machine: declined is final, downloaded never regresses to accepted', () => {
  assert.ok(canTransitionReceipt('requested', 'accepted'));
  assert.ok(canTransitionReceipt('requested', 'declined'));
  assert.equal(canTransitionReceipt('declined', 'accepted'), false);
  assert.equal(canTransitionReceipt('downloaded', 'accepted'), false);
});

test('public availability never exposes a preparing or expired share as available', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const s = (o) => ({ status: 'ready', max_receivers: 1, expires_at: '2026-11-23T12:30:00Z', ...o });
  assert.equal(publicAvailability(s(), 0, now), 'available');
  assert.equal(publicAvailability(s(), 1, now), 'full');
  assert.equal(publicAvailability(s({ status: 'uploading' }), 0, now), 'preparing');
  assert.equal(publicAvailability(s({ expires_at: '2026-11-23T11:59:59Z' }), 0, now), 'expired');
  assert.equal(publicAvailability(s({ status: 'revoked' }), 0, now), 'revoked');
  assert.equal(isReceivable(s({ status: 'uploading' }), now), false);
});

test('PIN hashing verifies correct PINs only', async () => {
  const h = await hashPin('4821');
  assert.ok(await verifyPin('4821', h));
  assert.equal(await verifyPin('4822', h), false);
  assert.equal(await verifyPin(undefined, h), false);
  assert.notEqual(h, await hashPin('4821')); // per-session salt
});

test('pre-accept kind summary reveals types, not names', () => {
  const s = kindSummary([{ mime_type: 'image/jpeg' }, { mime_type: 'image/png' }, { mime_type: 'application/pdf' }, { mime_type: 'video/mp4' }]);
  assert.equal(s, '2 photos, 1 video, 1 document');
});
