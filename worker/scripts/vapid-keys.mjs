// Generates a VAPID key pair for Web Push. Run once:  node scripts/vapid-keys.mjs
// Put the public key in wrangler.toml (VAPID_PUBLIC_KEY) and the private key in a secret:
//   npx wrangler secret put VAPID_PRIVATE_KEY
const b64url = (b) => Buffer.from(b).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
console.log('VAPID_PUBLIC_KEY =', b64url(await crypto.subtle.exportKey('raw', kp.publicKey)));
console.log('VAPID_PRIVATE_KEY =', (await crypto.subtle.exportKey('jwk', kp.privateKey)).d);
