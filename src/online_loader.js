/* =====================================================================
   みらい建設工業 3D現場ポータル オンライン版：起動時のデータ取得（ローダ）
   - 自社サーバのデータファイル：data/sites.json（現場台帳）、data/master.json（地域係数）、data/japan.json（都道府県・高速道路の形）
   - 国土地理院（オンライン）：標高タイル DEM5A→DEM5B→DEM10B（現場の地形と周辺1km）、逆ジオコーダ＋地方公共団体コード表（所在地）
   - 取得したデータから、アプリ本体（app.js）が使う GEO を組み立ててから app.js を読み込む
   - 地形の作り方は tools/gen_sites.py と同じ（同じ入力なら同じ値になる）
   ===================================================================== */
'use strict';
(function(){
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz/';
const SRC = [['DEM5A','dem5a_png',15],['DEM5B','dem5b_png',15],['DEM10B','dem_png',14]];
const KX = lat => 111320*Math.cos(lat*Math.PI/180), KY = 110574;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let done=0, total=0;
const prog = msg => { if($('#boot')&&$('#boot').classList.contains('err')) return; const el=$('#bootMsg'); if(el) el.textContent=msg; const b=$('#bootBar'); if(b&&total) b.style.width=Math.min(100,done/total*100)+'%'; };

// 同時に投げる通信の数を抑える
const MAXC=8; let act=0; const q=[];
function limited(fn){ return new Promise((res,rej)=>{ const run=()=>{ act++; fn().then(res,rej).finally(()=>{ act--; if(q.length) q.shift()(); }); }; act<MAXC?run():q.push(run); }); }
async function get(url, kind){
  for(let a=0;a<3;a++){
    try{ const r=await limited(()=>fetch(url,{cache:'default'}));
      if(r.status===404) return null;
      if(!r.ok) throw new Error('HTTP '+r.status);
      return kind==='blob'?await r.blob():kind==='text'?await r.text():await r.json(); }
    catch(e){ if(a===2) throw new Error(url.replace(/\?.*/,'')+'：'+(e.message||e)); await new Promise(z=>setTimeout(z,600*(a+1))); }
  }
}

// 標高タイル（PNG）→ 標高 m（欠測は NaN）。色の変換をしないで読む
const tileCache=new Map();
async function decodeTile(blob){
  const bmp=await createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  const cv=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(256,256):Object.assign(document.createElement('canvas'),{width:256,height:256});
  const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(bmp,0,0); const d=cx.getImageData(0,0,256,256).data, h=new Float64Array(256*256);
  for(let i=0;i<256*256;i++){ const v=d[i*4]*65536+d[i*4+1]*256+d[i*4+2]; h[i]= v<8388608 ? v*0.01 : v===8388608 ? NaN : (v-16777216)*0.01; }
  return h;
}
function tile(lay,z,x,y){ const u=`${GSI}${lay}/${z}/${x}/${y}.png`;
  if(!tileCache.has(u)){ total++; tileCache.set(u,(async()=>{ const b=await get(u,'blob'); done++; prog(`国土地理院 標高タイルを取得中… ${done}/${total}`); return b?decodeTile(b):null; })()); }
  return tileCache.get(u); }
const merc=(lon,lat,z)=>{ const n=2**z, lr=lat*Math.PI/180; return [(lon+180)/360*n, (1-Math.log(Math.tan(lr)+1/Math.cos(lr))/Math.PI)/2*n]; };

// 1つの標高ソースのモザイク（gen_sites.py の Mosaic と同じ計算）
async function mosaic(lay,z,lon0,lat0,lon1,lat1){
  const [x0,y0]=merc(lon0,lat1,z), [x1,y1]=merc(lon1,lat0,z), tx0=Math.floor(x0), ty0=Math.floor(y0), tx1=Math.floor(x1), ty1=Math.floor(y1);
  const W=(tx1-tx0+1)*256, H=(ty1-ty0+1)*256, A=new Float64Array(W*H).fill(NaN), jobs=[];
  for(let ty=ty0;ty<=ty1;ty++) for(let tx=tx0;tx<=tx1;tx++) jobs.push(tile(lay,z,tx,ty).then(h=>{ if(!h) return;
    for(let r=0;r<256;r++) A.set(h.subarray(r*256,r*256+256),((ty-ty0)*256+r)*W+(tx-tx0)*256); }));
  await Promise.all(jobs);
  return (lon,lat)=>{ const n=2**z, px=(lon+180)/360*n*256-tx0*256-.5, lr=lat*Math.PI/180, py=(1-Math.log(Math.tan(lr)+1/Math.cos(lr))/Math.PI)/2*n*256-ty0*256-.5;
    let i=Math.floor(px), j=Math.floor(py); const u=px-i, v=py-j; if(!(i>=0&&j>=0&&i<W-1&&j<H-1)) return NaN;
    return A[j*W+i]*(1-u)*(1-v)+A[j*W+i+1]*u*(1-v)+A[(j+1)*W+i]*(1-u)*v+A[(j+1)*W+i+1]*u*v; };
}
const half = x => { const f=Math.floor(x), r=x-f; return r>.5?f+1:r<.5?f:(f%2===0?f:f+1); };   // 偶数丸め（numpy の round と同じ）
function enc16(arr){ const b=new Uint8Array(arr.length*2), dv=new DataView(b.buffer);
  for(let i=0;i<arr.length;i++) dv.setInt16(i*2,Math.max(-32768,Math.min(32767,half(arr[i]*10))),true);
  let s=''; for(let i=0;i<b.length;i+=0x8000) s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000)); return btoa(s); }
const median = a => { const s=Float64Array.from(a).sort(), n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };

// 現場1件の地形（施工範囲 E と周辺1km C）
async function terrain(site){
  const {lon,lat,w,d}=site, R=650, dlat=R/KY, dlon=R/KX(lat);
  const ms=await Promise.all(SRC.map(([,lay,z])=>mosaic(lay,z,lon-dlon,lat-dlat,lon+dlon,lat+dlat)));
  const sample=(lo,la)=>{ for(let k=0;k<ms.length;k++){ const h=ms[k](lo,la); if(!Number.isNaN(h)) return [h,k]; } return [NaN,-1]; };
  const cn=80, cw=1000, st=cw/cn, C=[];
  for(let j=0;j<=cn;j++) for(let i=0;i<=cn;i++){ const x=-cw/2+i*st, z=-cw/2+j*st, [h]=sample(lon+x/KX(lat),lat-z/KY); C.push(Number.isNaN(h)?-1.0:h); }
  // 海上工事：施工範囲の海底は台帳の深浅測量（架空）を使う（国土地理院の標高データは海に無い）
  if(site.survey){ const v=site.survey; return {nx:v.nx,nz:v.nz,src:v.src,E:v.E,cw,cn,C:enc16(C),emin:v.emin,emax:v.emax,emed:v.emed}; }
  const stp=Math.max(w,d)<=120?2:4, nx=half(w/stp), nz=half(d/stp), E=[], cnt=[0,0,0];
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++){ const x=-w/2+i*(w/nx), z=-d/2+j*(d/nz), [h,k]=sample(lon+x/KX(lat),lat-z/KY);
    if(Number.isNaN(h)) throw new Error('施工範囲に標高データのない点があります'); E.push(h); cnt[k]++; }
  return {nx,nz,src:SRC[cnt.indexOf(Math.max(...cnt))][0],E:enc16(E),cw,cn,C:enc16(C),emin:Math.min(...E),emax:Math.max(...E),emed:median(E)};
}

// 所在地（国土地理院 逆ジオコーダ。埋立地などで中心が行政界の外なら近い点から順に試す）
let MUNI=null;
async function muni(){ if(MUNI) return MUNI; const t=await get('https://maps.gsi.go.jp/js/muni.js','text'); MUNI={};
  for(const m of t.matchAll(/GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']*)'/g)){ const p=m[2].split(','); MUNI[parseInt(m[1],10)]=[p[1],(p[3]||'').replace(/　/g,'')]; }
  return MUNI; }
async function address(site){
  total++; const M=await muni();
  for(const R of [0,60,120,250,500,1000]) for(let k=0;k<(R===0?1:8);k++){
    const a=k*Math.PI/4, lo=site.lon+R*Math.cos(a)/KX(site.lat), la=site.lat+R*Math.sin(a)/KY;
    const j=await get(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${la.toFixed(6)}&lon=${lo.toFixed(6)}`,'json'), r=j&&j.results;
    if(r&&r.muniCd&&M[parseInt(r.muniCd,10)]){ const [pref,city]=M[parseInt(r.muniCd,10)], town=(r.lv01Nm||'').trim(); done++; prog(`所在地を取得中…`);
      return {pref,city,town:(town==='－'?'':town),lgcode:parseInt(r.muniCd,10)}; } }
  throw new Error('所在地を取得できません');
}

function fail(errs, ok, retry){
  const box=$('#boot'); box.classList.add('err');
  $('#bootMsg').innerHTML=`データを取得できませんでした（${errs.length}件）。ネットワーク（社内では FortiGate の通信許可）を確認してください。`;
  $('#bootErr').innerHTML=`<ul>${errs.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`+
    `<div class="btns"><button class="btn" id="bootRetry">もう一度取得する</button>${ok?`<button class="btn ghost" id="bootSkip">取得できた現場だけで表示</button>`:''}</div>`;
  $('#bootRetry').onclick=()=>location.reload(); if(ok) $('#bootSkip').onclick=retry;
}
function start(GEO){
  window.GEO=GEO; prog('画面を準備しています…');
  const s=document.createElement('script'); s.src='app.js';
  s.onload=()=>{ $('#boot').hidden=true; };
  s.onerror=()=>fail(['app.js を読み込めませんでした'],false);
  document.body.appendChild(s);
}
// ---- サーバ版のログイン ----
async function authState(){
  // 404＝/api が無い静的な配信。それ以外のエラー（5xx など）は静的配信にせず、エラーとして止める
  let r; try{ r=await fetch('api/auth/me',{cache:'no-store'}); }catch(e){ throw new Error('サーバに接続できません'); }
  if(r.status===401) return 'login'; if(r.ok) return 'ok'; if(r.status===404) return 'static';
  throw new Error(`サーバの応答が正しくありません（HTTP ${r.status}）`);
}
async function apiGet(u){ const r=await fetch(u,{cache:'no-store'}); let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok){ const e=new Error((j&&j.error)||('HTTP '+r.status)); e.status=r.status; throw e; } return j; }
function loginForm(){
  return new Promise(done=>{
    const box=$('#boot .bootBox'); $('#bootMsg').textContent='ログインしてください（メールアドレスとパスワード）。'; $('#bootBar').parentNode.hidden=true;
    const f=document.createElement('form'); f.id='loginForm'; f.className='loginForm'; f.autocomplete='on';
    f.innerHTML=`<label>メールアドレス<input type="email" name="email" autocomplete="username" required maxlength="254"></label>
      <label>パスワード<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>
      <div class="btns"><button class="btn" type="submit">ログイン</button></div><p class="loginErr" hidden></p>
      <p class="bootNote">情報区分「社内」。アカウントは DX推進部が発行します。社内ネットワーク（http）のため、パスワードは使い回さないでください。</p>`;
    box.insertBefore(f,$('#bootErr')); f.email.focus();
    f.onsubmit=async e=>{ e.preventDefault(); const er=f.querySelector('.loginErr'); er.hidden=true; f.querySelector('button').disabled=true;
      try{ const r=await fetch('api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Portal-Request':'1'},body:JSON.stringify({email:f.email.value,password:f.password.value})});
        let j={}; try{ j=await r.json(); }catch(x){}
        if(!r.ok){ er.textContent=j.error||('ログインできませんでした（HTTP '+r.status+'）'); er.hidden=false; f.password.value=''; return; }
        f.remove(); $('#bootBar').parentNode.hidden=false; done(); }
      catch(x){ er.textContent='サーバに接続できませんでした。ネットワークを確認して、もう一度ログインしてください。'; er.hidden=false; }
      finally{ const b=f.querySelector('button'); if(b) b.disabled=false; } };
  });
}
async function main(){
  if(location.protocol==='file:'){ fail(['このオンライン版は Webサーバ（http/https）に置いて開いてください。ファイルを直接開くとデータを取得できません。オフラインで使う場合はオフライン版を使ってください。'],false); return; }
  let reg, master, japan, server=null;
  // サーバ版（server/app.py）：ログインしてから、データを /api/bootstrap でまとめて受け取る（DB）。
  // 静的な配信（開発用 tools/serve_online.py）では /api が無いので、data/*.json を読む
  let mode; try{ mode=await authState(); }catch(e){ fail([String(e.message||e)],false); return; }
  if(mode==='login'){ await loginForm(); }
  if(mode!=='static'){
    prog('現場台帳を取得中（データベース）…');
    try{ server=await apiGet('api/bootstrap'); }
    catch(e){ if(e.status===401){ location.reload(); return; } fail([String(e.message||e)],false); return; }
    reg=server.sites; master=server.master; japan=server.japan;
    window.PORTAL_CONFIG={googleMapTilesKey:server.googleMapTilesKey||''};
    window.PORTAL_SERVER={user:server.user, features:server.features||{}};
    master={...master, vessels:(server.vessels||[]).map(v=>({radius:0, period:600, phase:0, ...v}))};
  } else {
    prog('現場台帳を取得中…');
    // data/config.json（任意・開発用）：Google Map Tiles API のキー。無ければ画面のキー入力を使う
    try{ window.PORTAL_CONFIG=(await get('data/config.json','json'))||{}; }catch(e){ window.PORTAL_CONFIG={}; }
    try{ [reg,master,japan]=await Promise.all([get('data/sites.json','json'),get('data/master.json','json'),get('data/japan.json','json')]); }
    catch(e){ fail([String(e.message||e)],false); return; }
  }
  const res=await Promise.all(reg.map(async site=>{
    try{ const [terr,ad]=await Promise.all([terrain(site),address(site)]); return {site,terr,ad}; }
    catch(e){ return {site,err:`${site.name}：${e.message||e}`}; } }));
  const ok=res.filter(r=>!r.err), errs=res.filter(r=>r.err).map(r=>r.err);
  // 現場の定義・位置・地形は同じ並びで持つ（取得できなかった現場は3つとも除く）
  const build=()=>start({ prefs:japan.prefs, roads:japan.roads, cities:[], region:master.region, marine:master.marine||null, tide:master.tide||null, vessels:master.vessels||[],
    defs:ok.map(r=>r.site), sel:ok.map(r=>({...r.ad, kind:r.site.kind, w:r.site.w, d:r.site.d, lon:r.site.lon, lat:r.site.lat, sea:r.site.sea||null})), terr:ok.map(r=>r.terr),
    progress:server?server.progress:null, fetched:{at:new Date().toISOString(), failed:errs} });
  if(errs.length) fail(errs, ok.length>0, build); else build();
}
main();
})();
