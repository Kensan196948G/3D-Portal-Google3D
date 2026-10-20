/* =====================================================================
   9b. 業務機能（オンライン版）：気象・海象（気象庁）／実績入力（デモ）／CSV 出力／現場概要の印刷
   - 気象・海象は「いまの実際の予報・警報」（気象庁）。ワールドモデルの工程（基準日 2026-10-06 の架空データ）には入れない
   - 起動の後で取りに行く（気象庁が止まってもポータルは起動する）。発表区域ごとに1回だけ取得してキャッシュ
   ===================================================================== */
const JMA='https://www.jma.go.jp/bosai/';
// 警報・注意報の種別コード（気象庁「警報・注意報」ページ r8 版の定義から写したもの。2026-05-28 からの新しい防災気象情報に対応）
// [名称, 要素, 段階（20 注意報／30 警報／40 危険警報／50 特別警報）]。表に無いコードはコードのまま表示する
const WX_CODES={"33":["レベル５大雨特別警報","rain",50],"43":["レベル４大雨危険警報","rain",40],"03":["レベル３大雨警報","rain",30],"10":["レベル２大雨注意報","rain",20],
 "39":["レベル５土砂災害特別警報","landslide",50],"49":["レベル４土砂災害危険警報","landslide",40],"09":["レベル３土砂災害警報","landslide",30],"29":["レベル２土砂災害注意報","landslide",20],
 "38":["レベル５高潮特別警報","tide",50],"48":["レベル４高潮危険警報","tide",40],"08":["レベル３高潮警報","tide",30],"19":["レベル２高潮注意報","tide",20],
 "35":["暴風特別警報","wind",50],"05":["暴風警報","wind",30],"15":["強風注意報","wind",20],"32":["暴風雪特別警報","wind_snow",50],"02":["暴風雪警報","wind_snow",30],"13":["風雪注意報","wind_snow",20],
 "36":["大雪特別警報","snow",50],"06":["大雪警報","snow",30],"12":["大雪注意報","snow",20],"37":["波浪特別警報","wave",50],"07":["波浪警報","wave",30],"16":["波浪注意報","wave",20],
 "14":["雷注意報","thunder",20],"17":["融雪注意報","snow_melting",20],"20":["濃霧注意報","fog",20],"21":["乾燥注意報","dry",20],"22":["なだれ注意報","avalanche",20],
 "23":["低温注意報","cold",20],"24":["霜注意報","frost",20],"25":["着氷注意報","ice_accretion",20],"26":["着雪注意報","snow_accretion",20]};
const wxName=c=>(WX_CODES[c]||[`種別コード${c}`])[0];
const wxLv=c=>(WX_CODES[c]||[0,'',30])[2];   // 知らないコードは警報として扱う（安全側）
const wxIsWarn=c=>wxLv(c)>=30;
const WX_WORK=new Set(['wave','tide','wind','wind_snow','rain','thunder','landslide']);   // 屋外作業に関わる要素（注意報でも「注意」）
const MARINE=Object.assign({waveCaution:1.5,waveStop:2.5,exposedKinds:['seawall','reclaim','yard']},(GEO.marine||{}));
const WX={area:null, off:{}, warn:{}, site:{}, state:'idle', err:''};
const jget=u=>fetch(u,{cache:'no-cache'}).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); });

// 現場の市区町村コード（逆ジオコーダ）→ 気象庁の細分区域（市町村）→ 一次細分区域 → 府県予報区
// 政令指定都市は「仙台市東部・西部」のように市がいくつかに分かれる。そのときは候補をすべて持ち、
// 予報に波があるほう（＝海側）を選ぶ（wxBuild）。警報・注意報は同じ一次細分区域の候補をまとめて見る
function wxResolve(s){
  const A=WX.area, lg=s.lgcode|0, p5=n=>String(n).padStart(5,'0');
  let keys=[];
  for(const c of [lg, Math.floor(lg/10)*10, Math.floor(lg/100)*100]){ const k=p5(c)+'00'; if(A.class20s[k]){ keys=[k]; break; }
    const parts=Object.keys(A.class20s).filter(x=>x.startsWith(p5(c))); if(parts.length&&c!==lg){ keys=parts; break; } }
  if(!keys.length) keys=Object.keys(A.class20s).filter(k=>A.class20s[k].name===s.city);
  const parts=keys.map(c20=>{ const c15=A.class20s[c20].parent, c10=A.class15s[c15]&&A.class15s[c15].parent, off=c10&&A.class10s[c10]&&A.class10s[c10].parent;
    return off?{c20,c15,c10,off,name20:A.class20s[c20].name,name10:A.class10s[c10].name,nameOff:A.offices[off].name}:null; }).filter(Boolean);
  return parts.length?{parts}:null;
}
const waveMax=t=>{ const v=[...String(t||'').normalize('NFKC').matchAll(/(\d+(?:\.\d+)?)メートル/g)].map(m=>+m[1]); return v.length?Math.max(...v):null; };
function wxBuild(s,rr){
  // 候補が複数なら、予報に波がある一次細分区域（海側）を優先する
  const hasWave=p=>{ const f=WX.off[p.off], a=f&&f[0]&&f[0].timeSeries[0].areas.find(x=>x.area.code===p.c10); return !!(a&&a.waves); };
  const r0=rr.parts.find(hasWave)||rr.parts[0], same=rr.parts.filter(p=>p.c10===r0.c10), r={...r0, name20:same.map(p=>p.name20).join('・')};
  const fc=WX.off[r.off], wn=WX.warn[r.off], out={r, days:[], pops:[], warns:[], level:0, reasons:[], report:'', headline:''};
  if(fc&&fc[0]){ out.report=fc[0].reportDatetime; const ts=fc[0].timeSeries||[];
    const a0=ts[0]&&ts[0].areas.find(a=>a.area.code===r.c10);
    if(a0) out.days=ts[0].timeDefines.map((t,i)=>({t, weather:(a0.weathers||[])[i]||'', wind:(a0.winds||[])[i]||'', wave:(a0.waves||[])[i]||'', wmax:waveMax((a0.waves||[])[i])}));
    const a1=ts[1]&&ts[1].areas.find(a=>a.area.code===r.c10); if(a1) out.pops=ts[1].timeDefines.map((t,i)=>({t,pop:a1.pops[i]})); }
  if(Array.isArray(wn)){   // 発表のまとまり（要素ごと）のリスト。同じ種別は新しい発表の状態を使う
    const codes=new Set([r.c10,...same.map(p=>p.c20)]), last={}, heads=new Set();
    for(const bl of [...wn].sort((x,y)=>new Date(x.reportDatetime)-new Date(y.reportDatetime))){
      if(!out.warnReport||new Date(bl.reportDatetime)>new Date(out.warnReport)) out.warnReport=bl.reportDatetime;
      const W=bl.warning||{}; let hit=false;
      for(const it of [...(W.class10Items||[]),...(W.class20Items||[])]) if(codes.has(it.areaCode)) for(const k of it.kinds||[]) if(k.code){ last[k.code]={status:k.status,at:bl.reportDatetime}; if(k.status==='発表'||k.status==='継続') hit=true; }
      if(hit&&bl.headlineText) heads.add(bl.headlineText); }
    for(const [c,v] of Object.entries(last)) if(v.status==='発表'||v.status==='継続') out.warns.push({code:c,name:wxName(c),status:v.status,warn:wxIsWarn(c),lv:wxLv(c)});
    out.warns.sort((x,y)=>y.lv-x.lv); out.headline=[...heads].join(' '); }
  // 作業判断の目安（サンプル値。data/master.json の marine で変えられる）
  const exposed=MARINE.exposedKinds.includes(s.kind), today=out.days[0], wm=today?today.wmax:null;
  for(const w of out.warns){ if(w.warn){ out.level=2; out.reasons.push(w.name+'（発表中）'); } else if(WX_WORK.has((WX_CODES[w.code]||[])[1])){ out.level=Math.max(out.level,1); out.reasons.push(w.name); } }
  if(exposed&&wm!=null){ if(wm>=MARINE.waveStop){ out.level=2; out.reasons.push(`波の高さ ${wm}m（中止の目安 ${MARINE.waveStop}m 以上）`); }
    else if(wm>=MARINE.waveCaution){ out.level=Math.max(out.level,1); out.reasons.push(`波の高さ ${wm}m（注意の目安 ${MARINE.waveCaution}m 以上）`); } }
  return out;
}
async function wxLoad(){
  if(WX.state==='loading') return; WX.state='loading';
  try{
    WX.area=WX.area||await jget(JMA+'common/const/area.json');
    const map={}; for(const s of SITES){ const r=wxResolve(s); if(r) map[s.id]=r; }
    const offs=[...new Set(Object.values(map).flatMap(r=>r.parts.map(p=>p.off)))];
    await Promise.all(offs.map(async o=>{ try{ WX.off[o]=await jget(`${JMA}forecast/data/forecast/${o}.json`); }catch(e){ console.warn('forecast',o,e); }
      try{ WX.warn[o]=await jget(`${JMA}warning/data/r8/${o}.json`); }catch(e){ console.warn('warning',o,e); } }));
    for(const s of SITES) WX.site[s.id]=map[s.id]?wxBuild(s,map[s.id]):null;
    WX.state='ok'; WX.at=new Date();
  }catch(e){ WX.state='error'; WX.err=String(e.message||e); console.warn('気象庁データ',e); }
  renderLedger(); renderSummary(); if(state.sel&&state.tab==='wx') renderDock();
}
const wxLevel=s=>{ const w=WX.site[s.id]; return w?w.level:0; };
function wxBadge(s){ const w=WX.site[s.id]; if(!w||!w.level) return '';
  return `<span class="badge ${w.level>1?'late':'warn'}" title="${esc(w.reasons.join('／'))}（気象庁・現在）">${w.level>1?'⚠中止目安':'⚠気象'}</span>`; }
function wxSummaryHTML(){
  if(WX.state==='loading'||WX.state==='idle') return `<p class="hint">気象庁の予報・警報を取得しています…</p>`;
  if(WX.state==='error') return `<p class="hint">気象庁のデータを取得できませんでした（${esc(WX.err)}）。<button class="btn ghost" onclick="wxLoad()">再取得</button></p>`;
  const set=SITES.filter(inScope), st=set.filter(s=>wxLevel(s)>1), ca=set.filter(s=>wxLevel(s)===1);
  return `<div class="wxsum"><b>いまの気象・海象（気象庁）</b>：中止の目安 <span class="${st.length?'late':''}">${st.length}</span> 現場／注意 <span class="${ca.length?'warnc':''}">${ca.length}</span> 現場
    ${[...st,...ca].slice(0,6).map(s=>`<div class="wxrow"><span class="dot" style="background:${s.color}"></span>${esc(s.port)}：${esc(WX.site[s.id].reasons.join('／'))}</div>`).join('')}
    <div class="note">取得 ${WX.at?WX.at.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):''}・出典：気象庁ホームページ。作業判断の目安はサンプル値。</div></div>`; }
function renderWxTab(s){
  const w=WX.site[s.id], body=$('#dockBody');
  if(WX.state!=='ok'){ body.innerHTML=`<div class="card">${wxSummaryHTML()}</div>`; return; }
  if(!w){ body.innerHTML=`<div class="card"><p class="hint">この現場の所在地（${esc(s.city)}）に当たる気象庁の予報区域が見つかりませんでした。</p></div>`; return; }
  const r=w.r, d=t=>new Date(t).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short'}), tm=t=>t?new Date(t).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  const lv=w.level>1?`<span class="badge late" style="margin-left:0">中止の目安</span>`:w.level?`<span class="badge warn" style="margin-left:0">注意</span>`:`<span class="badge ok" style="margin-left:0">目安の範囲内</span>`;
  body.innerHTML=`<div class="g3">
    <div class="card"><h3>作業判断の目安 <small>いまの予報・警報から（サンプルの基準）</small></h3><div style="margin-bottom:6px">${lv}</div>
      ${w.reasons.length?`<ul class="steps">${w.reasons.map(x=>`<li><span class="no">!</span><div>${esc(x)}</div></li>`).join('')}</ul>`:'<p class="hint">発表中の警報・注意報はなく、波の高さも目安の範囲内です。</p>'}
      <div class="note">${MARINE.exposedKinds.includes(s.kind)?`水際の工種（${esc(s.k.label)}）なので波の高さも見ます：注意 ${MARINE.waveCaution}m／中止 ${MARINE.waveStop}m 以上。`:`陸側の工種（${esc(s.k.label)}）なので、波の高さは判断に入れていません。`}基準は data/master.json の marine で変えられます。最終判断は現場の責任者が行ってください。</div></div>
    <div class="card"><h3>警報・注意報 <small>${esc(r.name20)}（${esc(r.nameOff)}）・${tm(w.warnReport)} 発表</small></h3>
      ${w.warns.length?`<table class="t">${w.warns.map(x=>`<tr><td><span class="badge ${x.warn?'late':'warn'}" style="margin-left:0">${esc(x.name)}</span></td><td>${esc(x.status)}</td></tr>`).join('')}</table>`:'<p class="hint">発表中の警報・注意報はありません。</p>'}
      ${w.headline?`<div class="note">${esc(w.headline)}</div>`:''}</div>
    <div class="card"><h3>天気・風・波 <small>${esc(r.name10)}・${tm(w.report)} 発表</small></h3>
      <table class="t"><tr><th>日</th><th>天気</th><th>風</th><th>波</th></tr>${w.days.map(x=>`<tr><td class="nw">${d(x.t)}</td><td>${esc(x.weather.replace(/\s+/g,' '))}</td><td>${esc(x.wind.replace(/\s+/g,' '))}</td><td>${x.wave?esc(x.wave.replace(/\s+/g,' ')):'<span class="note">（波の予報なし）</span>'}</td></tr>`).join('')}</table>
      ${w.pops.length?`<div class="note">降水確率：${w.pops.map(p=>`${new Date(p.t).toLocaleString('ja-JP',{day:'numeric',hour:'numeric'})} ${p.pop}%`).join('／')}</div>`:''}
      <div class="note">出典：<a href="https://www.jma.go.jp/bosai/forecast/#area_type=class20s&area_code=${r.c20}" target="_blank" rel="noopener" style="color:#93c5fd">気象庁ホームページ</a>（いまの実際の予報。画面の工事・工程は架空で、予報は工程計算に入れていません）</div></div></div>`;
}

/* ---- 実績入力：サーバ版は DB に保存（編集者・管理者）、静的な配信ではこのブラウザにだけ保存（デモ） ---- */
const SRV=window.PORTAL_SERVER||null, CAN_EDIT=!SRV||['editor','admin'].includes(SRV.user.role);
const PROG_KEY='mirai-kensetsu-portal-progress-demo-v1';
const progLoad=()=>{ try{ return JSON.parse(localStorage.getItem(PROG_KEY)||'{}')||{}; }catch(e){ return {}; } };
const progSave=o=>{ try{ localStorage.setItem(PROG_KEY,JSON.stringify(o)); return true; }catch(e){ return false; } };
const PROG0={}; for(const s of SITES) PROG0[s.id]=s.tasks.map(t=>t.a);
const PROG_AT={};
function progApply(s,vals){ s.tasks.forEach((t,i)=>{ if(vals&&vals[i]!=null&&isFinite(vals[i])) t.a=clamp(Math.round(vals[i]*100)/100,0,1); });
  calibrate(s); s.base=simulate(s,s.p0); s.cur=simulate(s,s.p); worldDirty=true; sceneDirty=true; terrainDirty=true; uiDirty=true; }
(()=>{ if(SRV){ const P=GEO.progress||{}; for(const s of SITES){ const p=P[s.key]; if(p){ progApply(s,s.tasks.map((t,i)=>p.a[i]!=null?p.a[i]:null)); PROG_AT[s.id]=p.at; } } }
  else { const saved=progLoad(); for(const s of SITES) if(saved[s.id]&&Array.isArray(saved[s.id].a)) progApply(s,saved[s.id].a); } })();
async function api(method,url,body){ const r=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Portal-Request':'1'},body:body?JSON.stringify(body):undefined});
  let j=null; try{ j=await r.json(); }catch(e){} if(r.status===401){ toast('ログインが切れました。ページを読み込み直してログインしてください。',8000); }
  if(!r.ok){ const e=new Error((j&&j.error)||('HTTP '+r.status)); e.status=r.status; e.data=j; throw e; } return j; }
function renderProgTab(s){
  const saved=SRV?PROG_AT[s.id]:(progLoad()[s.id]||{}).at, ro=!CAN_EDIT;
  $('#dockBody').innerHTML=`<div class="g2"><div class="card"><h3>実績進捗の入力 <small>基準日 ${ds(B)} 時点の各工程の出来高（%）</small></h3>
    <table class="t"><tr><th>工程</th><th>工法</th><th class="n">計画</th><th class="n">初期値</th><th class="n">実績 %</th></tr>
    ${s.tasks.map((t,i)=>`<tr><td class="nw">${esc(t.n)}</td><td>${esc(t.m||'')}</td><td class="n">${Math.round(planP(t,B)*100)}%</td><td class="n">${Math.round(PROG0[s.id][i]*100)}%</td>
      <td class="n"><input type="number" min="0" max="100" step="1" value="${Math.round(t.a*100)}" data-pi="${i}"${ro?' disabled':''} style="width:64px;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 6px;text-align:right"></td></tr>`).join('')}</table>
    ${SRV&&!ro?`<label class="hint" style="display:block;margin-top:8px">変更の理由・メモ（任意）<input id="progNote" maxlength="500" style="width:100%;margin-top:4px;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 6px"></label>`:''}
    <div class="btns" style="margin-top:8px">${ro?'<span class="hint">閲覧者のため入力できません（編集者・管理者が入力します）。</span>':`<button class="btn" id="progApply">${SRV?'保存して予測し直す':'反映して予測し直す'}</button><button class="btn ghost" id="progReset">初期値に戻す</button>`}</div></div>
    <div class="card"><h3>保存と記録</h3>
      <div class="hint" style="margin-bottom:8px">${SRV?`<span class="badge ok" style="margin-left:0">データベース</span> 入力はサーバに保存され、ログインした全員に反映されます。変更の履歴（だれが・いつ・何を）も残ります。画面の現場は架空です。`
        :`<span class="badge warn" style="margin-left:0">デモ</span> 画面の現場は架空です。入力は<b>このブラウザにだけ</b>保存され、サーバや他の人には送られません。`}</div>
      <div class="hint">この現場の最終保存：${saved?new Date(saved).toLocaleString('ja-JP'):'なし'}</div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="progExport">全現場の実績を書き出す（JSON）</button>${SRV?'':'<label class="btn ghost" style="cursor:pointer">読み込む（JSON）<input type="file" id="progImport" accept="application/json,.json" hidden></label>'}</div>
      ${SRV?'<div id="progHist" class="note" style="margin-top:8px">変更の履歴を読み込んでいます…</div>':''}
      <div class="note">反映すると、実績から実効率 η を較正し直し、竣工予測・遅延・3D の出来形が変わります（ワールドモデルの計算は同じ）。</div></div></div>`;
  const body=$('#dockBody');
  if(!ro){
    $('#progApply').onclick=async()=>{ const raw=[...body.querySelectorAll('[data-pi]')].map(el=>parseFloat(el.value));
      if(raw.some(x=>!Number.isFinite(x))){ toast('空欄や数値でない欄があります。0〜100 の数値を入れてください。',6000); return; }
      const v=raw.map(x=>clamp(x/100,0,1));
      if(SRV){ try{ await api('PUT',`api/progress/${encodeURIComponent(s.key)}`,{a:v,note:($('#progNote')||{}).value||null}); PROG_AT[s.id]=new Date().toISOString(); }
        catch(e){ toast('保存できませんでした：'+esc(e.message),8000); return; } }
      progApply(s,v); if(!SRV){ const o=progLoad(); o[s.id]={a:s.tasks.map(t=>t.a),at:new Date().toISOString()}; if(!progSave(o)) toast('このブラウザでは保存できませんでした（プライベートモードなど）。反映はこの画面を閉じるまで有効です。'); }
      renderLedger(); renderSummary(); renderProgTab(s); };
    $('#progReset').onclick=async()=>{ if(SRV){ try{ await api('DELETE',`api/progress/${encodeURIComponent(s.key)}`); delete PROG_AT[s.id]; }catch(e){ toast('元に戻せませんでした：'+esc(e.message),8000); return; } }
      progApply(s,PROG0[s.id]); if(!SRV){ const o=progLoad(); delete o[s.id]; progSave(o); } renderLedger(); renderSummary(); renderProgTab(s); };
  }
  $('#progExport').onclick=()=>download(`現場実績_${localDate()}.json`,'application/json',JSON.stringify({kind:'mirai-portal-progress-demo',note:'架空現場の実績',exportedAt:new Date().toISOString(),
    sites:Object.fromEntries(SITES.map(x=>[x.id,{a:x.tasks.map(t=>t.a),at:SRV?PROG_AT[x.id]||null:(progLoad()[x.id]||{}).at||null}]))},null,1));
  const imp=$('#progImport'); if(imp) imp.onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); if(j.kind!=='mirai-portal-progress-demo'||typeof j.sites!=='object') throw new Error('形式が違います');
      const o=progLoad(); let n=0; for(const [id,v] of Object.entries(j.sites)){ const x=byId(id); if(x&&v&&Array.isArray(v.a)&&v.a.length===x.tasks.length&&v.a.every(a=>typeof a==='number'&&a>=0&&a<=1)){ progApply(x,v.a); o[id]={a:x.tasks.map(t=>t.a),at:v.at||new Date().toISOString()}; n++; } }
      progSave(o); renderLedger(); renderSummary(); renderProgTab(s); toast(`${n} 現場の実績を読み込みました。`,5000); }
    catch(err){ toast('読み込めませんでした：'+esc(err.message||err)); } };
  if(SRV) fetch(`api/progress/${encodeURIComponent(s.key)}/history`).then(r=>r.ok?r.json():[]).then(h=>{ const el=$('#progHist'); if(!el||state.tab!=='prog'||state.sel!==s.id) return;
    el.innerHTML=h.length?`<b>変更の履歴</b>（新しい順・最大10件）<br>${h.slice(0,10).map(x=>`${new Date(x.at).toLocaleString('ja-JP')}　${esc(s.tasks[x.task_idx]?s.tasks[x.task_idx].n:'工程'+x.task_idx)}　${x.a_old==null?'—':Math.round(x.a_old*100)+'%'} → ${Math.round(x.a_new*100)}%　${esc(x.email||'')}${x.note?'　「'+esc(x.note)+'」':''}`).join('<br>')}`:'変更の履歴はまだありません。'; }).catch(()=>{});
}

/* ---- ダウンロード・CSV 出力・印刷 ---- */
const localDate=()=>{ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
function download(name,type,text){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000); }
const csvCell=v=>{ let t=v==null?'':String(v); if(/^[=+\-@\t\r]/.test(t)) t="'"+t; return '"'+t.replace(/"/g,'""')+'"'; };   // Excel の数式として動かないように
function exportCSV(){
  const H=['工事番号（仮採番）','工事名','担当支店','担当','工種区分','工種','発注区分','発注者','所在地','実績進捗%','計画進捗%','切土m3（地山）','盛土m3（締固め後）','残土m3（ほぐし）','搬入土m3（ほぐし）','計画竣工','予測竣工','遅延予測（日）','気象（気象庁・現在）'];
  const rows=SITES.filter(inScope).map(s=>{ const w=WX.site[s.id]; return [s.id,s.name,s.brName,s.dept,s.cat,s.k.label,s.ccat,s.client,s.addr,Math.round(actualAtBase(s)*100),Math.round(planAtBase(s)*100),
    Math.round(s.g.Vc),Math.round(s.g.Vf),Math.round(s.cur.eb.outLoose),Math.round(s.cur.eb.borrowLoose),ds(s.planEnd),ds(s.cur.end),s.cur.delay,w?(w.reasons.join('／')||'目安の範囲内'):'—']; });
  const note=['※ 工事・発注者・工程はすべて架空のサンプル。情報区分：社内。基準日 '+ds(B)];
  download(`現場台帳_${scopeName()}_${localDate()}.csv`,'text/csv;charset=utf-8','﻿'+[note,H,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n'));
}
function printSite(s){
  const w=WX.site[s.id], a=Math.round(actualAtBase(s)*100), pl=Math.round(planAtBase(s)*100), d=s.cur.delay;
  let el=$('#printSheet'); if(!el){ el=document.createElement('div'); el.id='printSheet'; document.body.appendChild(el); }
  el.innerHTML=`<div class="ps-head"><div>みらい建設工業 3D現場ポータル／現場概要</div><div>情報区分：社内／架空のサンプル／出力 ${new Date().toLocaleString('ja-JP')}</div></div>
    <h1>${esc(s.name)}</h1><p class="ps-warn">この現場・発注者・工程は架空のサンプルです。みらい建設工業の実際の工事ではありません。</p>
    <table class="ps-t"><tr><th>工事番号</th><td>${esc(s.id)}（仮採番）</td><th>担当</th><td>${esc(s.dept)}</td></tr>
      <tr><th>工種</th><td>${esc(s.cat)}・${esc(s.k.label)}／${esc(s.scale)}</td><th>発注者</th><td>${esc(s.client)}（${esc(s.ccat)}）</td></tr>
      <tr><th>所在地</th><td>${esc(s.addr)}</td><th>施工範囲</th><td>${s.area.w} × ${s.area.d} m／計画地盤高 T.P. ${fmt1(s.FH)} m</td></tr>
      <tr><th>計画工期</th><td>${ds(s.planStart)} 〜 ${ds(s.planEnd)}</td><th>予測竣工</th><td>${ds(s.cur.end)}（${d>0?'+':''}${d} 日）</td></tr>
      <tr><th>進捗（基準日 ${ds(B)}）</th><td>実績 ${a}%／計画 ${pl}%</td><th>土量</th><td>切土 ${fmtN(s.g.Vc)} m³／盛土 ${fmtN(s.g.Vf)} m³／残土 ${fmtN(s.cur.eb.outLoose)} m³／搬入土 ${fmtN(s.cur.eb.borrowLoose)} m³</td></tr></table>
    <h2>工程</h2><div class="ps-g">${ganttSVG(s)}</div>
    <table class="ps-t"><tr><th>工程</th><th>工法</th><th>計画</th><th>実績</th></tr>${s.tasks.map(t=>`<tr><td>${esc(t.n)}</td><td>${esc(t.m||'')}</td><td>${ds(t.ts)}〜${ds(t.te)}</td><td>${Math.round(t.a*100)}%</td></tr>`).join('')}</table>
    ${w?`<h2>いまの気象・海象（気象庁）</h2><p>${w.reasons.length?esc(w.reasons.join('／')):'発表中の警報・注意報はなく、目安の範囲内'}。${w.days[0]?esc(w.days[0].weather.replace(/\s+/g,' '))+'／'+esc(w.days[0].wind.replace(/\s+/g,' '))+(w.days[0].wave?'／波 '+esc(w.days[0].wave.replace(/\s+/g,' ')):''):''}</p><p class="ps-note">出典：気象庁ホームページ。作業判断の目安はサンプル値。</p>`:''}
    <p class="ps-note">出典：国土地理院（標高タイル・逆ジオコーダ）を加工。計算はワールドモデル（サンプル）による予測です。</p>`;
  document.body.classList.add('printing'); const done=()=>{ document.body.classList.remove('printing'); window.removeEventListener('afterprint',done); };
  window.addEventListener('afterprint',done); window.print(); setTimeout(done,60000);
}
setTimeout(wxLoad,1500); setInterval(()=>{ if(!document.hidden) wxLoad(); },30*60*1000);   // 30分ごとに取り直す

