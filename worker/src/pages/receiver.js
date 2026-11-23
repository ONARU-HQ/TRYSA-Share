// Public receiver page for https://link.trysa.app/s/:code
// No account, no install, no blanket permissions. Nothing downloads until Accept.

const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function receiverPage({ nonce, state }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0f172a">
<title>TRYSA Share</title>
<style nonce="${nonce}">
:root{--bg:#f4f6fb;--card:#fff;--ink:#0f172a;--muted:#5b6578;--line:#e3e8f0;--brand:#1d3f8f;--brand-ink:#fff;--ok:#0f7b4f;--warn:#a1460b;--soft:#eef2fb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141a2e;--ink:#eef2ff;--muted:#9aa5bd;--line:#26304a;--brand:#7aa2ff;--brand-ink:#0b1020;--ok:#4cd39a;--warn:#ffb070;--soft:#1b2440}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
.brand{font-weight:800;letter-spacing:.04em;font-size:14px;color:var(--muted);margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px}
h1{font-size:22px;margin:0 0 4px;line-height:1.25}.muted{color:var(--muted);font-size:14px}
.stats{display:flex;gap:10px;margin:18px 0}.stat{flex:1;background:var(--soft);border-radius:14px;padding:12px}.stat b{display:block;font-size:18px}
button,.btn{display:block;width:100%;border:0;border-radius:14px;padding:15px;font:inherit;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
.primary{background:var(--brand);color:var(--brand-ink)}.ghost{background:transparent;color:var(--muted);margin-top:8px}
button:disabled{opacity:.6;cursor:default}
input{width:100%;font:inherit;font-size:20px;letter-spacing:.3em;text-align:center;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);margin:6px 0 14px}
ul{list-style:none;padding:0;margin:16px 0 0}li{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
li .n{flex:1;min-width:0}li .n div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
li a{flex:none;padding:9px 14px;border-radius:10px;background:var(--soft);color:var(--brand);font-weight:700;text-decoration:none;font-size:14px}
.gap{margin-top:16px}.msg{margin-top:14px;font-size:14px;min-height:1.4em}.msg.err{color:var(--warn)}.msg.ok{color:var(--ok)}
.notice{font-size:13px;color:var(--muted);margin-top:18px;line-height:1.5}
</style></head>
<body><main>
<div class="brand">TRYSA&nbsp;SHARE</div>
<div class="card" id="app" aria-live="polite"></div>
<p class="notice">Files are shared privately and expire automatically. TRYSA never accesses your photos or files. Only accept files from people you trust.</p>
</main>
<script nonce="${nonce}">
const S=${safeJson(state)};
const app=document.getElementById('app');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>{const u=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<3){n/=1024;i++}return (n>=10||i===0?Math.round(n):n.toFixed(1))+' '+u[i]};
const left=()=>{const m=Math.max(0,Math.round((Date.parse(S.expires_at)-Date.now())/60000));return m>=120?Math.round(m/60)+' hours':m+' min'};
function closed(title,body){app.innerHTML='<h1>'+esc(title)+'</h1><p class="muted">'+esc(body)+'</p>'}
function render(){
  switch(S.availability){
    case 'not_found':return closed('Share not found','Check the QR code or ask the sender to share again.');
    case 'expired':return closed('This share has expired','Ask the sender to create a new QR.');
    case 'revoked':return closed('Share cancelled','The sender cancelled this share.');
    case 'full':return closed('Already received','This share has reached its receiver limit.');
    case 'preparing':return closed('Almost ready…','The sender is still uploading. This page will refresh.'),setTimeout(()=>location.reload(),4000);
    case 'unavailable':return closed('Share unavailable','Ask the sender to try again.');
    case 'declined':return closed('Declined','No files were downloaded. You can close this page.');
    case 'accepted':return files();
  }
  app.innerHTML='<h1>'+esc(S.sender)+' wants to share '+S.count+' file'+(S.count===1?'':'s')+' with you</h1>'+
   '<p class="muted">'+esc(S.kinds)+'</p>'+
   '<div class="stats"><div class="stat"><b>'+S.count+'</b><span class="muted">files</span></div><div class="stat"><b>'+size(S.total_bytes)+'</b><span class="muted">total</span></div><div class="stat"><b>'+left()+'</b><span class="muted">left</span></div></div>'+
   (S.pin_required?'<label class="muted" for="pin">Enter the PIN from the sender</label><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="8">':'')+
   '<button class="primary" id="accept">Accept &amp; view files</button><button class="ghost" id="decline">Decline</button><div class="msg" id="msg"></div>';
  document.getElementById('accept').onclick=accept;
  document.getElementById('decline').onclick=async()=>{await fetch(location.pathname.replace(/\\/$/,'')+'/decline',{method:'POST'}).catch(()=>{});S.availability='declined';render()};
}
async function accept(){
  const b=document.getElementById('accept'),msg=document.getElementById('msg');b.disabled=true;msg.className='msg';msg.textContent='Checking…';
  try{
    const pin=document.getElementById('pin');
    const r=await fetch(location.pathname.replace(/\\/$/,'')+'/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin?pin.value:undefined}),credentials:'same-origin'});
    const j=await r.json();if(!r.ok)throw Error(j.error||'Could not accept');
    S.files=j.files;S.availability='accepted';render();
  }catch(e){msg.className='msg err';msg.textContent=e.message;b.disabled=false}
}
function files(){
  const f=S.files||[];
  app.innerHTML='<h1>Files from '+esc(S.sender)+'</h1><p class="muted">'+f.length+' file'+(f.length===1?'':'s')+' · available for '+left()+'</p><ul>'+
   f.map(x=>'<li><div class="n"><div>'+esc(x.name)+'</div><span class="muted">'+size(x.size)+'</span></div><a href="'+esc(x.url)+'" download>Download</a></li>').join('')+'</ul>'+
   (f.length>1?'<button class="primary gap" id="all">Download all</button>':'')+
   '<p class="notice">iPhone: after downloading, open the file and tap Share → Save Image / Save to Files. Android: files go to Downloads; open Photos or Files to view.</p>';
  const all=document.getElementById('all');
  if(all)all.onclick=async()=>{all.disabled=true;for(const x of f){const a=document.createElement('a');a.href=x.url;a.download='';document.body.appendChild(a);a.click();a.remove();await new Promise(r=>setTimeout(r,900))}all.disabled=false};
}
render();
</script></body></html>`;
}
