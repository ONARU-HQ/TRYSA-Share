// End-to-end run: real Worker runtime (wrangler dev / workerd) + Durable Object + mock Supabase,
// driven by Playwright with two emulated phones and one anonymous browser.
//   node e2e/run.mjs [outDir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startMockSupabase, USERS } from './mock-supabase.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = createRequire('/opt/node-tools/node_modules/')('playwright'); }
const { chromium, devices } = playwright;

const OUT = process.argv[2] || new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8787';
const FIX = (n) => decodeURIComponent(new URL(`./fixtures/${encodeURIComponent(n)}`, import.meta.url).pathname);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { server } = await startMockSupabase(54321);
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1',
  '--var', 'SUPABASE_URL:http://127.0.0.1:54321', '--var', 'SUPABASE_PUBLISHABLE_KEY:dev-anon',
  '--var', `PUBLIC_BASE_URL:${BASE}`, '--var', `ALLOWED_ORIGINS:${BASE}`], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
wrangler.stdout.on('data', (d) => { log += d; }); wrangler.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 120 && !/Ready on/.test(log); i++) await sleep(500);
if (!/Ready on/.test(log)) { console.error(log); process.exit(1); }

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream'] });
async function phone(tok, { dark = false } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
  const user = USERS[tok];
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: t, refresh_token: 'dev', token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email, aud: 'authenticated' } }));
  }, [tok, user]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${tok}] page error:`, e.message));
  await page.goto(`${BASE}/share/`);
  await page.waitForSelector('#home:not([hidden])');
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

try {
  const sam = await phone('tok-sam');
  const ada = await phone('tok-ada');
  await shot(sam, '01-home');

  // ---------------------------------------------------------------- Nearby (direct WebRTC)
  await ada.click('#receivingBtn');
  await ada.click('#recvModes [data-mode="everyone"]');
  await sleep(300);
  await shot(ada, '02-receiving-sheet');
  await ada.click('#recvDone');
  await sam.waitForSelector('#nearbyRow .mini-card', { timeout: 8000 });
  check('Ada appears in Sam\'s Nearby after turning Receiving on', true);
  await shot(sam, '03-home-nearby');

  const photos = ['IMG_2041.jpg', 'IMG_2042.jpg', 'IMG_2043.jpg'];
  await sam.setInputFiles('#files', photos.map(FIX));
  await sam.waitForSelector('#sheetBackdrop:not([hidden])');
  await sleep(500);
  check('Share sheet title', (await sam.textContent('#sheetTitle')) === '3 Photos Selected', await sam.textContent('#sheetTitle'));
  await shot(sam, '04-share-sheet');

  await sam.click('#destPeople .dest-person');
  await sam.waitForSelector('#personOverlay:not([hidden])');
  await sleep(600);
  await shot(sam, '05-person-card-waiting');

  await ada.waitForSelector('#alertOverlay:not([hidden])', { timeout: 8000 });
  check('Incoming alert text', /Samson would like to share 3 photos\./.test(await ada.textContent('#alertMsg')), await ada.textContent('#alertMsg'));
  check('Incoming alert has a preview', await ada.isVisible('#alertPreview'));
  await sleep(300);
  await shot(ada, '06-incoming-alert');

  await ada.click('#alertAccept');
  await ada.waitForSelector('#receivedBackdrop:not([hidden])', { timeout: 20000 });
  await sam.waitForFunction(() => document.getElementById('pcStatusText').textContent === 'Delivered', null, { timeout: 15000 });
  check('Sender sees "Delivered" only after receiver acknowledged', true);
  await sleep(400);
  await shot(ada, '07-received');
  await shot(sam, '08-person-card-delivered');

  const downloads = [];
  ada.on('download', (d) => downloads.push(d));
  await ada.click('#saveFiles');
  for (let i = 0; i < 40 && downloads.length < 3; i++) await sleep(250);
  let same = downloads.length === 3;
  for (const d of downloads) {
    const name = d.suggestedFilename();
    same = same && sha(readFileSync(await d.path())) === sha(readFileSync(FIX(name)));
  }
  check('Nearby: 3 photos received byte-identical over WebRTC', same, `${downloads.length} files`);
  await ada.click('#receivedDone');
  await sam.click('#pcAction'); // "Add person" → back to sheet
  await sam.click('#sheetClose');

  // ---------------------------------------------------------------- QR + browser receiver
  await sam.setInputFiles('#files', photos.slice(0, 2).map(FIX));
  await sam.click('#optionsBtn'); await sam.check('#optPreview'); await sleep(200);
  await shot(sam, '09-options');
  await sam.click('#optionsDone');
  await sam.click('#destQr');
  await sam.waitForSelector('.qr-box svg', { timeout: 15000 });
  await sleep(400);
  await shot(sam, '10-qr-card');
  const shareUrl = await sam.evaluate(() => {
    // read the URL the app copied / encoded: ask the API for latest sent transfer
    return fetch('/api/share/v1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-sam' }, body: JSON.stringify({ action: 'sent' }) })
      .then((r) => r.json()).then((j) => j.transfers[0].share_url);
  });
  const anonCtx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const anon = await anonCtx.newPage();
  await anon.goto(shareUrl);
  await anon.waitForSelector('.alert');
  check('Browser receiver sees request', /Samson Adeyemi would like to share 2 photos\./.test(await anon.textContent('.alert')), shareUrl);
  await sleep(400);
  await shot(anon, '11-browser-receiver-alert');
  await anon.click('#accept');
  await anon.waitForSelector('.files');
  await sleep(300);
  await shot(anon, '12-browser-receiver-files');
  const [zipDl] = await Promise.all([anon.waitForEvent('download'), anon.click('a[href$="/zip"]')]);
  const zipBytes = readFileSync(await zipDl.path());
  check('Browser "Download all" ZIP is a valid archive', zipBytes.subarray(0, 4).toString('hex') === '504b0304', `${zipBytes.length} bytes`);
  await sam.waitForFunction(() => document.getElementById('pcStatusText').textContent === 'Delivered', null, { timeout: 12000 });
  check('QR sender sees Delivered after the browser download completes', true);
  await shot(sam, '13-qr-delivered');
  await sam.click('#pcSecondary').catch(() => {});
  await sam.evaluate(() => document.getElementById('personOverlay').hidden = true);

  // ---------------------------------------------------------------- Contacts (remote, via cloud)
  await sam.setInputFiles('#files', [FIX('Contract v3.pdf'), FIX('IMG_2043.jpg')]);
  await sam.click('#destContacts');
  await sam.waitForSelector('#contactList .row');
  await sam.fill('#contactSearch', 'ad'); await sleep(700);
  await shot(sam, '14-contacts');
  await sam.click('#contactList .row');
  await sam.waitForFunction(() => /Waiting for Ada/.test(document.getElementById('pcStatusText').textContent), null, { timeout: 15000 });
  await shot(sam, '15-contact-card-waiting');

  const adaDark = await phone('tok-ada', { dark: true });
  await adaDark.waitForSelector('#alertOverlay:not([hidden])', { timeout: 10000 });
  check('Remote request appears as Accept/Decline alert', /Samson would like to share 2 items\./.test(await adaDark.textContent('#alertMsg')), await adaDark.textContent('#alertMsg'));
  await sleep(500);
  await shot(adaDark, '16-remote-alert-dark');
  await adaDark.click('#alertAccept');
  await adaDark.waitForSelector('#receivedBackdrop:not([hidden])', { timeout: 15000 });
  await sleep(300);
  await shot(adaDark, '17-remote-received-dark');
  await sam.waitForFunction(() => document.getElementById('pcStatusText').textContent === 'Delivered', null, { timeout: 15000 });
  check('Remote sender sees Delivered', true);
  await adaDark.click('#receivedDone');
  await adaDark.click('[data-tab="inbox"]');
  await shot(adaDark, '18-inbox-dark');
} catch (e) {
  check('E2E run', false, e.message);
  console.log(log.split('\n').slice(-30).join('\n'));
} finally {
  await browser.close();
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* already gone */ }
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
}
