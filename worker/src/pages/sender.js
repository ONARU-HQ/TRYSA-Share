// Sender console served at /share — staging/reference UI for QR Send + Remote Send.
// In the native TRYSA app these screens map to /share, /share/send, /share/receive, /share/history.
// Only the PUBLIC publishable key reaches the browser; the service-role key stays in the Worker.

const attr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function senderPage(env) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0f172a"><title>TRYSA Share</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#0f172a;--muted:#5b6578;--line:#e3e8f0;--brand:#1d3f8f;--brand-ink:#fff;--soft:#eef2fb;--ok:#0f7b4f;--warn:#a1460b;--danger:#b3334d}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141a2e;--ink:#eef2ff;--muted:#9aa5bd;--line:#26304a;--brand:#7aa2ff;--brand-ink:#0b1020;--soft:#1b2440;--ok:#4cd39a;--warn:#ffb070;--danger:#ff7d93}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:20px 16px 8px;max-width:560px;margin:0 auto;display:flex;justify-content:space-between;align-items:center}
header b{letter-spacing:.04em}header small{color:var(--muted)}
main{max-width:560px;margin:0 auto;padding:8px 16px 40px}
nav{display:flex;gap:6px;background:var(--soft);padding:4px;border-radius:14px;margin-bottom:14px}
nav button{flex:1;margin:0;background:transparent;color:var(--muted);padding:10px}nav button.on{background:var(--card);color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:14px}
h2{font-size:18px;margin:0 0 10px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:700;color:var(--muted);margin:14px 0 6px}
input,select{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink)}
button{border:0;border-radius:12px;padding:13px 16px;font:inherit;font-weight:700;cursor:pointer;background:var(--brand);color:var(--brand-ink);margin-top:12px}
button.wide{width:100%}button.secondary{background:var(--soft);color:var(--ink)}button.danger{background:transparent;color:var(--danger);border:1px solid var(--line)}
button:disabled{opacity:.55}
.seg{display:flex;gap:8px}.seg button{flex:1;margin:0;background:var(--soft);color:var(--ink);text-align:left;padding:14px}
.seg button.on{outline:2px solid var(--brand)}.seg small{display:block;font-weight:400;color:var(--muted)}
.row{display:flex;gap:10px}.row>*{flex:1}
.pick{border:2px dashed var(--line);border-radius:14px;padding:22px;text-align:center;cursor:pointer}
.pick input{display:none}.summary{margin-top:10px}
.bar{height:8px;background:var(--soft);border-radius:8px;overflow:hidden;margin-top:12px}.bar i{display:block;height:100%;width:0;background:var(--brand);transition:width .2s}
.qr{display:flex;justify-content:center;background:#fff;border-radius:16px;padding:16px;margin:12px 0}.qr svg{width:min(260px,70vw);height:auto}
.link{word-break:break-all;font-size:14px;background:var(--soft);padding:10px;border-radius:10px}
.stats{display:flex;gap:8px;margin-top:12px}.stats div{flex:1;background:var(--soft);border-radius:12px;padding:10px;text-align:center}.stats b{display:block;font-size:20px}
.item{border-top:1px solid var(--line);padding:12px 0}.item:first-child{border-top:0}
.pill{display:inline-block;font-size:12px;padding:3px 9px;border-radius:20px;background:var(--soft);color:var(--muted);margin-left:6px}
.msg{font-size:14px;margin-top:10px;min-height:1.2em}.err{color:var(--warn)}.ok{color:var(--ok)}
[hidden]{display:none!important}
</style></head><body>
<header><b>TRYSA SHARE</b><small id="who"></small></header>
<main>
<section class="card" id="signin" hidden>
  <h2>Sign in to TRYSA</h2><p class="muted">Receivers don't need an account — only senders do.</p>
  <label for="email">Email</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <button class="wide" id="login">Email me a sign-in link</button><div class="msg" id="loginMsg"></div>
</section>

<div id="appUi" hidden>
<nav><button id="tabSend" class="on">Send</button><button id="tabInbox">Inbox</button><button id="tabSent">History</button></nav>

<section id="send">
  <div class="card" id="compose">
    <h2>Share photos, videos & files</h2>
    <div class="pick" id="pick"><input id="files" type="file" multiple><b>Choose files</b><div class="muted">Original quality · up to 50 files, 2 GB</div></div>
    <div class="summary muted" id="summary"></div>
    <label>How do you want to send?</label>
    <div class="seg"><button id="modeQr" class="on">QR Send<small>Anyone can scan — no app needed</small></button><button id="modeRemote">TRYSA user<small>Send to an account, anywhere</small></button></div>
    <div id="remoteOpts" hidden><label for="recipient">Recipient TRYSA ID</label><input id="recipient" placeholder="Recipient user ID"><p class="muted">Contact search arrives with the native app.</p></div>
    <label for="name">Transfer name (optional)</label><input id="name" maxlength="120" placeholder="e.g. Wedding photos — Ada">
    <div class="row" id="qrOpts">
      <div><label for="expiry">Expires in</label><select id="expiry"><option value="30">30 minutes</option><option value="120">2 hours</option><option value="1440">24 hours</option><option value="10080">7 days</option></select></div>
      <div><label for="receivers">Receivers</label><select id="receivers"><option value="1">1 person</option><option value="5">Up to 5</option><option value="20">Up to 20</option></select></div>
    </div>
    <div id="pinOpts"><label for="pin">PIN (optional, 4–8 digits)</label><input id="pin" inputmode="numeric" maxlength="8" placeholder="No PIN"></div>
    <button class="wide" id="go" disabled>Generate QR</button>
    <div class="bar" id="bar" hidden><i></i></div><div class="msg" id="sendMsg"></div>
  </div>
  <div class="card" id="result" hidden>
    <h2 id="resultTitle">Ready to scan</h2>
    <div class="qr" id="qr"></div>
    <div class="link" id="link"></div>
    <div class="row"><button class="secondary" id="copy">Copy link</button><button class="secondary" id="native">Share link</button></div>
    <div class="stats"><div><b id="sScan">0</b><span class="muted">scanned</span></div><div><b id="sAcc">0</b><span class="muted">accepted</span></div><div><b id="sDl">0</b><span class="muted">downloaded</span></div></div>
    <div class="msg" id="liveMsg"></div>
    <div class="row"><button class="danger" id="revoke">Cancel share</button><button class="secondary" id="again">Send more</button></div>
  </div>
</section>

<section id="inbox" hidden><div class="card"><h2>Incoming</h2><div id="inboxList" class="muted">Loading…</div></div></section>
<section id="sent" hidden><div class="card"><h2>History</h2><div id="sentList" class="muted">Loading…</div></div></section>
<button class="secondary" id="logout">Sign out</button>
</div>
</main>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.0/dist/umd/supabase.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>
<script>
const SUPABASE_URL="${attr(env.SUPABASE_URL)}", PUBLISHABLE_KEY="${attr(env.SUPABASE_PUBLISHABLE_KEY)}";
const sb=supabase.createClient(SUPABASE_URL,PUBLISHABLE_KEY);
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>{const u=['B','KB','MB','GB'];let i=0;n=Number(n);while(n>=1024&&i<3){n/=1024;i++}return (n>=10||i===0?Math.round(n):n.toFixed(1))+' '+u[i]};
let mode='qr', picked=[], current=null, poll=null;

async function token(){const {data:{session}}=await sb.auth.getSession();return session?.access_token}
async function api(action,props={}){
  const t=await token();if(!t)throw Error('Please sign in again');
  const r=await fetch('/api/share/v1',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({action,...props})});
  const j=await r.json().catch(()=>({}));if(!r.ok){const e=Error(j.error||'Request failed');e.status=r.status;e.body=j;throw e}return j;
}
async function refreshAuth(){
  const {data:{session}}=await sb.auth.getSession();
  $('signin').hidden=!!session;$('appUi').hidden=!session;$('who').textContent=session?(session.user.email||''):'';
}
sb.auth.onAuthStateChange(refreshAuth);refreshAuth();
$('login').onclick=async()=>{const {error}=await sb.auth.signInWithOtp({email:$('email').value.trim(),options:{emailRedirectTo:location.href}});
  $('loginMsg').className='msg '+(error?'err':'ok');$('loginMsg').textContent=error?error.message:'Check your email for the sign-in link.'};
$('logout').onclick=()=>sb.auth.signOut();

for(const [b,s] of [['tabSend','send'],['tabInbox','inbox'],['tabSent','sent']])$(b).onclick=()=>{
  for(const [b2,s2] of [['tabSend','send'],['tabInbox','inbox'],['tabSent','sent']]){$(b2).classList.toggle('on',b2===b);$(s2).hidden=s2!==s}
  if(s==='inbox')loadInbox();if(s==='sent')loadSent();
};
function setMode(m){mode=m;$('modeQr').classList.toggle('on',m==='qr');$('modeRemote').classList.toggle('on',m==='remote');
  $('remoteOpts').hidden=m!=='remote';$('qrOpts').hidden=m!=='qr';$('pinOpts').hidden=m!=='qr';$('go').textContent=m==='qr'?'Generate QR':'Send';}
$('modeQr').onclick=()=>setMode('qr');$('modeRemote').onclick=()=>setMode('remote');
$('pick').onclick=()=>$('files').click();
$('files').onchange=()=>{picked=[...$('files').files];const t=picked.reduce((n,f)=>n+f.size,0);
  $('summary').textContent=picked.length?picked.length+' file'+(picked.length===1?'':'s')+' · '+size(t)+' · '+picked.slice(0,3).map(f=>f.name).join(', ')+(picked.length>3?'…':''):'';
  $('go').disabled=!picked.length};

async function sha256(file){ if(file.size>64*1024*1024)return null; // hash small files only (phone memory)
  const d=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function put(url,file,onp){return new Promise((res,rej)=>{const x=new XMLHttpRequest();x.open('PUT',url);x.setRequestHeader('content-type',file.type||'application/octet-stream');
  x.upload.onprogress=e=>onp(e.loaded);x.onload=()=>x.status<300?res():rej(Error('Upload failed ('+x.status+')'));x.onerror=()=>rej(Error('Connection lost — check your network and retry'));x.send(file)})}

$('go').onclick=async()=>{
  const msg=$('sendMsg');msg.className='msg';$('go').disabled=true;$('bar').hidden=false;
  try{
    msg.textContent='Preparing files…';
    const files=[];for(const f of picked)files.push({name:f.name,size:f.size,type:f.type,sha256:await sha256(f)});
    const body={mode,files,name:$('name').value};
    if(mode==='remote')body.recipient_user_id=$('recipient').value.trim();
    else{body.expires_minutes=Number($('expiry').value);body.max_receivers=Number($('receivers').value);if($('pin').value)body.pin=$('pin').value}
    const c=await api('create',body);current=c;
    const total=picked.reduce((n,f)=>n+f.size,0);let done=0;
    for(let i=0;i<picked.length;i++){msg.textContent='Uploading '+(i+1)+' of '+picked.length+'…';
      await put(c.uploads[i].upload_url,picked[i],l=>{$('bar').firstChild.style.width=Math.round((done+l)/total*100)+'%'});done+=picked[i].size}
    msg.textContent='Verifying…';
    await api('publish',{session_id:c.session_id});
    msg.textContent='';$('bar').hidden=true;showResult(c);
  }catch(e){msg.className='msg err';msg.textContent=e.message+' — nothing was sent.';$('go').disabled=false}
};
function showResult(c){
  $('compose').hidden=true;$('result').hidden=false;
  if(c.mode==='qr'){const q=qrcode(0,'M');q.addData(c.share_url);q.make();$('qr').innerHTML=q.createSvgTag({cellSize:6,margin:2,scalable:true});
    $('link').textContent=c.share_url;$('resultTitle').textContent='Ready to scan';$('qr').hidden=false;$('link').hidden=false}
  else{$('qr').hidden=true;$('link').hidden=true;$('resultTitle').textContent='Sent — waiting for the recipient to accept'}
  clearInterval(poll);poll=setInterval(live,4000);live();
}
async function live(){if(!current)return;try{const s=await api('status',{session_id:current.session_id});
  $('sScan').textContent=s.activity.scans;$('sAcc').textContent=s.activity.accepted;$('sDl').textContent=s.activity.downloads_completed;
  const st=s.session.status;$('liveMsg').textContent={ready:'Waiting for the receiver…',claimed:'Accepted — downloading soon',transferring:'Downloading…',completed:'Delivered ✓',expired:'Expired',revoked:'Cancelled'}[st]||st;
  if(['completed','expired','revoked'].includes(st))clearInterval(poll)}catch(e){}}
$('copy').onclick=()=>navigator.clipboard.writeText(current.share_url).then(()=>$('liveMsg').textContent='Link copied');
$('native').onclick=()=>navigator.share?navigator.share({title:'TRYSA Share',url:current.share_url}):$('copy').click();
$('revoke').onclick=async()=>{if(!confirm('Cancel this share? Receivers will lose access immediately.'))return;await api('revoke',{session_id:current.session_id});live()};
$('again').onclick=()=>{clearInterval(poll);current=null;picked=[];$('files').value='';$('summary').textContent='';$('go').disabled=true;$('sendMsg').textContent='';$('compose').hidden=false;$('result').hidden=true};

async function loadSent(){try{const {transfers}=await api('sent');$('sentList').innerHTML=transfers.length?transfers.map(t=>'<div class="item"><b>'+esc(t.name)+'</b><span class="pill">'+esc(t.status)+'</span><span class="pill">'+(t.mode==='qr'?'QR':'TRYSA')+'</span><div class="muted">'+size(t.total_bytes)+' · '+new Date(t.created_at).toLocaleString()+'</div>'+
  (!['revoked','expired','failed'].includes(t.status)?'<button class="danger" data-revoke="'+t.id+'">Cancel</button>':'')+'</div>').join(''):'Nothing sent yet.';
  for(const b of document.querySelectorAll('[data-revoke]'))b.onclick=async()=>{await api('revoke',{session_id:b.dataset.revoke});loadSent()}}catch(e){$('sentList').textContent=e.message}}
async function loadInbox(){try{const {transfers}=await api('inbox');$('inboxList').innerHTML=transfers.length?transfers.map(t=>'<div class="item"><b>'+esc(t.session.sender_display_name||'TRYSA user')+'</b> — '+esc(t.session.name)+'<span class="pill">'+esc(t.receipt.status)+'</span><div class="muted">'+t.files.length+' files · '+size(t.session.total_bytes)+'</div>'+
  (t.session.receivable&&t.receipt.status==='requested'?'<div class="row"><button data-acc="'+t.session.id+'">Accept</button><button class="secondary" data-dec="'+t.session.id+'">Decline</button></div>':'')+
  (t.session.receivable&&['accepted','downloading','downloaded'].includes(t.receipt.status)?t.files.map(f=>'<button class="secondary" data-dl="'+t.session.id+'|'+f.id+'|'+esc(f.original_name)+'">⬇ '+esc(f.original_name)+'</button>').join(' '):'')+'</div>').join(''):'No incoming transfers.';
  for(const b of document.querySelectorAll('[data-acc]'))b.onclick=async()=>{await api('accept',{session_id:b.dataset.acc});loadInbox()};
  for(const b of document.querySelectorAll('[data-dec]'))b.onclick=async()=>{await api('decline',{session_id:b.dataset.dec});loadInbox()};
  for(const b of document.querySelectorAll('[data-dl]'))b.onclick=async()=>{const [s,f,n]=b.dataset.dl.split('|');b.disabled=true;
    const r=await fetch('/api/share/v1/sessions/'+s+'/files/'+f,{headers:{authorization:'Bearer '+await token()}});
    if(!r.ok){b.disabled=false;alert('Download failed');return}const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),60000);b.disabled=false};
}catch(e){$('inboxList').textContent=e.message}}
</script></body></html>`;
}
