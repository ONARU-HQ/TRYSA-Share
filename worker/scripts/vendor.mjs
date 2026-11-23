// Copies pinned browser libraries into public/share/vendor so the app never depends on a CDN at runtime.
import { copyFileSync, mkdirSync } from 'node:fs';
const out = new URL('../public/share/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js'],
  ['tus-js-client/dist/tus.min.js', 'tus.min.js'],
  ['qrcode-generator/qrcode.js', 'qrcode.js'],
]) copyFileSync(new URL(`../node_modules/${from}`, import.meta.url), new URL(to, out));
console.log('vendored');
