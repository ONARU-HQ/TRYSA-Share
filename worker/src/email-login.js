// Email sign-in links for TRYSA Share, sent through Resend.
// Supabase's admin generate_link creates the one-time token WITHOUT sending any email, so the
// project's custom "send email" hook is never involved. We email our own link that carries only
// the token hash; the app exchanges it with supabase.auth.verifyOtp({ token_hash, type }).
import { sha256Hex } from './core.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const LOGIN_LIMITS = { perEmailPerHour: 3, perIpPerHour: 10 };

export function signInEmail({ link, appName = 'TRYSA Share' }) {
  const safe = link.replace(/"/g, '&quot;');
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:440px;background:#fff;border-radius:28px;padding:32px" cellpadding="0" cellspacing="0"><tr><td align="center">
<div style="font-size:12px;letter-spacing:.14em;font-weight:700;color:#8a8a92">TRYSA</div>
<h1 style="font-size:24px;margin:8px 0 6px;letter-spacing:-.02em">Sign in to ${appName}</h1>
<p style="color:#5b6578;font-size:15px;line-height:1.5;margin:0 0 24px">Tap the button to sign in. This link works once and expires in 1 hour.</p>
<a href="${safe}" style="display:inline-block;background:#1c1c1e;color:#fff;text-decoration:none;font-weight:600;padding:14px 28px;border-radius:16px">Sign in</a>
<p style="color:#8a8a92;font-size:12px;line-height:1.5;margin:24px 0 0">If you didn't ask for this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Sign in to ${appName}\n\nOpen this link to sign in (works once, expires in 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`;
  return { subject: `Your ${appName} sign-in link`, html, text };
}

/**
 * Always resolves to the same public answer (never reveals whether an account exists).
 * @returns {{ status: number, body: object }}
 */
export async function requestEmailLink({ db, env, email, ip, base, fetchImpl = fetch, now = Date.now() }) {
  const ok = { status: 200, body: { sent: true, message: 'If that email has a TRYSA account, a sign-in link is on its way.' } };
  const addr = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(addr)) return { status: 400, body: { error: 'Enter a valid email address' } };
  if (!env.RESEND_API_KEY) return { status: 503, body: { error: 'Email sign-in is not available. Use Google or your password.' } };

  const emailHash = await sha256Hex(`login|${addr}`);
  const ipHash = await sha256Hex(`login-ip|${ip || ''}`);
  const since = new Date(now - 3600_000).toISOString();
  const [byEmail, byIp] = await Promise.all([
    db.select('trysa_share_login_requests', { email_hash: `eq.${emailHash}`, created_at: `gt.${since}`, select: 'id' }),
    db.select('trysa_share_login_requests', { ip_hash: `eq.${ipHash}`, created_at: `gt.${since}`, select: 'id' }),
  ]);
  if (byEmail.length >= LOGIN_LIMITS.perEmailPerHour || byIp.length >= LOGIN_LIMITS.perIpPerHour) {
    return { status: 429, body: { error: 'Too many sign-in emails. Try again in a little while, or use Google.' } };
  }
  await db.insert('trysa_share_login_requests', [{ email_hash: emailHash, ip_hash: ipHash }]);

  // Only existing TRYSA accounts get a link — no accounts are created here.
  const profile = await db.one('profiles', { email: `ilike.${addr.replace(/[%*,()]/g, '')}`, select: 'id' });
  if (!profile) return ok;

  const tokenHash = await db.generateMagicLinkHash(addr);
  if (!tokenHash) return ok;
  const link = `${base}/share/?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`;
  const { subject, html, text } = signInEmail({ link });
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.LOGIN_EMAIL_FROM || 'TRYSA Share <share@trysa.app>', to: [addr], subject, html, text }),
  });
  if (!res.ok) {
    console.error('resend failed', res.status, await res.text().catch(() => ''));
    return { status: 502, body: { error: 'Could not send the email right now. Try Google or your password.' } };
  }
  return ok;
}
