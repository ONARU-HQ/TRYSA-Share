// Public receiver page for https://link.trysa.app/s/:code
// No account, no install, no blanket permissions. Nothing downloads until Accept.
// Visual: a system-style "would like to share" alert over the (optional) preview.

const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function receiverPage({ nonce, state }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">
<title>TRYSA Share</title>
<style nonce="${nonce}">
:root{--bg:#c9c9ce;--ink:#111114;--muted:#6e6e76;--accent:#0a6cff;--alert:rgba(242,242,247,.88);--line:rgba(60,60,67,.24);--surface:#fff;--soft:#efeff4;--pill:#1c1c1e;--pill-ink:#fff;--warn:#d9480f}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--ink:#f5f5f7;--muted:#8e8e93;--accent:#3b8cff;--alert:rgba(44,44,46,.88);--line:rgba(255,255,255,.16);--surface:#1c1c1e;--soft:#2c2c2e;--pill:#f5f5f7;--pill-ink:#111;--warn:#ffb070}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font:16px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.backdrop{position:fixed;inset:-40px;background:center/cover no-repeat;filter:blur(28px) brightness(.7);transform:scale(1.1)}
main{position:relative;min-height:100vh;display:grid;place-items:center;align-content:center;gap:18px;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
.alert{width:min(300px,88vw);border-radius:16px;overflow:hidden;background:var(--alert);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.28);animation:pop .3s ease}
@keyframes pop{from{transform:scale(.94);opacity:0}}
.text{padding:19px 16px 15px}h1{margin:0 0 4px;font-size:17px;font-weight:600}p{margin:0;font-size:14px}
.preview img{display:block;width:100%;max-height:52vh;object-fit:cover}
.pin{padding:0 16px 14px}.pin input{width:100%;font:inherit;font-size:20px;letter-spacing:.35em;text-align:center;padding:9px;border-radius:10px;border:.5px solid var(--line);background:var(--surface);color:var(--ink)}
.actions{display:grid;grid-template-columns:1fr 1fr;border-top:.5px solid var(--line)}.actions.single{grid-template-columns:1fr}
.actions button{font:inherit;font-size:17px;color:var(--accent);background:none;border:0;padding:13px 8px;cursor:pointer}
.actions button+button{border-left:.5px solid var(--line)}.actions .strong{font-weight:600}.actions button:disabled{opacity:.45}
.meta{color:#fff;font-size:13px;text-align:center;text-shadow:0 1px 8px rgba(0,0,0,.35);opacity:.92;max-width:320px;line-height:1.5}
.plain .meta{color:var(--muted);text-shadow:none}
.err{color:var(--warn);font-size:13px;padding:0 16px 12px}
.files{width:min(440px,100%);background:var(--surface);border-radius:30px;padding:22px 18px;box-shadow:0 30px 70px rgba(0,0,0,.18);animation:pop .3s ease}
.files h2{margin:0 0 2px;font-size:22px;letter-spacing:-.02em}.files .sub{color:var(--muted);font-size:14px;margin-bottom:12px}
ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:.5px solid var(--line)}
.thumb{flex:none;width:44px;height:44px;border-radius:12px;background:var(--soft);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--accent)}
.n{flex:1;min-width:0}.n b{display:block;font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.n small{color:var(--muted)}
li a{flex:none;padding:8px 14px;border-radius:12px;background:var(--soft);color:var(--ink);font-weight:600;font-size:14px;text-decoration:none}
.btns{display:grid;gap:10px;margin-top:16px}
.pill{display:block;text-align:center;border:0;border-radius:16px;padding:15px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;background:var(--pill);color:var(--pill-ink)}
.pill.ghost{background:var(--soft);color:var(--ink)}
.note{color:var(--muted);font-size:12px;margin:14px 2px 0;line-height:1.5}
</style></head>
<body>
<div class="backdrop" id="bg" hidden></div>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}">
const S=${safeJson(state)};
const app=document.getElementById('app'),bg=document.getElementById('bg');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>{const u=['B','KB','MB','GB'];let i=0;n=Number(n)||0;while(n>=1024&&i<3){n/=1024;i++}return (n>=10||i===0?Math.round(n):n.toFixed(1))+' '+u[i]};
const left=()=>{const m=Math.max(0,Math.round((Date.parse(S.expires_at)-Date.now())/60000));return m>=120?Math.round(m/60)+' hours':m+' min'};
const kind=t=>(t||'').startsWith('image/')?'photo':(t||'').startsWith('video/')?'video':'file';
function describe(types){const c={photo:0,video:0,file:0};types.forEach(t=>c[kind(t)]++);const p=Object.entries(c).filter(([,n])=>n);const w=(k,n)=>n===1?'a '+k:n+' '+k+'s';
  if(p.length===1)return w(p[0][0],p[0][1]);if(p.length===2&&!c.file)return w('photo',c.photo)+' and '+w('video',c.video);return types.length+' items'}
const base=location.pathname.replace(/\\/$/,'');
function plain(){document.body.classList.add('plain');bg.hidden=true}
if(S.preview_url){bg.style.backgroundImage='url("'+S.preview_url+'")';bg.hidden=false}else plain();
function message(title,body){plain();app.innerHTML='<div class="alert"><div class="text"><h1>'+esc(title)+'</h1><p>'+esc(body)+'</p></div></div>'}
function render(){
  switch(S.availability){
    case 'not_found':return message('Share not found','Check the QR code or ask the sender to share again.');
    case 'expired':return message('This share has expired','Ask the sender to share again.');
    case 'revoked':return message('Share cancelled','The sender cancelled this share.');
    case 'full':return message('Already received','This share has reached its limit of receivers.');
    case 'preparing':setTimeout(()=>location.reload(),4000);return message('Almost ready…','The sender is still uploading.');
    case 'unavailable':return message('Share unavailable','Ask the sender to try again.');
    case 'declined':return message('Declined','Nothing was downloaded. You can close this page.');
    case 'accepted':return files();
  }
  app.innerHTML='<div class="alert" role="alertdialog" aria-labelledby="t" aria-describedby="m"><div class="text"><h1 id="t">TRYSA Share</h1><p id="m">'+esc(S.sender)+' would like to share '+esc(describe(S.types))+'.</p></div>'+
    (S.preview_url?'<div class="preview"><img alt="" src="'+esc(S.preview_url)+'"></div>':'')+
    (S.pin_required?'<div class="pin"><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="PIN" aria-label="PIN from the sender"></div>':'')+
    '<div class="err" id="err" hidden></div><div class="actions"><button id="decline">Decline</button><button id="accept" class="strong">Accept</button></div></div>'+
    '<div class="meta">'+S.count+' item'+(S.count===1?'':'s')+' · '+size(S.total_bytes)+' · expires in '+left()+'<br>No app or account needed. Only accept files from people you know.</div>';
  document.getElementById('accept').onclick=accept;
  document.getElementById('decline').onclick=async()=>{await fetch(base+'/decline',{method:'POST'}).catch(()=>{});S.availability='declined';render()};
}
async function accept(){
  const b=document.getElementById('accept'),err=document.getElementById('err');b.disabled=true;err.hidden=true;
  try{const pin=document.getElementById('pin');
    const r=await fetch(base+'/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:pin?pin.value:undefined}),credentials:'same-origin'});
    const j=await r.json();if(!r.ok)throw Error(j.error||'Could not accept');S.files=j.files;S.availability='accepted';render();
  }catch(e){err.textContent=e.message;err.hidden=false;b.disabled=false}
}
function files(){
  plain();const f=S.files||[];const media=f.every(x=>kind(x.type)!=='file');
  const canShare=!!(navigator.canShare&&window.File&&navigator.canShare({files:[new File([''],'x.jpg',{type:'image/jpeg'})]}));
  const small=f.reduce((n,x)=>n+x.size,0)<=300*1024*1024;
  app.innerHTML='<section class="files"><h2>From '+esc(S.sender)+'</h2><div class="sub">'+f.length+' item'+(f.length===1?'':'s')+' · available for '+left()+'</div><ul>'+
    f.map(x=>'<li><span class="thumb">'+esc((x.name.split('.').pop()||'').slice(0,4).toUpperCase())+'</span><span class="n"><b>'+esc(x.name)+'</b><small>'+size(x.size)+'</small></span><a href="'+esc(x.url)+'" download>Save</a></li>').join('')+'</ul>'+
    '<div class="btns">'+(canShare&&small?'<button class="pill" id="share">'+(media?'Save to Photos':'Save or Open')+'</button>':'')+
    (S.zip_url?'<a class="pill '+(canShare&&small?'ghost':'')+'" href="'+esc(S.zip_url)+'" download>Download all (.zip)</a>':'')+'</div>'+
    '<p class="note">'+(canShare&&small&&media?'Tap Save to Photos, then choose “Save Image” or “Save Video”.':'Files save to your Downloads.')+' Original quality.</p></section>';
  const sh=document.getElementById('share');
  if(sh)sh.onclick=async()=>{sh.disabled=true;sh.textContent='Preparing…';
    try{const out=[];for(const x of f){const r=await fetch(x.url,{credentials:'same-origin'});if(!r.ok)throw Error('Download failed');out.push(new File([await r.blob()],x.name,{type:x.type}))}
      await navigator.share({files:out})}catch(e){if(e.name!=='AbortError')alert(e.message)}sh.disabled=false;sh.textContent=media?'Save to Photos':'Save or Open'};
}
render();
</script></body></html>`;
}
