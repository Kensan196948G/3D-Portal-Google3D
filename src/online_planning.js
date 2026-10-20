/* =====================================================================
   9e. 計画の支援（オンライン版）
   - 作業可能日：潮位（気象庁 潮位表）× 波（気象庁の予報・約3日）× 工程（ワールドモデルの予測）
   - 類似工事の比較（総合評価部向け）：同じ工種・近い規模の工事の工程・土量・能力
   - 支店会議資料：遅れの大きい順の要約と、現場ごとの遅れの理由・挽回案（印刷して PDF に保存）
   ===================================================================== */

/* =================== 作業可能日 =================== */
// 基準はサンプル値（data/master.json の marine.workCriteria で変えられる）。波は予報がある日だけ判定し、ない日は推測しない
const WORK_CRIT=Object.assign({
  caisson:{label:'ケーソン据付',waveMax:.8,windowHours:4,dayStart:7,dayEnd:17,slackRateMax:15,roles:['wall'],note:'波が小さく、潮の変化がゆるやかな時間（転流前後）が日中に続くこと'},
  lowtide:{label:'干潮時の作業',waveMax:null,windowHours:2,dayStart:6,dayEnd:18,belowMslCm:20,roles:['wall','earth'],note:'平均海面より 20cm 以上低い時間が日中に続くこと'},
  marine:{label:'海上作業（一般）',waveMax:1.2,windowHours:6,dayStart:7,dayEnd:17,roles:['earth','wall'],note:'波が基準以下で、日中に作業時間がとれること'},
},(GEO.marine&&GEO.marine.workCriteria)||{});
const WORKSTATE={crit:'caisson', days:30};
const addDays=(iso,n)=>{ const d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return localISO(d); };
function dayWindows(day,st,c){   // 条件を満たす日中の連続時間（時）
  const ok=[], step=1/12;
  for(let h=c.dayStart; h<c.dayEnd-1e-9; h+=step){ const v=tideAt(day,Math.min(23.999,h)); let good=true;
    if(c.belowMslCm!=null) good=v<=st.msl_dl-c.belowMslCm;
    if(good&&c.slackRateMax!=null){ const r=Math.abs(tideAt(day,Math.min(23.999,h+.25))-tideAt(day,Math.max(0,h-.25)))*2; good=r<=c.slackRateMax; }
    ok.push(good); }
  const wins=[]; let a=null; ok.forEach((g,i)=>{ if(g&&a==null) a=i; if((!g||i===ok.length-1)&&a!=null){ const e=g?i+1:i; wins.push([c.dayStart+a*step,c.dayStart+e*step]); a=null; } });
  return wins.filter(([p,q])=>q-p>=c.windowHours-1e-9);
}
async function renderWorkTab(s){
  const st=tideStation(s), body=$('#dockBody'), c=WORK_CRIT[WORKSTATE.crit];
  if(!st){ body.innerHTML='<div class="card"><p class="hint">近くに潮位表の地点がないため、作業可能日を判定できません。</p></div>'; return; }
  const today=localISO(new Date()), dates=[...Array(WORKSTATE.days)].map((_,i)=>addDays(today,i));
  const tasks=s.tasks.map((t,i)=>({t,f:s.cur.fc[i]})).filter(x=>c.roles.includes(x.t.role||(x.t.earth?'earth':''))&&x.t.a<1);
  const win=tasks.length?{S:Math.min(...tasks.map(x=>x.f.S)),F:Math.max(...tasks.map(x=>x.f.F)),names:tasks.map(x=>x.t.n)}:null;
  body.innerHTML=`<div class="g2"><div class="card"><h3>作業可能日 <small>${esc(st.name)}の潮位表 × 気象庁の波の予報 × 工程（予測）</small></h3>
      <div class="btns" style="margin-bottom:8px">${Object.entries(WORK_CRIT).map(([k,v])=>`<button class="btn ${k===WORKSTATE.crit?'':'ghost'}" data-crit="${k}">${esc(v.label)}</button>`).join('')}
        <select id="workDays" style="background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px">${[14,30,60].map(n=>`<option value="${n}"${n===WORKSTATE.days?' selected':''}>${n}日</option>`).join('')}</select></div>
      <div id="workCal"><p class="hint">潮位表を読み込んでいます…</p></div></div>
    <div class="card"><h3>候補日 <small>適の日を優先、次に潮位だけ適の日</small></h3><div id="workList"></div>
      <div class="note">基準（サンプル値）：${esc(c.note)}。${c.waveMax!=null?`波 ${c.waveMax}m 以下、`:''}日中 ${c.dayStart}〜${c.dayEnd}時に ${c.windowHours} 時間以上${c.slackRateMax!=null?`、潮位の変化 ${c.slackRateMax}cm/時 以下`:''}。
        波は気象庁の予報がある約3日間だけ判定し、それより先は「潮位のみ適（波は前日に再確認）」とします。工程の該当期間は${win?`「${esc(win.names.join('・'))}」の予測 ${ds(win.S)}〜${ds(win.F)}`:'見つかりません（該当工程が完了済み）'}です（ワールドモデルの予測）。最終判断は現場の責任者が行ってください。</div></div></div>`;
  body.querySelectorAll('[data-crit]').forEach(b=>b.onclick=()=>{ WORKSTATE.crit=b.dataset.crit; renderWorkTab(s); });
  $('#workDays').onchange=e=>{ WORKSTATE.days=+e.target.value; renderWorkTab(s); };
  const years=[...new Set(dates.map(d=>+d.slice(0,4)))], tables={};
  for(const y of years){ try{ tables[y]=await tideYear(st.code,y); }catch(e){ tables[y]=null; } }   // 来年の潮位表が未公表のことがある
  if(state.sel!==s.id||state.tab!=='work') return;
  const wave={}; const w=WX.site[s.id]; if(w) for(const d of w.days) wave[localISO(new Date(d.t))]=d.wmax;
  const res=dates.map(d=>{ const tb=tables[+d.slice(0,4)], day=tb&&tb[d], inWin=win?(dn(d)>=win.S&&dn(d)<=win.F):false;
    if(!day) return {d,cls:'nodata',txt:'潮位表なし',inWin};
    const wins=dayWindows(day,st,c), hasWave=d in wave&&wave[d]!=null, waveOk=c.waveMax==null||(hasWave&&wave[d]<=c.waveMax);
    if(!wins.length) return {d,cls:'ng',txt:'時間が足りない',inWin,wins};
    if(c.waveMax!=null&&hasWave&&!waveOk) return {d,cls:'ng',txt:`波 ${wave[d]}m`,inWin,wins};
    if(c.waveMax!=null&&!hasWave) return {d,cls:'tide',txt:'潮位のみ適',inWin,wins};
    return {d,cls:'ok',txt:'適',inWin,wins,wave:wave[d]}; });
  const hm=h=>`${String(Math.floor(h)).padStart(2,'0')}:${String(Math.round(h%1*60)%60).padStart(2,'0')}`;
  const wd=d=>'日月火水木金土'[new Date(d+'T00:00:00').getDay()];
  $('#workCal').innerHTML=`<div class="workcal">${res.map(r=>`<div class="wc ${r.cls}${r.inWin?' inwin':''}" title="${esc(r.d)} ${esc(r.txt)}${r.wins?'　'+r.wins.map(([p,q])=>hm(p)+'〜'+hm(q)).join('、'):''}">
      <b>${+r.d.slice(5,7)}/${+r.d.slice(8)}</b><span>${wd(r.d)}</span><i>${esc(r.txt)}</i></div>`).join('')}</div>
    <div class="hleg" style="gap:10px;flex-wrap:wrap"><span><i class="wc-sw ok"></i>適</span><span><i class="wc-sw tide"></i>潮位のみ適（波は前日に再確認）</span><span><i class="wc-sw ng"></i>不適</span><span><i class="wc-sw inwin"></i>工程の該当期間（予測）</span></div>`;
  const cand=res.filter(r=>(r.cls==='ok'||r.cls==='tide')&&(!win||r.inWin)).sort((a,b)=>(a.cls==='ok'?0:1)-(b.cls==='ok'?0:1)||a.d.localeCompare(b.d)).slice(0,8);
  $('#workList').innerHTML=cand.length?`<table class="t"><tr><th>日付</th><th>判定</th><th>作業できる時間帯</th></tr>${cand.map(r=>`<tr><td class="nw">${r.d.replace(/-/g,'/')}（${wd(r.d)}）</td>
      <td><span class="badge ${r.cls==='ok'?'ok':'warn'}" style="margin-left:0">${esc(r.txt)}</span></td><td>${r.wins.map(([p,q])=>hm(p)+'〜'+hm(q)).join('、')}</td></tr>`).join('')}</table>`
    :`<p class="hint">${win?'工程の該当期間の中に候補日がありません。期間（日数）を延ばすか、基準を見直してください。':'候補日がありません。'}</p>`;
}

/* =================== 類似工事の比較 =================== */
const qOf=s=>s.cur.eb.Q, durPlan=s=>s.planEnd-s.planStart, durFc=s=>s.cur.end-s.planStart;
function similarSites(s){ const same=SITES.filter(x=>x!==s&&x.kind===s.kind), band=same.filter(x=>qOf(x)>=qOf(s)*.5&&qOf(x)<=qOf(s)*2);
  return {list:band.length?band:same.length?same:SITES.filter(x=>x!==s&&x.cat===s.cat), how:band.length?'同じ工種・土量 0.5〜2 倍':same.length?'同じ工種（規模は問わない）':'同じ工種区分'}; }
function cmpRow(x,me){ const d=x.cur.delay; return `<tr${x===me?' style="background:#1a2948"':''}><td class="nw"><span class="dot" style="background:${x.color}"></span> ${esc(x.id)}</td><td><div class="pfname" title="${esc(x.name)}">${esc(x.name)}</div></td><td class="nw">${esc(x.k.label)}</td>
  <td class="n">${fmtN(qOf(x))}</td><td class="n">${durPlan(x)}</td><td class="n">${durFc(x)}</td><td class="n ${d>14?'late':d>0?'warnc':'ahead'}">${d>0?'+':''}${d}</td>
  <td class="n">${x.etaSrc==='obs'?x.eta.toFixed(2):'—'}</td><td class="n">${fmtN(x.cur.cap.min)}</td><td>${esc(x.cur.cap.bn.replace(/（.*/,''))}</td></tr>`; }
const CMP_HEAD='<tr><th>工事番号</th><th>工事名</th><th>工種</th><th class="n">取扱土量 m³</th><th class="n">計画工期 日</th><th class="n">予測工期 日</th><th class="n">遅延 日</th><th class="n">実効率 η</th><th class="n">能力 m³/日</th><th>ボトルネック</th></tr>';
function cmpScatter(list,me){ const W=520,H=230,P=46, xs=list.map(qOf), ys=list.flatMap(x=>[durPlan(x),durFc(x)]), x0=0, x1=Math.max(...xs)*1.1||1, y0=Math.min(...ys)*.9, y1=Math.max(...ys)*1.05,
    X=v=>P+(v-x0)/(x1-x0)*(W-P-10), Y=v=>H-26-(v-y0)/(y1-y0||1)*(H-40);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="${P}" y1="${H-26}" x2="${W-10}" y2="${H-26}" stroke="#334155"/><line x1="${P}" y1="10" x2="${P}" y2="${H-26}" stroke="#334155"/>
    <text x="${W-10}" y="${H-8}" font-size="10" fill="#94a3b8" text-anchor="end">取扱土量（m³）</text><text x="6" y="14" font-size="10" fill="#94a3b8">工期（日）</text>
    ${list.map(x=>`<line x1="${X(qOf(x))}" y1="${Y(durPlan(x))}" x2="${X(qOf(x))}" y2="${Y(durFc(x))}" stroke="${x.color}" stroke-opacity=".6"/>
      <circle cx="${X(qOf(x))}" cy="${Y(durPlan(x))}" r="3.5" fill="none" stroke="${x.color}"/><circle cx="${X(qOf(x))}" cy="${Y(durFc(x))}" r="${x===me?6:4}" fill="${x.color}" stroke="${x===me?'#fff':'none'}"/>
      <text x="${X(qOf(x))+7}" y="${Y(durFc(x))+3}" font-size="9.5" fill="#cbd5e1">${esc(x.port)}</text>`).join('')}</svg>
    <div class="note">○＝計画工期、●＝予測工期（線で結んだ長さが遅れ）。</div>`; }
function renderCmpTab(s){ const {list,how}=similarSites(s), all=[s,...list].sort((a,b)=>qOf(a)-qOf(b));
  $('#dockBody').innerHTML=`<div class="g2b"><div class="card"><h3>類似工事の比較 <small>${esc(how)}・${list.length}件</small></h3><table class="t">${CMP_HEAD}${all.map(x=>cmpRow(x,s)).join('')}</table>
      <div class="note">工期・土量・能力はワールドモデルの計算（初期計画と実績で較正）です。<b>現場はすべて架空のサンプル（${SITES.length}件）</b>なので、件数が少なく、統計としての意味はまだありません。実際の工事の実績が入ると、入札時の工程・能力の見積りの根拠に使えます。</div></div>
    <div class="card"><h3>土量と工期</h3>${cmpScatter(all,s)}</div></div>`; }
function kindSummaryHTML(){ const set=SITES.filter(inScope), g={}; for(const x of set) (g[x.kind]=g[x.kind]||[]).push(x);
  const avg=(a,f)=>a.reduce((p,x)=>p+f(x),0)/a.length;
  return `<table class="t"><tr><th>工種</th><th class="n">件数</th><th class="n">平均 土量 m³</th><th class="n">平均 計画工期 日</th><th class="n">平均 遅延 日</th><th class="n">平均 能力 m³/日</th></tr>
    ${Object.values(g).map(a=>`<tr><td>${esc(a[0].k.label)}</td><td class="n">${a.length}</td><td class="n">${fmtN(avg(a,qOf))}</td><td class="n">${fmtN(avg(a,durPlan))}</td><td class="n">${fmt1(avg(a,x=>x.cur.delay))}</td><td class="n">${fmtN(avg(a,x=>x.cur.cap.min))}</td></tr>`).join('')}</table>
    <div class="note">工種ごとの平均（架空のサンプル）。現場を選ぶと「類似工事」タブで個別に比べられます。</div>`; }

/* =================== 支店会議資料（印刷して PDF に保存） =================== */
async function meetingReport(opts){
  const set=SITES.filter(inScope).sort((a,b)=>b.cur.delay-a.cur.delay||a.id.localeCompare(b.id)), when=new Date().toLocaleString('ja-JP');
  const late=set.filter(x=>x.cur.delay>14).length, warn=set.filter(x=>x.cur.delay>0&&x.cur.delay<=14).length;
  const ai={}; if(opts.ai&&window.PORTAL_SERVER&&PORTAL_SERVER.features.ai){ let i=0;
    for(const x of set.filter(x=>x.cur.delay>0)){ i++; toast(`AI の説明文を作成中… ${i}`,4000);
      try{ const an=analyzeDelay(x); const r=await api('POST','api/ai/explain',{site:x.id,name:x.name,kind:x.k.label,branch:x.brName,plannedEnd:ds(x.planEnd),forecastEnd:ds(x.cur.end),delayDays:x.cur.delay,
        actualPct:an.a,planPct:an.pl,factors:an.fx.map(([k,v])=>({factor:k,detail:v})),note:'架空の工事のサンプル'}); ai[x.id]=r.text; }
      catch(e){ ai[x.id]='（AI の説明文を作成できませんでした：'+e.message+'）'; } } }
  const sec=x=>{ const an=analyzeDelay(x), d=x.cur.delay, rec=opts.recovery&&d>0?recoverPlans(x):{plans:[]};
    return `<section class="ps-site"><h2>${esc(x.id)}　${esc(x.name)}</h2>
      <table class="ps-t"><tr><th>担当</th><td>${esc(x.dept)}</td><th>工種</th><td>${esc(x.cat)}・${esc(x.k.label)}</td></tr>
        <tr><th>計画工期</th><td>${ds(x.planStart)}〜${ds(x.planEnd)}</td><th>予測竣工</th><td>${ds(x.cur.end)}（${d>0?'+':''}${d}日）</td></tr>
        <tr><th>進捗（基準日）</th><td>実績 ${an.a}%／計画 ${an.pl}%</td><th>ボトルネック</th><td>${esc(x.cur.cap.bn)}</td></tr></table>
      ${an.fx.length?`<p><b>遅れの理由</b>：${an.fx.map(([k,v])=>`【${esc(k)}】${esc(v)}`).join(' ')}</p>`:'<p>目立った遅れの要因はありません。</p>'}
      ${rec.plans.length?`<p><b>挽回の案</b>：${esc(planTxt(rec.plans[0].q,x.p))} → 予測竣工 ${ds(rec.plans[0].end)}（${rec.plans[0].delay>0?'+':''}${rec.plans[0].delay}日）${rec.reachable?'':'（編成だけでは工期内に収まりません）'}</p>`:''}
      ${ai[x.id]?`<p><b>AI による説明</b>：${esc(ai[x.id])}</p>`:''}</section>`; };
  let el=$('#printSheet'); if(!el){ el=document.createElement('div'); el.id='printSheet'; document.body.appendChild(el); }
  el.innerHTML=`<div class="ps-head"><div>みらい建設工業 3D現場ポータル／支店会議資料</div><div>情報区分：社内／架空のサンプル／作成 ${esc(when)}</div></div>
    <h1>工程会議資料（${esc(scopeName())}）</h1><p class="ps-warn">この資料の工事・発注者・工程は架空のサンプルです。みらい建設工業の実際の工事ではありません。数値はワールドモデルの予測（基準日 ${ds(B)}）です。</p>
    <table class="ps-t"><tr><th>対象</th><td>${set.length} 現場</td><th>遅延予測</th><td>15日超 ${late} 件／1〜14日 ${warn} 件</td></tr></table>
    <h2>遅れの大きい順</h2><table class="ps-t"><tr><th>#</th><th>工事番号</th><th>工事名</th><th>担当支店</th><th>進捗（実績/計画）</th><th>予測竣工</th><th>遅延</th></tr>
      ${set.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td>${esc(x.brName)}</td><td>${Math.round(actualAtBase(x)*100)}%／${Math.round(planAtBase(x)*100)}%</td><td>${ds(x.cur.end)}</td><td>${x.cur.delay>0?'+':''}${x.cur.delay}日</td></tr>`).join('')}</table>
    ${set.filter(x=>opts.all||x.cur.delay>0).map(sec).join('')}
    <p class="ps-note">出典：国土地理院（標高タイル・逆ジオコーダ）を加工。遅れの理由・挽回の案はワールドモデルの計算からルールで作成${Object.keys(ai).length?'、AI の説明は Claude が計算結果をもとに作成':''}。</p>`;
  document.body.classList.add('printing'); const done=()=>{ document.body.classList.remove('printing'); window.removeEventListener('afterprint',done); };
  window.addEventListener('afterprint',done); window.print(); setTimeout(done,60000);
}
function openReportDialog(){
  let el=$('#rptDlg'); if(!el){ el=document.createElement('div'); el.id='rptDlg'; el.className='dlg'; document.body.appendChild(el); }
  const aiOk=!!(window.PORTAL_SERVER&&PORTAL_SERVER.features.ai);
  el.hidden=false; el.innerHTML=`<div class="dlgBox" role="dialog" aria-modal="true"><h2>支店会議資料（PDF）</h2>
    <p>いまの絞り込み（${esc(scopeName())}・${SITES.filter(inScope).length} 現場）を、遅れの大きい順にまとめます。印刷の画面で「PDF に保存」を選んでください。</p>
    <label class="ck"><input type="checkbox" id="rptRec" checked> 挽回の案を入れる（現場が多いと数秒かかります）</label>
    <label class="ck"><input type="checkbox" id="rptAll"> 遅れていない現場の詳細も入れる</label>
    <label class="ck"><input type="checkbox" id="rptAi"${aiOk?'':' disabled'}> AI の説明文を入れる${aiOk?'（遅れている現場ごとに AI を呼びます）':'（AI による文章化が無効のため使えません）'}</label>
    <div class="btns" style="margin-top:10px"><button class="btn" id="rptGo">作成して印刷</button><button class="btn ghost" id="rptCancel">閉じる</button></div></div>`;
  $('#rptCancel').onclick=()=>{ el.hidden=true; };
  $('#rptGo').onclick=async()=>{ const o={recovery:$('#rptRec').checked, all:$('#rptAll').checked, ai:$('#rptAi').checked}; el.hidden=true; await meetingReport(o); };
}

/* ---- 組み込み：タブ・ポートフォリオ ---- */
const _rdp=renderDock;
renderDock=function(){ _rdp(); const s=byId(state.sel);
  if(!s&&!PRESENT){ const h=$('#dockBody .card h3'); if(h&&!$('#rptBtn')) h.insertAdjacentHTML('beforeend','<button class="btn ghost" id="rptBtn">📄 会議資料（PDF）</button>');
    const b=$('#rptBtn'); if(b) b.onclick=e=>{ e.stopPropagation(); openReportDialog(); };
    const card=document.createElement('div'); card.className='card'; card.style.marginTop='12px'; card.innerHTML=`<h3>工種別の比較 <small>総合評価部向け・${esc(scopeName())}</small></h3>${kindSummaryHTML()}`; $('#dockBody').appendChild(card); } };

