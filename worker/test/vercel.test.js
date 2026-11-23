import test from 'node:test';
import assert from 'node:assert/strict';
import { originalRequest } from '../api/handler.js';

test('Vercel rewrite restores the original path and keeps the body', async () => {
  const r = originalRequest(new Request('https://x.vercel.app/api/handler?__p=/s/ABCDEF2345/accept', { method: 'POST', body: '{"pin":"1"}' }));
  assert.equal(new URL(r.url).pathname, '/s/ABCDEF2345/accept');
  assert.equal(new URL(r.url).search, '');
  assert.equal(await r.text(), '{"pin":"1"}');
  const g = originalRequest(new Request('https://x.vercel.app/api/handler?__p=/api/share/v1/config'));
  assert.equal(new URL(g.url).pathname, '/api/share/v1/config');
});
