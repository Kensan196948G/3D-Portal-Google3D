/* =====================================================================
   9c. 業務機能（オンライン版）その2
   - 会議巡回（支店会議用：遅れの大きい順に現場を自動で巡回）
   - 説明モード（発注者・漁協など向け：完成後の姿と工程（計画）だけを表示）
   - 浸水想定（国土地理院 ハザードマップポータル：津波・高潮）
   - 潮位（気象庁 潮位表：満潮・干潮、干潮時の作業時間帯、潮位面の再生）
   - 作業船（デモ・架空。AIS 受信は未接続）
   - 遅れの分析と挽回編成の提案（ワールドモデルによる計算。文章はルールで作成）
   ===================================================================== */

/* ---- 共通：関数の差し替え（中身を変えずに前後へ処理を足す） ---- */
const _F={ select, renderSummary, renderDock, setLayer, renderTools, renderLegend, dynItems };

/* =================== 会議巡回 =================== */
const TOUR={on:false, list:[], i:0, sec:20, t0:0, paused:false, flying:false};
function tourStart(){
  const list=SITES.filter(s=>inScope(s)&&matches(s)).sort((a,b)=>b.cur.delay-a.cur.delay||a.id.localeCompare(b.id));
  if(!list.length){ toast('巡回する現場がありません（絞り込みを確認してください）',5000); return; }
  if(PRESENT) presentToggle(false);
  Object.assign(TOUR,{on:true,list,i:0,paused:false}); tourGo();
}
function tourGo(){ const s=TOUR.list[TOUR.i]; select(s.id); state.tab='ai'; renderDock(); TOUR.t0=performance.now(); tourBar(); }
function tourStep(d){ TOUR.i=(TOUR.i+d+TOUR.list.length)%TOUR.list.length; TOUR.paused=false; tourGo(); }
function tourStop(){ TOUR.on=false; $('#tourBar').hidden=true; $('#tourBtn').classList.remove('on'); }
function tourBar(){
  const el=$('#tourBar'), s=TOUR.list[TOUR.i], d=s.cur.delay; el.hidden=false; $('#tourBtn').classList.add('on');
  el.innerHTML=`<b>会議巡回</b><span>${TOUR.i+1}/${TOUR.list.length}</span><span class="dot" style="background:${s.color}"></span><span class="tn">${esc(s.port)}　${esc(s.k.label)}</span>
    <span class="${d>14?'late':d>0?'warnc':'ahead'}">遅延予測 ${d>0?'+':''}${d}日</span>
    <button data-t="prev" title="前の現場">◀</button><button data-t="pause">${TOUR.paused?'▶ 再開':'⏸ 一時停止'}</button><button data-t="next" title="次の現場">▶</button>
    <select data-t="sec" title="1現場の表示時間">${[10,20,30,60].map(v=>`<option value="${v}"${v===TOUR.sec?' selected':''}>${v}秒</option>`).join('')}</select><button data-t="stop" title="Esc">✕ 終了</button>
    <i class="tprog" style="width:0"></i>`;
}
document.addEventListener('click',e=>{ const b=e.target.closest('#tourBar [data-t]'); if(!b||b.tagName==='SELECT') return;
  const t=b.dataset.t; if(t==='prev') tourStep(-1); if(t==='next') tourStep(1); if(t==='stop') tourStop(); if(t==='pause'){ TOUR.paused=!TOUR.paused; TOUR.t0=performance.now(); tourBar(); } });
document.addEventListener('change',e=>{ if(e.target.matches('#tourBar [data-t="sec"]')){ TOUR.sec=+e.target.value; TOUR.t0=performance.now(); } });
window.addEventListener('keydown',e=>{ if(e.key==='Escape'&&TOUR.on) tourStop(); });
function tourTick(now){
  if(!TOUR.on) return;
  if(G.flying){ TOUR.t0=now; return; }                                     // 移動が終わってから数え始める
  if(G.ptrDown&&!TOUR.paused){ TOUR.paused=true; tourBar(); }              // 画面を触ったら一時停止
  if(TOUR.paused||document.hidden){ TOUR.t0=now-(Math.min(now-TOUR.t0,TOUR.sec*1000)); return; }
  const u=(now-TOUR.t0)/(TOUR.sec*1000), p=$('#tourBar .tprog'); if(p) p.style.width=Math.min(100,u*100)+'%';
  if(u>=1) tourStep(1);
}

/* =================== 説明モード =================== */
let PRESENT=false;
function presentToggle(on){
  PRESENT=on; document.body.classList.toggle('present',on); $('#presentBtn').classList.toggle('on',on); $('#presentBanner').hidden=!on;
  if(on){ if(TOUR.on) tourStop(); state.playing=false; updPlayBtn(); const s=byId(state.sel); setT(s?finishT(s):B); }
  else setT(B);
  if(state.tab==='present'||!on) state.tab='earth';
  renderLedger(); renderSummary(); renderDock(); renderTools();
}
const finishT=s=>Math.min(T_MAX,Math.max(s.cur.end,s.planEnd)+1);   // 完成後の姿（遅れの日数が見えないよう、竣工日そのものは出さない）
select=function(id,doFly){ _F.select(id,doFly); if(PRESENT){ const s=byId(id); setT(s?finishT(s):B); renderDock(); } };
renderSummary=function(){ if(!PRESENT) return _F.renderSummary();
  const el=$('#summary'), s=byId(state.sel);
  if(!s){ el.innerHTML=`<div class="dhead" style="margin-bottom:6px">説明モード</div><p class="hint">台帳の行か地図のピンを選ぶと、その工事の<b>完成後の姿</b>と<b>工程（計画）</b>を表示します。<br>遅れ・実績・工事番号・社内の情報は表示しません。</p>
      <div class="foot">画面の工事・発注者・計画はすべて架空のサンプルです（みらい建設工業の実際の工事ではありません）。</div>`; return; }
  el.innerHTML=`<div class="dhead"><span class="dot" style="background:${s.color}"></span><span>${esc(s.cat)}・${esc(s.k.label)}</span></div><h2>${esc(s.name)}</h2>
    <dl><dt>所在地</dt><dd>${esc(s.addr)}</dd><dt>発注者</dt><dd>${esc(s.client)}</dd><dt>工種・規模</dt><dd>${esc(s.scale)}</dd>
      <dt>計画工期</dt><dd>${ds(s.planStart)} 〜 ${ds(s.planEnd)}</dd><dt>施工範囲</dt><dd>約 ${s.area.w} × ${s.area.d} m</dd></dl>
    <div class="btns"><button class="btn" id="goSite">正面から見る</button><button class="btn ghost" id="goTop">真上から</button><button class="btn ghost" id="goNation">◀ 全国へ</button></div>
    <div class="foot">3D は完成後の姿（計画）です。工事・発注者・計画はすべて架空のサンプルです。</div>`;
  $('#goSite').onclick=()=>flySite(s,siteView(s)); $('#goTop').onclick=()=>flySite(s,siteView(s,{pitch:1.53,yaw:0,ty:0})); $('#goNation').onclick=()=>{ select(null); };
};
renderDock=function(){ if(!PRESENT) return _F.renderDock();
  const s=byId(state.sel); $('#dtabs').innerHTML=`<span class="dtitle">説明モード：工程（計画）</span><button class="dclose" id="dclose">${state.dockOpen?'▼ 閉じる':'▲ 開く'}</button>`; $('#dclose').onclick=toggleDock;
  if(!s){ $('#dockBody').innerHTML=`<div class="card"><p class="hint">工事を選ぶと、工程（計画）を表示します。</p></div>`; return; }
  $('#dockBody').innerHTML=`<div class="card"><h3>工程（計画） <small>${ds(s.planStart)} 〜 ${ds(s.planEnd)}</small></h3>${planGanttSVG(s)}
    <table class="t" style="margin-top:8px"><tr><th>工程</th><th>主な作業</th><th>期間（計画）</th></tr>${s.tasks.map(t=>`<tr><td class="nw">${esc(t.n)}</td><td>${esc(t.m||'')}</td><td class="nw">${ds(t.ts)} 〜 ${ds(t.te)}</td></tr>`).join('')}</table></div>`;
};
function planGanttSVG(s){
  const t0=s.planStart-10, t1=s.planEnd+10, W=760, LW=170, RH=22, Tp=22, H=Tp+s.tasks.length*RH+6, X=d=>LW+(d-t0)/(t1-t0)*(W-LW-10);
  let h=`<svg class="chart" viewBox="0 0 ${W} ${H}">`+monthTicks(t0,t1,X,Tp-6,H-4,2);
  s.tasks.forEach((t,i)=>{ const y=Tp+i*RH; h+=`<text x="6" y="${y+14}" font-size="11" fill="#e2e8f0">${esc(t.n)}</text><rect x="${X(t.ts)}" y="${y+4}" width="${Math.max(2,X(t.te)-X(t.ts))}" height="12" rx="3" fill="${s.color}" fill-opacity=".75"/>`; });
  return h+'</svg>';
}
$('#presentBtn').onclick=()=>presentToggle(!PRESENT);
document.addEventListener('click',e=>{ if(e.target.closest('#presentEnd')) presentToggle(false); });

/* =================== 浸水想定（国土地理院 ハザードマップポータル） =================== */
const HZ={tsunami:{name:'津波浸水想定',url:'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png'},
          surge:{name:'高潮浸水想定区域',url:'https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png'}};
function hzApply(){ if(!G.viewer) return; const L=G.viewer.imageryLayers;
  for(const k in HZ){ const on=!!state.layers[k];
    if(on&&!HZ[k].layer){ HZ[k].layer=L.addImageryProvider(new C3.UrlTemplateImageryProvider({url:HZ[k].url, minimumLevel:2, maximumLevel:17, rectangle:C3.Rectangle.fromDegrees(122,20,154,46.5),
      credit:new C3.Credit('<a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト</a>（'+HZ[k].name+'）',true)})); HZ[k].layer.alpha=.72; }
    if(!on&&HZ[k].layer){ L.remove(HZ[k].layer,true); HZ[k].layer=null; } } }

/* =================== 潮位（気象庁 潮位表） =================== */
const TIDE={cache:{}, date:null, hour:12, playing:false, show:true, prim:null, primSite:null, last:0};
const TIDE_ST=(GEO.tide&&GEO.tide.stations)||[];
const TWORK=Object.assign({belowMslCm:20},(GEO.marine&&GEO.marine.tideWork)||{});   // 干潮時作業の目安：MSL より 20cm 以上低い時間（サンプル値）
function tideStation(s){ if(s._tst!==undefined) return s._tst; let best=null, bd=1e9;
  for(const t of TIDE_ST){ const d=Math.hypot((t.lon-s.lon)*Math.cos(s.lat*Math.PI/180),t.lat-s.lat)*111; if(d<bd){ bd=d; best=t; } }
  return s._tst=best?{...best,km:bd}:null; }
const localISO=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
async function tideYear(code,year){ const k=code+year; if(TIDE.cache[k]) return TIDE.cache[k];
  return TIDE.cache[k]=fetch(`https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${year}/${code}.txt`).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); }).then(txt=>{
    const days={};
    for(const L of txt.split(/\r?\n/)){ if(L.length<136) continue;
      const h=[]; for(let i=0;i<24;i++) h.push(+L.slice(i*3,i*3+3));
      const y=2000+(+L.slice(72,74)), m=+L.slice(74,76), d=+L.slice(76,78), ev=o=>{ const r=[]; for(let i=0;i<4;i++){ const tm=L.slice(o+i*7,o+i*7+4), cm=+L.slice(o+i*7+4,o+i*7+7); if(tm.trim()!=='9999'&&cm!==999){ const hh=parseInt(tm.slice(0,2),10)||0, mi=parseInt(tm.slice(2,4),10)||0; r.push([`${String(hh).padStart(2,'0')}:${String(mi).padStart(2,'0')}`,cm]); } } return r; };
      days[`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`]={h,hi:ev(80),lo:ev(108)}; }
    return days; }).catch(e=>{ delete TIDE.cache[k]; throw e; }); }
const tideAt=(day,hr)=>{ const i=Math.floor(hr), f=hr-i, a=day.h[Math.min(23,i)], b=i>=23?a:day.h[i+1]; return a+(b-a)*f; };   // 時刻の潮位（cm、潮位表基準面から）
const tideTP=(st,cm)=>(cm-st.msl_dl+(st.msl_tp??0))/100;   // T.P. からの高さ m（MSL の標高が不明な地点は MSL≒T.P. とみなす）
async function renderTideTab(s){
  const st=tideStation(s), body=$('#dockBody');
  if(!st){ body.innerHTML='<div class="card"><p class="hint">近くに潮位表の地点がありません。</p></div>'; return; }
  TIDE.date=TIDE.date||localISO(new Date());
  body.innerHTML=`<div class="g2"><div class="card"><h3>潮位（推算） <small>${esc(st.name)}（${esc(st.code)}・現場から約 ${st.km.toFixed(1)} km）</small>
      <input type="date" id="tideDate" value="${TIDE.date}" style="margin-left:auto;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:2px 6px"></h3>
      <div id="tideChart"><p class="hint">気象庁の潮位表を取得しています…</p></div>
      <div class="btns" style="margin-top:6px"><button class="btn" id="tidePlay">${TIDE.playing?'⏸ 停止':'▶ 1日の潮位を再生（3D）'}</button><label class="hint" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="tideShow"${TIDE.show?' checked':''}> 3D に潮位面を出す</label></div></div>
    <div class="card"><h3>干潮時の作業時間帯 <small>目安：平均海面より ${TWORK.belowMslCm}cm 以上低い時間（サンプル値）</small></h3><div id="tideWin"></div>
      <div class="note">出典：気象庁「潮位表」（推算潮位。気象の影響は含みません）。潮位は潮位表基準面（DL）からの高さ cm。3D の潮位面は ${st.msl_tp!=null?`MSL の標高 ${(st.msl_tp/100).toFixed(2)} m を使って T.P. に合わせています`:'MSL を T.P. 0m とみなした概算です（この地点は MSL の標高が公表されていないため）'}。干潮時作業の判断は、現場の潮位観測と安全基準で行ってください。</div></div></div>`;
  $('#tideDate').onchange=e=>{ TIDE.date=e.target.value; renderTideTab(s); };
  $('#tidePlay').onclick=()=>{ TIDE.playing=!TIDE.playing; if(TIDE.playing){ TIDE.hour=0; TIDE.show=true; } $('#tidePlay').textContent=TIDE.playing?'⏸ 停止':'▶ 1日の潮位を再生（3D）'; };
  $('#tideShow').onchange=e=>{ TIDE.show=e.target.checked; };
  try{
    const days=await tideYear(st.code,+TIDE.date.slice(0,4)), day=days[TIDE.date];
    if(state.sel!==s.id||state.tab!=='tide') return;
    if(!day){ $('#tideChart').innerHTML=`<p class="hint">${esc(TIDE.date)} の潮位表がありません。</p>`; return; }
    TIDE.day=day; TIDE.st=st; TIDE.site=s.id;
    const thr=st.msl_dl-TWORK.belowMslCm, W=560, H=170, P=30, mx=Math.max(...day.h,st.msl_dl)+20, mn=Math.min(...day.h,thr)-20, X=hr=>P+hr/24*(W-P-8), Y=v=>8+(mx-v)/(mx-mn)*(H-30);
    const win=[]; let a=null; for(let m=0;m<=24*60;m+=5){ const low=tideAt(day,Math.min(23.999,m/60))<=thr; if(low&&a==null) a=m; if((!low||m===24*60)&&a!=null){ win.push([a,m]); a=null; } }
    const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
    $('#tideChart').innerHTML=`<svg class="chart" viewBox="0 0 ${W} ${H}">
      ${win.map(([p,q])=>`<rect x="${X(p/60)}" y="8" width="${X(q/60)-X(p/60)}" height="${H-30}" fill="#22c55e" fill-opacity=".14"/>`).join('')}
      ${[0,6,12,18,24].map(t=>`<line x1="${X(t)}" x2="${X(t)}" y1="8" y2="${H-22}" stroke="#334155"/><text x="${X(t)}" y="${H-8}" font-size="10" fill="#94a3b8" text-anchor="middle">${t}時</text>`).join('')}
      <line x1="${P}" x2="${W-8}" y1="${Y(st.msl_dl)}" y2="${Y(st.msl_dl)}" stroke="#64748b" stroke-dasharray="4 3"/><text x="${W-10}" y="${Y(st.msl_dl)-3}" font-size="10" fill="#94a3b8" text-anchor="end">平均海面</text>
      <line x1="${P}" x2="${W-8}" y1="${Y(thr)}" y2="${Y(thr)}" stroke="#22c55e" stroke-dasharray="3 3"/><text x="${W-10}" y="${Y(thr)+11}" font-size="10" fill="#86efac" text-anchor="end">作業の目安</text>
      <polyline fill="none" stroke="#60a5fa" stroke-width="2" points="${day.h.map((v,i)=>`${X(i)},${Y(v)}`).join(' ')}"/>
      ${[...day.hi.map(e=>['満',e]),...day.lo.map(e=>['干',e])].map(([k,[t,v]])=>{ const hr=+t.slice(0,2)+(+t.slice(3))/60; return `<circle cx="${X(hr)}" cy="${Y(v)}" r="3" fill="${k==='満'?'#f59e0b':'#22c55e'}"/><text x="${X(hr)}" y="${Y(v)+(k==='満'?-6:14)}" font-size="10" fill="#e2e8f0" text-anchor="middle">${k}潮 ${t}</text>`; }).join('')}
      <line id="tideNow" x1="${X(TIDE.hour)}" x2="${X(TIDE.hour)}" y1="8" y2="${H-22}" stroke="#fde68a" stroke-width="2"/>
      ${[0,50,100,150,200,250,300,350,400].filter(v=>v>mn&&v<mx).map(v=>`<text x="${P-4}" y="${Y(v)+3}" font-size="9" fill="#64748b" text-anchor="end">${v}</text>`).join('')}</svg>
      <div class="note">満潮 ${day.hi.map(e=>`${e[0]}（${e[1]}cm）`).join('・')||'—'}／干潮 ${day.lo.map(e=>`${e[0]}（${e[1]}cm）`).join('・')||'—'}　<span id="tideNowTxt"></span></div>`;
    TIDE.X=X;
    $('#tideWin').innerHTML=win.length?`<table class="t"><tr><th>時間帯</th><th class="n">長さ</th></tr>${win.map(([p,q])=>`<tr><td>${hm(p)} 〜 ${hm(q)}</td><td class="n">${((q-p)/60).toFixed(1)} 時間</td></tr>`).join('')}</table>`:'<p class="hint">この日は目安より低くなる時間がありません。</p>';
  }catch(e){ $('#tideChart').innerHTML=`<p class="hint">潮位表を取得できませんでした（${esc(e.message||e)}）。</p>`; }
}
function tideTick(now,dt){
  const s=byId(state.sel), ok=s&&state.mode==='site'&&SP.s===s&&SP.coll&&TIDE.day&&TIDE.site===s.id&&TIDE.show&&!PRESENT;
  if(TIDE.playing&&ok){ TIDE.hour=(TIDE.hour+dt*2)%24; }                         // 2時間/秒で1日を再生
  if(!ok){ if(TIDE.prim&&TIDE.prim._coll&&!TIDE.prim.isDestroyed()){ try{ TIDE.prim._coll.remove(TIDE.prim); }catch(e){} } TIDE.prim=null; return; }
  const lv=tideTP(TIDE.st,tideAt(TIDE.day,Math.min(23.999,TIDE.hour))), y=lv-s.yRef, m=trs(0,y-.02,0,0,1000,.04,1000);
  if(!TIDE.prim||TIDE.primSite!==s||TIDE.prim._coll!==SP.coll){
    TIDE.prim=SP.coll.add(new C3.Primitive({geometryInstances:new C3.GeometryInstance({geometry:BOX,id:'tide',attributes:{color:C3.ColorGeometryInstanceAttribute.fromColor(new C3.Color(.22,.52,.86,.42))}}),
      appearance:boxApp('trans'),asynchronous:false,allowPicking:false,compressVertices:false})); TIDE.prim._coll=SP.coll; TIDE.primSite=s; }
  itemMatrix(s,m,TIDE.prim.modelMatrix);
  if(now-TIDE.last>200){ TIDE.last=now; const ln=$('#tideNow'); if(ln&&TIDE.X){ ln.setAttribute('x1',TIDE.X(TIDE.hour)); ln.setAttribute('x2',TIDE.X(TIDE.hour)); }
    const tx=$('#tideNowTxt'); if(tx) tx.textContent=`表示中 ${String(Math.floor(TIDE.hour)).padStart(2,'0')}:${String(Math.floor(TIDE.hour%1*60)).padStart(2,'0')}　潮位 ${Math.round(tideAt(TIDE.day,Math.min(23.999,TIDE.hour)))}cm（T.P. ${lv>=0?'+':''}${lv.toFixed(2)} m）`; }
}

/* =================== 作業船（デモ・架空。AIS 未接続） =================== */
const VESSELS=(GEO.vessels||[]).map(v=>({...v}));
const VS={pts:null, lbl:null, map:{}, boats:null, last:0};
function vesselPos(v,t){ const a=t/v.period*2*Math.PI+v.phase, r=v.radius, dx=Math.cos(a)*r, dz=Math.sin(a)*r*.6;
  return {lon:v.lon+dx/(111320*Math.cos(v.lat*Math.PI/180)), lat:v.lat-dz/110574, head:Math.atan2(-Math.cos(a)*r*.6, -Math.sin(a)*r)}; }
function vesselTick(now){
  if(!G.scene||!VESSELS.length) return; const on=!!state.layers.vessel&&!PRESENT, t=now/1000;
  if(!VS.pts){ VS.pts=G.scene.primitives.add(new C3.PointPrimitiveCollection()); VS.lbl=G.scene.primitives.add(new C3.LabelCollection());
    for(const v of VESSELS){ VS.map[v.id]={p:VS.pts.add({pixelSize:9,color:C3.Color.fromCssColorString('#0ea5e9'),outlineColor:C3.Color.WHITE,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}),
      l:VS.lbl.add({text:`⛴ ${v.name}`,font:'12px sans-serif',fillColor:C3.Color.WHITE,outlineColor:C3.Color.fromCssColorString('#0f172a'),outlineWidth:3,style:C3.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new C3.Cartesian2(10,-10),
        distanceDisplayCondition:new C3.DistanceDisplayCondition(0,6e4),disableDepthTestDistance:Number.POSITIVE_INFINITY})}; } }
  if(now-VS.last<250) return; VS.last=now;
  for(const v of VESSELS){ const q=vesselPos(v,t), o=VS.map[v.id], h=(GEOID0[v.pref]??36)+1, pos=C3.Cartesian3.fromDegrees(q.lon,q.lat,h); o.p.position=pos; o.l.position=pos; o.p.show=on; o.l.show=on&&state.mode==='site'; v.now=q; }
}
// 現場表示：近くの作業船を箱で描く（水面 T.P.0m の上。海底の高さは使わない）
function vesselItems(s,t){ const out=[]; if(!state.layers.vessel||PRESENT) return out;
  for(const v of VESSELS){ const q=vesselPos(v,t), x=(q.lon-s.lon)*111320*Math.cos(s.lat*Math.PI/180), z=-(q.lat-s.lat)*110574; if(Math.hypot(x,z)>900) continue;
    const y=-s.yRef+.2, L=v.len||30, B=v.beam||10, c=hex(v.color||'#1e3a8a');
    out.push({m:trs(x,y,z,q.head,L,1.6,B),c:rgba(c)},{m:trs(x-Math.cos(q.head)*L*.3,y+1.6,z+Math.sin(q.head)*L*.3,q.head,L*.25,3,B*.7),c:[.93,.95,.97,1]});
    if(v.type==='grab') out.push({m:trs(x+Math.cos(q.head)*L*.15,y+1.6,z-Math.sin(q.head)*L*.15,q.head+.6,2,14,2),c:rgba(hex('#eab308'))}); }
  return out; }

/* =================== 遅れの分析と挽回編成の提案 =================== */
function analyzeDelay(s){
  const cur=s.cur, p=s.p, sim=q=>simulate(s,{...p,...q}), a=Math.round(actualAtBase(s)*100), pl=Math.round(planAtBase(s)*100);
  const fx=[], noW=s.region.ws?sim({winterF:100}):cur, noR=sim({rain:0});
  if(a<pl) fx.push(['実績の遅れ',`基準日 ${ds(B)} の出来高は ${a}%（計画 ${pl}%、${pl-a}pt の遅れ）。`,pl-a]);
  if(s.etaSrc==='obs') fx.push(['実効率',`実績から求めた実効率 η は ${s.eta.toFixed(2)}（能力に対する実際の出来高の割合）。${s.eta<.8?'能力どおりに進んでいません。':'おおむね能力どおりです。'}`,(1-s.eta)*20]);
  if(cur.earthEnd!=null&&s.tasks[s.earthIdx].a<1) fx.push(['ボトルネック',`土工のいちばん弱い工程は「${cur.cap.bn}」で、1日 約 ${fmtN(cur.cap.min)} m³（地山）です。`,5]);
  const dw=cur.end-noW.end, dr=cur.end-noR.end;
  if(dw>0) fx.push(['冬期',`冬期（${winterTxt(s.region)}）の稼働率低下で、竣工が約 ${dw} 日遅くなります。`,dw]);
  if(dr>0) fx.push(['雨天休止',`雨天・休止率 ${p.rain}% の影響で、竣工が約 ${dr} 日遅くなります（休止がない場合との比較）。`,dr/3]);
  if(cur.eb.borrowLoose>cur.eb.Q*.3) fx.push(['搬入土',`搬入土が約 ${fmtN(cur.eb.borrowLoose)} m³（ほぐし）と多く、運搬の台数が工程を左右します。`,4]);
  const slip=s.tasks.map((t,i)=>({t,F:cur.fc[i].F})).filter(x=>x.t.a<1&&x.F>x.t.te+2).sort((x,y)=>(y.F-y.t.te)-(x.F-x.t.te));
  return {a,pl,fx:fx.sort((x,y)=>y[2]-x[2]),slip,dw,dr};
}
function recoverPlans(s){
  const p0=s.p, base=s.cur, out=[], cost=q=>3*(q.ex-p0.ex)+1*(q.trucks-p0.trucks)+2*(q.rollers-p0.rollers)+1.5*(q.hours-p0.hours)+2.5*(q.days-p0.days);
  for(const dex of [0,1,2,3]) for(const dtr of [0,2,4,6,10]) for(const dro of [0,1,2]) for(const hrs of [p0.hours,Math.min(12,p0.hours+1),Math.min(12,p0.hours+2)]) for(const dys of [p0.days,Math.min(7,p0.days+1)]){
    const q={...p0, ex:clamp(p0.ex+dex,0,12), trucks:clamp(p0.trucks+dtr,0,60), rollers:clamp(p0.rollers+dro,0,8), hours:hrs, days:dys};
    if(cost(q)<=0) continue; const r=simulate(s,q); out.push({q,cost:cost(q),end:r.end,delay:r.delay,gain:base.end-r.end}); }
  const ok=out.filter(o=>o.delay<=0).sort((a,b)=>a.cost-b.cost||a.end-b.end);
  const best=out.filter(o=>o.gain>0).sort((a,b)=>b.gain/b.cost-a.gain/a.cost);
  const pick=[]; for(const o of [...ok,...best]){ if(pick.length>=3) break; if(!pick.some(x=>JSON.stringify(x.q)===JSON.stringify(o.q))) pick.push(o); }
  return {plans:pick, reachable:ok.length>0};
}
const planTxt=(q,p)=>[['バックホウ','ex','台'],['ダンプ','trucks','台'],['転圧組','rollers','組'],['稼働時間','hours','h/日'],['稼働日','days','日/週']].filter(([,k])=>q[k]!==p[k]).map(([n,k,u])=>`${n} ${p[k]}→${q[k]}${u}`).join('、');
function renderAiTab(s){
  const an=analyzeDelay(s), d=s.cur.delay, body=$('#dockBody');
  const head=d>0?`この工事の竣工予測は <b>${ds(s.cur.end)}</b> で、計画（${ds(s.planEnd)}）より <b class="${d>14?'late':'warnc'}">${d} 日遅れる</b>見込みです。`:`この工事の竣工予測は <b>${ds(s.cur.end)}</b> で、計画（${ds(s.planEnd)}）${d<0?`より ${-d} 日早く`:'どおりに'}終わる見込みです。`;
  const rec=d>0||s.cur.earthEnd>s.tasks[s.earthIdx].te?recoverPlans(s):{plans:[],reachable:true};
  body.innerHTML=`<div class="g2"><div class="card"><h3>遅れの理由 <small>ワールドモデルの計算から自動で作成</small></h3>
      <p style="font-size:12.5px;line-height:1.8;margin:0 0 8px">${head}</p>
      ${an.fx.length?`<ol class="steps">${an.fx.map(([k,v],i)=>`<li><span class="no">${i+1}</span><div><b>${esc(k)}</b>　${esc(v)}</div></li>`).join('')}</ol>`:'<p class="hint">目立った遅れの要因はありません。</p>'}
      ${an.slip.length?`<div class="note">計画より遅れる見込みの工程：${an.slip.slice(0,4).map(x=>`${esc(x.t.n)}（+${x.F-x.t.te}日）`).join('、')}</div>`:''}
      <div class="note">文章は計算結果からルールで作っています（AI による文章化はサーバ版で有効にできます）。架空の工事のサンプルです。</div></div>
    <div class="card"><h3>遅れを取り戻す編成の提案 <small>編成を変えて予測し直した結果</small></h3>
      ${rec.plans.length?`<table class="t"><tr><th>案</th><th>変更</th><th>予測竣工</th><th class="n">遅れ</th><th></th></tr>${rec.plans.map((o,i)=>`<tr><td>${'ABC'[i]}</td><td>${esc(planTxt(o.q,s.p))}</td><td class="nw">${ds(o.end)}</td>
        <td class="n ${o.delay>0?'late':'ahead'}">${o.delay>0?'+':''}${o.delay}日</td><td><button class="btn ghost" data-plan="${i}">試す</button></td></tr>`).join('')}</table>
        <div class="note">${rec.reachable?'計画工期に間に合う案のうち、追加が少ない順です。':'編成の変更だけでは計画工期に間に合いません。効果の大きい順の案です（工程の並び替え・工法の変更も検討してください）。'}「試す」は What-if（初期計画は残ります）。台数の上限・費用・現場の広さは考えていません。</div>`
        :`<p class="hint">${d>0?'土工以外の工程が遅れの原因のため、重機の編成では取り戻せません。':'遅れは見込まれていないため、提案はありません。'}</p>`}</div></div>`;
  body.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{ s.p={...rec.plans[+b.dataset.plan].q}; resim(s); renderLedger(); renderSummary(); state.tab='wm'; renderDock();
    toast('編成を変えて予測し直しました（What-if）。ワールドモデルのタブで初期計画と比べられます。',6000); });
}

/* ---- タブ・レイヤー・凡例への組み込み ---- */
setLayer=function(k,on){
  if((k==='tsunami'||k==='surge')&&on&&useG()){ _F.setLayer('g3d',false); toast('浸水想定は国土地理院の地図に重ねて表示します（Google 実写3D は一時的に切っています。Google 3D のボタンで戻せます）。',8000); }
  _F.setLayer(k,on); if(k==='tsunami'||k==='surge') hzApply(); };
renderTools=function(){ _F.renderTools(); if(PRESENT){ $('#layers').innerHTML=''; return; }
  const add=(k,n,t)=>`<button data-layer="${k}" class="${state.layers[k]?'on':''}" title="${t||''}">${n}</button>`;
  $('#layers').insertAdjacentHTML('beforeend', add('vessel','作業船','作業船の位置（デモ・架空。AIS 未接続）')+(state.mode==='nation'?add('tsunami','津波浸水想定','国土地理院 ハザードマップポータル')+add('surge','高潮浸水想定','国土地理院 ハザードマップポータル'):'')); };
renderLegend=function(){ _F.renderLegend(); const L=state.layers, add=[];
  if(state.mode==='nation'&&(L.tsunami||L.surge)) add.push(`<div><span class="sw" style="background:linear-gradient(90deg,#f7f5a9,#ffd8c0,#ffb7b7,#ff9191,#f285c9,#dc7adc)"></span>${[L.tsunami?'津波':'',L.surge?'高潮':''].filter(Boolean).join('・')}浸水想定（色が濃いほど深い）</div><div style="font-size:10px">凡例：<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener" style="color:#93c5fd">ハザードマップポータル</a></div>`);
  if(L.vessel&&VESSELS.length) add.push(`<div><span class="sw" style="background:#0ea5e9;border-radius:50%"></span>作業船（デモ・架空）</div>`);
  if(add.length) $('#legend').insertAdjacentHTML('beforeend',add.join('')); };
state.layers.vessel=true; state.layers.tsunami=false; state.layers.surge=false;

dynItems=function(s,t){ const r=_F.dynItems(s,t); for(const it of vesselItems(s,t)) r.sol.push(it); return r; };

/* ---- 毎フレームの処理（巡回・潮位面・作業船） ---- */
(function ftick(){ let last=performance.now();
  const f=now=>{ requestAnimationFrame(f); const dt=Math.min(.1,(now-last)/1000); last=now;
    try{ tourTick(now); if(G.scene){ tideTick(now,dt); vesselTick(now); } }catch(e){ console.warn(e); } };
  requestAnimationFrame(f); })();
$('#tourBtn').onclick=()=>TOUR.on?tourStop():tourStart();

