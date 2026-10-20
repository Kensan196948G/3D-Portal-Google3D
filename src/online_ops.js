/* =====================================================================
   9f. 運用（サーバ版：データベースに保存）
   - 配船計画：作業船ごとの割り当て（重なりはサーバが 409 で止める）・稼働率・海上工事の必要隻数との照合
   - 深浅測量の時系列：測量日ごとの海底を、ワールドモデルと同じ計画面・同じメッシュ法で比べる（取り残し・余掘り）
   - 協議記録（漁協・港湾管理者など）と、地図に重ねる作業区域・航路
   - 説明モード（発注者・漁協向け）では協議記録・配船・測量の比較は表示しない（区域・航路の線だけを出す）
   ===================================================================== */
const OPS=Object.assign({assignments:[],surveys:[],consultations:[],mapFeatures:[]},
  SRV?{assignments:GEO.assignments||[],surveys:GEO.surveys||[],consultations:GEO.consultations||[],mapFeatures:GEO.mapFeatures||[]}:{});
const STOL=Object.assign({dredgeOver:.5,dredgeTol:.1,fillTol:.3},(GEO.marine&&GEO.marine.surveyTolerance)||{});   // 出来形の許容（サンプル値）
const byKey=k=>SITES.find(s=>s.key===k);
let FLEET=VESSELS.map(v=>({id:v.id,name:v.name,type:v.type,source:v.source||'demo',site:v.site}));   // 配船計画の対象（地図の作業船とは別に持つ：登録直後の船も載せる）
const isoOf=d=>new Date(Math.floor(d)*DAY).toISOString().slice(0,10);
const todayN=()=>dn(localISO(new Date()));
const srvOnly=what=>`<div class="card"><h3>${what}</h3><p class="hint">この機能はサーバ版（ログイン・データベース）で使えます。開発用の静的な配信では保存できないため表示しません。</p></div>`;
const roBadge=()=>CAN_EDIT?'':'<span class="badge" style="margin-left:6px">閲覧のみ</span>';
async function opsReload(){ const j=await api('GET','api/operations');
  OPS.assignments=j.assignments; OPS.surveys=j.surveys; OPS.consultations=j.consultations; OPS.mapFeatures=j.mapFeatures;
  FLEET=j.vessels.map(v=>({id:v.id,name:v.name,type:v.type,source:v.source,site:v.site}));
  zonesDirty=true; }
const fld=(lab,html)=>`<label>${lab}</label>${html}`;
const inS='background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 6px;width:100%;text-align:left';

/* =================== 配船計画 =================== */
const VTYPE={grab:'グラブ浚渫船',pump:'ポンプ浚渫船',barge:'土運船',pusher:'押船・引船',crane:'起重機船',other:'その他'};
const VSRC={demo:'デモ（架空）',manual:'自社・傭船（登録）',ais:'AIS'};
const MAIN_T=['grab','pump'], HAUL_T=['barge'];      // 海上工事の編成：浚渫・積込＝p.ex 隻、運搬＝p.trucks 隻
function fleetNeed(s){   // 海上工事の土工（浚渫・埋立）の予測期間と、ワールドモデルの編成の隻数
  if(!s.k.marine||s.earthIdx<0) return null; const f=s.cur.fc[s.earthIdx], t=s.tasks[s.earthIdx];
  if(t.a>=1) return null; return {S:Math.max(f.S,todayN()),F:f.F,ex:s.p.ex,haul:s.p.trucks,task:t.n}; }
function fleetCover(s,need){   // 必要期間の日ごとに、この現場へ割り当てた船の隻数を数えて不足日を出す
  const A=OPS.assignments.filter(a=>a.site_key===s.key), vt=id=>(FLEET.find(v=>v.id===id)||{}).type;
  let shortMain=0, shortHaul=0, days=0;
  for(let d=need.S; d<=need.F; d++){ days++; const on=A.filter(a=>dn(a.start_date)<=d&&dn(a.end_date)>=d);
    if(on.filter(a=>MAIN_T.includes(vt(a.vessel_id))).length<need.ex) shortMain++; if(on.filter(a=>HAUL_T.includes(vt(a.vessel_id))).length<need.haul) shortHaul++; }
  return {days,shortMain,shortHaul}; }
function utilization(vid,t0,t1){ const on=new Set();
  for(const a of OPS.assignments) if(a.vessel_id===vid) for(let d=Math.max(t0,dn(a.start_date)); d<=Math.min(t1,dn(a.end_date)); d++) on.add(d);
  return on.size/(t1-t0+1); }
function fleetGanttSVG(s){
  const T=todayN(), t0=T-30, t1=T+180, W=900, LW=210, RW=70, RH=22, Tp=24, vs=FLEET, need=fleetNeed(s);
  const H=Tp+(vs.length+(need?1:0))*RH+8, X=d=>LW+(clamp(d,t0,t1)-t0)/(t1-t0)*(W-LW-RW);
  let h=`<svg class="chart" viewBox="0 0 ${W} ${H}">`+monthTicks(t0,t1,X,Tp-6,H-4,1)+`<line x1="${X(T)}" x2="${X(T)}" y1="${Tp-6}" y2="${H-4}" stroke="#fde68a" stroke-dasharray="3 3"/>`
    +`<text x="${W-4}" y="${Tp-10}" font-size="10" fill="#93a1bd" text-anchor="end">稼働率（今後180日）</text>`;
  let y=Tp;
  if(need){ h+=`<text x="6" y="${y+14}" font-size="11" fill="#fde68a">この現場の必要期間（予測）</text><rect x="${X(need.S)}" y="${y+5}" width="${Math.max(2,X(need.F)-X(need.S))}" height="10" rx="3" fill="none" stroke="#fde68a" stroke-dasharray="4 2"/>`; y+=RH; }
  for(const v of vs){ const u=utilization(v.id,T,T+179);
    h+=`<text x="6" y="${y+14}" font-size="11" fill="#e2e8f0">${esc(v.name.length>15?v.name.slice(0,15)+'…':v.name)}</text><text x="${LW-6}" y="${y+14}" font-size="9" fill="#64748b" text-anchor="end">${esc(VSRC[v.source]||v.source)}</text>`;
    for(const a of OPS.assignments.filter(a=>a.vessel_id===v.id)){ const S=dn(a.start_date), F=dn(a.end_date); if(F<t0||S>t1) continue; const st=byKey(a.site_key), mine=a.site_key===s.key;
      h+=`<rect x="${X(S)}" y="${y+4}" width="${Math.max(2,X(F+1)-X(S))}" height="13" rx="3" fill="${st?st.color:'#64748b'}" fill-opacity="${mine?.95:.45}" stroke="${mine?'#fff':'none'}"><title>${esc(st?st.name:a.masked?'他支店の現場（閲覧範囲外）':a.site_key)}：${a.start_date} 〜 ${a.end_date}${a.role?'（'+esc(a.role)+'）':''}</title></rect>`
        +(X(F+1)-X(S)>60?`<text x="${X(S)+4}" y="${y+14}" font-size="9.5" fill="#fff">${esc(st?st.port:a.masked?'他支店':a.site_key)}</text>`:''); }
    h+=`<text x="${W-6}" y="${y+14}" font-size="11" fill="${u>.85?'#fca5a5':u<.3?'#94a3b8':'#86efac'}" text-anchor="end">${Math.round(u*100)}%</text>`; y+=RH; }
  return h+'</svg>'; }
function renderFleetTab(s){
  const body=$('#dockBody'); if(!SRV){ body.innerHTML=srvOnly('配船計画'); return; }
  const need=fleetNeed(s), cov=need?fleetCover(s,need):null, mine=OPS.assignments.filter(a=>a.site_key===s.key).sort((a,b)=>a.start_date.localeCompare(b.start_date));
  const demo=FLEET.length&&FLEET.every(v=>v.source==='demo');
  body.innerHTML=`<div class="card"><h3>配船計画 <small>作業船ごとの割り当て（全現場）・枠の白い線はこの現場</small>${roBadge()}</h3>${fleetGanttSVG(s)}
      <div class="note">${demo?'<b>作業船はすべてデモ（架空）です。</b>実際の自社船・傭船は管理者が下の「作業船の登録」から登録してください。':''}稼働率＝今日から180日のうち割り当てのある日の割合。同じ船を同じ期間に2つの現場へ割り当てることはできません（保存時にサーバが止めます）。</div></div>
    <div class="g2" style="margin-top:12px"><div class="card"><h3>この現場の割り当て</h3>
      ${need?`<p class="hint" style="margin:0 0 6px">「${esc(need.task)}」の予測 ${ds(need.S)}〜${ds(need.F)}（${cov.days}日）。ワールドモデルの編成：浚渫・積込 ${need.ex} 隻、運搬（土運船）${need.haul} 隻。
        <br>割り当ての不足：浚渫・積込 <b class="${cov.shortMain?'late':'ahead'}">${cov.shortMain}日</b>／運搬 <b class="${cov.shortHaul?'late':'ahead'}">${cov.shortHaul}日</b></p>`
        :`<p class="hint" style="margin:0 0 6px">${s.k.marine?'海上の土工は完了しています。':'陸上の工事です（重機の編成はワールドモデルのタブで扱います）。作業船を使う場合は割り当てられます。'}</p>`}
      ${mine.length?`<table class="t"><tr><th>作業船</th><th>期間</th><th>役割</th>${CAN_EDIT?'<th></th>':''}</tr>${mine.map(a=>{ const v=FLEET.find(x=>x.id===a.vessel_id);
        return `<tr><td>${esc(v?v.name:a.vessel_id)}</td><td class="nw">${a.start_date.replace(/-/g,'/')} 〜 ${a.end_date.replace(/-/g,'/')}</td><td>${esc(a.role||'')}</td>${CAN_EDIT?`<td class="nw"><button class="btn ghost" data-aedit="${a.id}">編集</button><button class="btn ghost" data-adel="${a.id}">削除</button></td>`:''}</tr>`; }).join('')}</table>`:'<p class="hint">割り当てはまだありません。</p>'}</div>
    <div class="card">${CAN_EDIT?`<h3 id="asgHead">割り当ての追加</h3><div class="form" style="grid-template-columns:auto 1fr">
        ${fld('作業船',`<select id="asgV" style="${inS}">${FLEET.map(v=>`<option value="${esc(v.id)}">${esc(v.name)}（${esc(VTYPE[v.type]||v.type)}・${esc(VSRC[v.source]||v.source)}）</option>`).join('')}</select>`)}
        ${fld('開始日',`<input type="date" id="asgS" value="${isoOf(need?need.S:todayN())}" style="${inS}">`)}${fld('終了日',`<input type="date" id="asgE" value="${isoOf(need?Math.min(need.F,need.S+60):todayN()+30)}" style="${inS}">`)}
        ${fld('役割',`<input id="asgR" maxlength="40" placeholder="浚渫・土砂運搬・据付 など" style="${inS}">`)}${fld('メモ',`<input id="asgN" maxlength="500" style="${inS}">`)}</div>
      <div class="btns" style="margin-top:6px"><button class="btn" id="asgSave">保存</button><button class="btn ghost" id="asgNew" hidden>新規に戻す</button><span class="hint" id="asgMsg"></span></div>`
      :'<h3>割り当ての追加</h3><p class="hint">閲覧者は変更できません（編集者・管理者が入力します）。</p>'}
      ${SRV.user.role==='admin'?`<h3 style="margin-top:14px">作業船の登録 <small>管理者：自社船・傭船</small></h3><div class="form" style="grid-template-columns:auto 1fr">
        ${fld('船名',`<input id="vName" maxlength="80" style="${inS}">`)}${fld('種類',`<select id="vType" style="${inS}">${Object.entries(VTYPE).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select>`)}
        ${fld('全長 m（任意）',`<input type="number" id="vLen" min="5" max="300" style="${inS}">`)}</div>
        <div class="btns" style="margin-top:6px"><button class="btn ghost" id="vAdd">登録（所属＝この現場）</button><span class="hint" id="vMsg"></span></div>`:''}</div></div>`;
  let editId=null;
  const msg=t=>{ const m=$('#asgMsg'); if(m) m.innerHTML=t; };
  if(CAN_EDIT){
    $('#asgSave').onclick=async()=>{ const b={vessel_id:$('#asgV').value,site_key:s.key,start_date:$('#asgS').value,end_date:$('#asgE').value,role:$('#asgR').value.trim()||null,note:$('#asgN').value.trim()||null};
      try{ await api(editId?'PUT':'POST',editId?`api/assignments/${editId}`:'api/assignments',b); await opsReload(); renderFleetTab(s); toast('配船計画を保存しました。',3000); }
      catch(e){ msg(`<span class="late">${esc(e.message)}</span>${e.data&&e.data.conflicts?'<br>'+e.data.conflicts.map(c=>`・${esc(c.masked?'他支店の現場（閲覧範囲外）':(byKey(c.site_key)||{}).name||c.site_key)} ${c.start_date}〜${c.end_date}`).join('<br>'):''}`); } };
    $('#asgNew').onclick=()=>renderFleetTab(s);
    body.querySelectorAll('[data-adel]').forEach(b=>b.onclick=async()=>{ if(!confirm('この割り当てを削除しますか？（記録は残ります）')) return;
      try{ await api('DELETE',`api/assignments/${b.dataset.adel}`); await opsReload(); renderFleetTab(s); }catch(e){ toast(esc(e.message),6000); } });
    body.querySelectorAll('[data-aedit]').forEach(b=>b.onclick=()=>{ const a=OPS.assignments.find(x=>x.id===+b.dataset.aedit); if(!a) return; editId=a.id;
      $('#asgV').value=a.vessel_id; $('#asgS').value=a.start_date; $('#asgE').value=a.end_date; $('#asgR').value=a.role||''; $('#asgN').value=a.note||''; $('#asgHead').textContent='割り当ての変更'; $('#asgNew').hidden=false; });
  }
  if($('#vAdd')) $('#vAdd').onclick=async()=>{ try{ await api('POST','api/vessels/manual',{name:$('#vName').value.trim(),type:$('#vType').value,site_key:s.key,len:+$('#vLen').value||null});
      await opsReload(); renderFleetTab(s); toast('作業船を登録しました（地図の作業船レイヤーには読み込み直し後に出ます）。',6000); }catch(e){ $('#vMsg').textContent=e.message; } };
}

/* =================== 深浅測量の時系列 =================== */
// 測量の海底（T.P.）から、ワールドモデルと同じ式で計画面を作り、同じメッシュ法で土量を出す（台帳の測量なら WM の土量と一致する）
function surveyModel(s,tp){
  const g=s.g, {w,d}=s.area, mD=s.k.mD, W=g.nx+1, A=g.dx*g.dz, E=new Float32Array(g.nv), D=new Float32Array(g.nv), cell=new Float32Array(g.nx*g.nz);
  for(let k=0;k<g.nv;k++){ const x=g.LX[k], z=g.LZ[k], ed=Math.min(w/2-Math.abs(x), d/2-Math.abs(z));
    E[k]=lerp(sampleCtx(s,x,z), tp[k], sm(ed/8))-s.yRef; D[k]=lerp(E[k], coreAt(s,x,z), sm(ed/mD)); }
  let Vc=0, Vf=0;
  for(let j=0;j<g.nz;j++) for(let i=0;i<g.nx;i++){ let P=0,N=0,sum=0;
    for(const k of [j*W+i,j*W+i+1,(j+1)*W+i,(j+1)*W+i+1]){ const v=E[k]-D[k]; sum+=v; if(v>0)P+=v; else N-=v; }
    cell[j*g.nx+i]=sum/4; if(P+N<1e-9) continue; Vc+=A/4*P*P/(P+N); Vf+=A/4*N*N/(P+N); }
  return {E,D,cell,Vc,Vf,remain:isFill(s)?Vf:Vc}; }
const SV={cache:{}, a:'ledger', b:null, view:'class'};
async function surveyTP(id){ if(id==='ledger') return null; if(SV.cache[id]) return SV.cache[id];
  const r=await api('GET',`api/surveys/${id}`); return SV.cache[id]=decI16(r.grid); }
const isFill=s=>s.kind==='landfill';
function classify(s,v){   // セルの (現況−計画) の平均 m → 区分
  if(isFill(s)) return v<-STOL.fillTol?['不足','#f97316']:v>STOL.fillTol?['過盛り','#a855f7']:['適正','#22c55e'];
  return v>STOL.dredgeTol?['取り残し','#ef4444']:v<-STOL.dredgeOver?['余掘り超過','#a855f7']:['適正','#22c55e']; }
function gridSVG(s,vals,colorOf,W=440){
  const g=s.g, cw=W/g.nx, H=Math.round(cw*g.nz*(g.dz/g.dx)), ch=H/g.nz;
  let h=`<svg class="chart" viewBox="0 0 ${W} ${H+16}"><text x="0" y="10" font-size="9.5" fill="#93a1bd">北 ↑</text><g transform="translate(0,14)">`;
  for(let j=0;j<g.nz;j++) for(let i=0;i<g.nx;i++){ const c=colorOf(vals[j*g.nx+i]); h+=`<rect x="${(i*cw).toFixed(1)}" y="${(j*ch).toFixed(1)}" width="${(cw+.4).toFixed(1)}" height="${(ch+.4).toFixed(1)}" fill="${c}"/>`; }
  return h+'</g></svg>'; }
function surveyList(s){ return [{id:'ledger',surveyed_on:null,label:`台帳の測量（架空・${s.terr.src||'初期'}）`},...OPS.surveys.filter(x=>x.site_key===s.key).map(x=>({...x,label:`${x.surveyed_on.replace(/-/g,'/')} ${x.src||''}`}))]; }
async function renderSurveyTab(s){
  const body=$('#dockBody');
  if(!s.k.marine||!s.terr.E){ body.innerHTML='<div class="card"><p class="hint">深浅測量の比較は海上工事（浚渫・海面埋立）の現場だけです。</p></div>'; return; }
  if(!SRV){ body.innerHTML=srvOnly('深浅測量の時系列'); return; }
  const list=surveyList(s); if(!list.some(x=>String(x.id)===String(SV.a))) SV.a='ledger';
  if(SV.b==null||!list.some(x=>String(x.id)===String(SV.b))) SV.b=list[list.length-1].id;
  const ledgerTP=decI16(s.terr.E), base=surveyModel(s,ledgerTP), st=tideStation(s), dlTP=st&&st.msl_tp!=null?(st.msl_tp-st.msl_dl)/100:null;
  const opt=sel=>list.map(x=>`<option value="${x.id}"${String(x.id)===String(sel)?' selected':''}>${esc(x.label)}</option>`).join('');
  body.innerHTML=`<div class="g2"><div class="card"><h3>出来形の推移 <small>測量日ごとの残り土量（${isFill(s)?'埋立の不足':'浚渫の取り残し'}）</small>${roBadge()}</h3><div id="svSeries"><p class="hint">計算しています…</p></div>
      <div class="note">土量は計画面（${isFill(s)?'計画天端':'計画水深'} T.P.${s.FH>=0?'+':''}${s.FH.toFixed(1)}m、端部はワールドモデルと同じすり付け）との差をメッシュ法で求めています。台帳の測量はワールドモデルの土量と同じ値になります。</div></div>
    <div class="card"><h3>比べる測量</h3><div class="form" style="grid-template-columns:auto 1fr">${fld('前（A）',`<select id="svA" style="${inS}">${opt(SV.a)}</select>`)}${fld('後（B）',`<select id="svB" style="${inS}">${opt(SV.b)}</select>`)}</div>
      <div class="btns" style="margin-top:6px"><button class="btn ${SV.view==='class'?'':'ghost'}" data-svv="class">B の出来形（色分け）</button><button class="btn ${SV.view==='diff'?'':'ghost'}" data-svv="diff">A→B の変化</button></div>
      <div id="svMap" style="margin-top:8px"></div><div id="svLeg" class="hleg" style="gap:10px;flex-wrap:wrap"></div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="svAdopt">B の海底で土量・工程を計算し直す（この画面だけ）</button></div>
      <div class="note">「計算し直す」は表示中のこの画面だけです（保存せず、他の人の画面は変わりません）。基準（初期計画）の予測も B の海底で作り直します。読み込み直すと台帳の測量に戻ります。</div></div></div>
    ${CAN_EDIT?`<div class="card" style="margin-top:12px"><h3>深浅測量の登録 <small>XYZ／CSV：経度,緯度,値 ／ 東m,北m,値（現場の中心から）</small></h3>
      <div class="form" style="grid-template-columns:auto 1fr auto 1fr">${fld('測量日',`<input type="date" id="svDate" value="${localISO(new Date())}" style="${inS}">`)}
        ${fld('値の種類',`<select id="svKind" style="${inS}"><option value="tp">標高（T.P.）</option><option value="dl">標高（DL＝潮位表基準面）</option><option value="depth">水深（DL から下向きに正）</option></select>`)}
        ${fld('DL の T.P. 高さ m',`<input type="number" step="0.01" id="svDl" value="${dlTP!=null?dlTP.toFixed(2):''}" placeholder="${dlTP!=null?'':'公表値が無いため入力が必要'}" style="${inS}">`)}
        ${fld('ファイル',`<input type="file" id="svFile" accept=".csv,.xyz,.txt,text/plain" style="${inS}">`)}</div>
      <div class="btns" style="margin-top:6px"><button class="btn" id="svUp">取り込んで登録</button><span class="hint" id="svMsg"></span></div>
      <div class="note">DL の T.P. 高さの初期値は ${st?`${esc(st.name)}の潮位表（${st.msl_tp!=null?'MSL の標高 − MSL の DL からの高さ':'MSL の標高が未公表のため空欄'}）`:'潮位表の地点が無いため空欄'}です。測量会社の成果に記載の値があれば、そちらを使ってください。平面直角座標系の成果は経度・緯度に変換してから取り込んでください。</div></div>`:''}`;
  const series=[]; for(const x of list){ try{ const tp=x.id==='ledger'?ledgerTP:await surveyTP(x.id); series.push({...x,m:x.id==='ledger'?base:surveyModel(s,tp)}); }catch(e){ series.push({...x,err:e.message}); } }
  if(state.sel!==s.id||state.tab!=='survey') return;
  const r0=base.remain;
  $('#svSeries').innerHTML=`<table class="t"><tr><th>測量</th><th class="n">残り土量 m³</th><th class="n">出来高（測量）</th><th class="n">${isFill(s)?'過盛り':'余掘り'} m³</th>${CAN_EDIT?'<th></th>':''}</tr>${series.map(x=>x.err?`<tr><td>${esc(x.label)}</td><td colspan="3" class="late">${esc(x.err)}</td></tr>`
      :`<tr><td>${esc(x.label)}</td><td class="n">${fmtN(x.m.remain)}</td><td class="n">${Math.round((1-x.m.remain/Math.max(1,r0))*100)}%</td><td class="n">${fmtN(isFill(s)?x.m.Vc:x.m.Vf)}</td>${CAN_EDIT?`<td>${x.id==='ledger'?'':`<button class="btn ghost" data-svdel="${x.id}">削除</button>`}</td>`:''}</tr>`).join('')}</table>
    <div class="note">実績入力の出来高（「${esc(s.tasks[s.earthIdx].n)}」）：${Math.round(s.tasks[s.earthIdx].a*100)}%。測量の出来高と離れている場合は、実績入力か測量の範囲を確認してください。</div>`;
  body.querySelectorAll('[data-svdel]').forEach(b=>b.onclick=async()=>{ if(!confirm('この測量を一覧から外しますか？（記録は残ります）')) return;
    try{ await api('DELETE',`api/surveys/${b.dataset.svdel}`); await opsReload(); renderSurveyTab(s); }catch(e){ toast(esc(e.message),6000); } });
  const pick=id=>series.find(x=>String(x.id)===String(id));
  const draw=()=>{ const A=pick(SV.a), Bv=pick(SV.b); if(!A||!Bv||A.err||Bv.err){ $('#svMap').innerHTML='<p class="hint">測量を読み込めませんでした。</p>'; return; }
    if(SV.view==='class'){ const cnt={}; for(const v of Bv.m.cell){ const [n]=classify(s,v); cnt[n]=(cnt[n]||0)+1; }
      $('#svMap').innerHTML=gridSVG(s,Bv.m.cell,v=>classify(s,v)[1]);
      const keys=isFill(s)?[['不足','#f97316'],['適正','#22c55e'],['過盛り','#a855f7']]:[['取り残し','#ef4444'],['適正','#22c55e'],['余掘り超過','#a855f7']];
      $('#svLeg').innerHTML=keys.map(([n,c])=>`<span><i class="wc-sw" style="background:${c}"></i>${n} ${Math.round((cnt[n]||0)/Bv.m.cell.length*100)}%</span>`).join('')
        +`<span class="hint">許容（サンプル値）：${isFill(s)?`±${STOL.fillTol}m`:`取り残し +${STOL.dredgeTol}m・余掘り ${STOL.dredgeOver}m`}</span>`; }
    else { const g=s.g, ch=new Float32Array(g.nx*g.nz); let up=0, dnv=0; const A4=g.dx*g.dz;
      for(let j=0;j<g.nz;j++) for(let i=0;i<g.nx;i++){ let v=0; for(const k of [j*(g.nx+1)+i,j*(g.nx+1)+i+1,(j+1)*(g.nx+1)+i,(j+1)*(g.nx+1)+i+1]) v+=Bv.m.E[k]-A.m.E[k]; v/=4; ch[j*g.nx+i]=v; if(v>0) up+=v*A4; else dnv-=v*A4; }
      const col=v=>{ const a=Math.min(1,Math.abs(v)/2); return v<-.05?`rgba(37,99,235,${.25+.75*a})`:v>.05?`rgba(180,83,9,${.25+.75*a})`:'#1e293b'; };
      $('#svMap').innerHTML=gridSVG(s,ch,col);
      $('#svLeg').innerHTML=`<span><i class="wc-sw" style="background:#2563eb"></i>深くなった ${fmtN(dnv)} m³</span><span><i class="wc-sw" style="background:#b45309"></i>浅くなった ${fmtN(up)} m³</span><span class="hint">色の濃さ：変化 2m で最大</span>`; } };
  draw();
  $('#svA').onchange=e=>{ SV.a=e.target.value; draw(); }; $('#svB').onchange=e=>{ SV.b=e.target.value; draw(); };
  body.querySelectorAll('[data-svv]').forEach(b=>b.onclick=()=>{ SV.view=b.dataset.svv; body.querySelectorAll('[data-svv]').forEach(x=>x.classList.toggle('ghost',x.dataset.svv!==SV.view)); draw(); });
  $('#svAdopt').onclick=()=>{ const Bv=pick(SV.b); if(!Bv||Bv.err) return; if(!confirm(`「${Bv.label}」の海底で土量と工程（初期計画を含む）を計算し直します。この画面だけで、保存はしません。よろしいですか？`)) return;
    const g=s.g; g.E.set(Bv.m.E); s.terr.src=Bv.id==='ledger'?s.terr.src:`深浅測量 ${Bv.surveyed_on}（この画面だけ）`;
    buildDesign(s); calibrate(s); s.base=simulate(s,s.p0); resim(s); designDirty(s); terrainDirty=true; renderLedger(); renderSummary(); renderSurveyTab(s);
    toast(`${esc(Bv.label)} の海底で計算し直しました（この画面だけ）。`,6000); };
  if($('#svUp')) $('#svUp').onclick=async()=>{ const m=$('#svMsg'); try{
      const f=$('#svFile').files[0]; if(!f) throw new Error('ファイルを選んでください');
      const kind=$('#svKind').value, dl=parseFloat($('#svDl').value);
      if(kind!=='tp'&&!Number.isFinite(dl)) throw new Error('DL 基準の値には DL の T.P. 高さが必要です');
      m.textContent='格子に変換しています…'; const r=surveyGrid(s,await f.text(),kind,dl);
      const lo=Math.min(s.terr.emin,s.FH)-5, hi=Math.max(s.terr.emax,s.FH)+3;
      if(!(r.median>=lo&&r.median<=hi)) throw new Error(`海底の中央値が T.P.${r.median.toFixed(1)}m で、この現場の想定（T.P.${lo.toFixed(1)}〜${hi.toFixed(1)}m）を外れています。水深と標高の取り違え・基準面を確認してください`);
      if(!confirm(`測量日 ${$('#svDate').value}：${r.n} 点、格子の ${Math.round(r.cover*100)}% に点があります。海底の中央値 T.P.${r.median.toFixed(2)}m。登録しますか？`)){ m.textContent=''; return; }
      await api('POST','api/surveys',{site_key:s.key,surveyed_on:$('#svDate').value,datum:kind==='tp'?'TP':'DL',dl_tp_cm:kind==='tp'?null:Math.round(dl*1000)/10,nx:s.g.nx,nz:s.g.nz,grid:encI16(r.tp),npoints:r.n,src:f.name.slice(0,120)});
      await opsReload(); SV.b=null; m.textContent=''; renderSurveyTab(s); toast('深浅測量を登録しました。',4000);
    }catch(e){ m.innerHTML=`<span class="late">${esc(e.message||e)}</span>`; } };
}
function encI16(arr){ const b=new Uint8Array(arr.length*2), dv=new DataView(b.buffer);
  for(let i=0;i<arr.length;i++) dv.setInt16(i*2,Math.max(-32768,Math.min(32767,Math.round(arr[i]*10))),true);
  let t=''; for(let i=0;i<b.length;i+=0x8000) t+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000)); return btoa(t); }
// 点群 → 格子（各頂点の T.P. 高さ）。近い点の距離の重み付き平均（セル4つ分以内）、届かない頂点は最も近い点
function surveyGrid(s,text,kind,dl){
  const pts=[]; for(const line of text.split(/\r?\n/)){ const v=line.split(/[,\s\t]+/).filter(Boolean).map(Number); if(v.length>=3&&v.slice(0,3).every(Number.isFinite)) pts.push(v.slice(0,3)); }
  if(pts.length<20) throw new Error('点が少なすぎます（20点以上が必要）');
  const geo=pts.every(([a,b])=>Math.abs(a-s.lon)<1&&Math.abs(b-s.lat)<1);
  const toTP=h=>kind==='tp'?h:kind==='dl'?h+dl:-h+dl;
  const P=pts.map(([a,b,h])=>geo?[(a-s.lon)*111320*Math.cos(s.lat*Math.PI/180),-(b-s.lat)*110574,toTP(h)]:[a,-b,toTP(h)]);
  const g=s.g, cell=Math.max(g.dx,g.dz), R=cell*4, bins=new Map(), key=(x,z)=>Math.floor(x/R)+','+Math.floor(z/R);
  for(const p of P){ const k=key(p[0],p[1]); if(!bins.has(k)) bins.set(k,[]); bins.get(k).push(p); }
  const tp=new Float32Array(g.nv); let near=0;
  for(let k=0;k<g.nv;k++){ const x=g.LX[k], z=g.LZ[k], bx=Math.floor(x/R), bz=Math.floor(z/R); let sw=0, sh=0;
    for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++) for(const [px,pz,h] of bins.get((bx+a)+','+(bz+b))||[]){ const d=Math.hypot(px-x,pz-z); if(d<R){ const w=1/Math.max(.25,d*d); sw+=w; sh+=w*h; } }
    if(sw>0){ tp[k]=sh/sw; near++; }
    else { let bd=Infinity, bh=0; for(const [px,pz,h] of P){ const d=(px-x)**2+(pz-z)**2; if(d<bd){ bd=d; bh=h; } } tp[k]=bh; } }
  if(near<g.nv*.8) throw new Error(`施工範囲の ${Math.round(near/g.nv*100)}% にしか点がありません（80% 以上が必要。座標の形式・位置を確認してください）`);
  const srt=Float64Array.from(tp).sort();
  return {tp,n:pts.length,cover:near/g.nv,median:srt[srt.length>>1],geo}; }

/* =================== 協議記録・作業区域と航路 =================== */
const PARTIES=['漁協','港湾管理者','海上保安部','発注者','地元','その他'];
const ZKIND={work_area:['作業区域','#f59e0b'],channel:['航路（手入力）','#38bdf8'],fishing:['漁業の区域','#22c55e'],restricted:['立入禁止・注意','#ef4444'],other:['その他','#a78bfa']};
function renderConsultTab(s){
  const body=$('#dockBody'); if(!SRV){ body.innerHTML=srvOnly('協議記録・作業区域と航路'); return; }
  const list=OPS.consultations.filter(c=>c.site_key===s.key), zs=OPS.mapFeatures.filter(f=>f.site_key===s.key);
  body.innerHTML=`<div class="g2"><div class="card"><h3>協議記録 <small>漁協・港湾管理者・海上保安部など</small>${roBadge()}</h3>
      ${list.length?`<table class="t"><tr><th>日付</th><th>相手先</th><th>内容・合意事項</th><th>宿題</th><th>状態</th>${CAN_EDIT?'<th></th>':''}</tr>${list.map(c=>`<tr><td class="nw">${c.held_on.replace(/-/g,'/')}</td><td class="nw">${esc(c.party)}</td>
        <td><div>${esc(c.summary)}</div>${c.agreements?`<div class="hint">合意：${esc(c.agreements)}</div>`:''}${c.attendees?`<div class="hint">出席：${esc(c.attendees)}</div>`:''}</td><td>${esc(c.followups||'')}</td>
        <td class="nw"><span class="badge ${c.status==='完了'?'ok':'warn'}" style="margin-left:0">${esc(c.status)}</span></td>${CAN_EDIT?`<td class="nw"><button class="btn ghost" data-cedit="${c.id}">編集</button><button class="btn ghost" data-cdel="${c.id}">削除</button></td>`:''}</tr>`).join('')}</table>`
        :'<p class="hint">協議記録はまだありません。</p>'}
      ${CAN_EDIT?`<h3 id="conHead" style="margin-top:12px">協議記録の追加</h3><div class="form" style="grid-template-columns:auto 1fr">
        ${fld('日付',`<input type="date" id="cDate" value="${localISO(new Date())}" style="${inS}">`)}${fld('相手先',`<select id="cParty" style="${inS}">${PARTIES.map(p=>`<option>${p}</option>`).join('')}</select>`)}
        ${fld('出席者（組織・役職まで）',`<input id="cAtt" maxlength="300" placeholder="例：○○漁協 組合長・理事／当社 所長" style="${inS}">`)}
        ${fld('協議の内容',`<textarea id="cSum" rows="2" maxlength="2000" style="${inS}"></textarea>`)}${fld('合意事項',`<textarea id="cAgr" rows="2" maxlength="2000" style="${inS}"></textarea>`)}
        ${fld('宿題・次回まで',`<input id="cFol" maxlength="1000" style="${inS}">`)}${fld('状態',`<select id="cSt" style="${inS}"><option>対応中</option><option>完了</option></select>`)}</div>
        <div class="btns" style="margin-top:6px"><button class="btn" id="cSave">保存</button><button class="btn ghost" id="cNew" hidden>新規に戻す</button><span class="hint" id="cMsg"></span></div>
        <div class="note">個人の氏名・電話番号・メールアドレスは書かないでください（組織・役職まで）。記録は削除しても消えません（一覧から外れるだけ）。</div>`:''}</div>
    <div class="card"><h3>作業区域・航路 <small>地図に重ねる線・面（「区域・航路」レイヤー）</small></h3>
      ${zs.length?`<table class="t"><tr><th>種類</th><th>名前</th><th class="n">点</th>${CAN_EDIT?'<th></th>':''}</tr>${zs.map(f=>`<tr><td class="nw"><i class="wc-sw" style="background:${(ZKIND[f.kind]||ZKIND.other)[1]}"></i> ${esc((ZKIND[f.kind]||ZKIND.other)[0])}</td><td>${esc(f.name)}</td>
        <td class="n">${(f.geometry.type==='Polygon'?f.geometry.coordinates[0].length-1:f.geometry.coordinates.length)}</td>${CAN_EDIT?`<td><button class="btn ghost" data-zdel="${f.id}">削除</button></td>`:''}</tr>`).join('')}</table>`:'<p class="hint">区域・航路はまだありません。</p>'}
      ${CAN_EDIT?`<div class="form" style="grid-template-columns:auto 1fr;margin-top:10px">${fld('種類',`<select id="zKind" style="${inS}">${Object.entries(ZKIND).map(([k,[n]])=>`<option value="${k}">${n}</option>`).join('')}</select>`)}
        ${fld('名前',`<input id="zName" maxlength="80" placeholder="例：浚渫の作業区域（北側）" style="${inS}">`)}</div>
        <div class="btns" style="margin-top:6px"><button class="btn ghost" data-draw="Polygon">面を描く</button><button class="btn ghost" data-draw="LineString">線を描く</button>
          <button class="btn" id="zDone" hidden>描き終える（保存）</button><button class="btn ghost" id="zCancel" hidden>やめる</button><span class="hint" id="zMsg"></span></div>
        <div class="note">真上からの表示に切り替えて、地図をクリックして点を置きます（海面の高さで位置を決めます）。航路は公的な航路図ではなく、協議に基づく手入力の線です。</div>`:''}
      <div class="note">説明モード（発注者・漁協向け）では、協議記録・配船・測量の比較は表示せず、区域・航路の線だけを出します。</div></div></div>`;
  if(!CAN_EDIT) return;
  let editId=null; const cm=t=>{ $('#cMsg').innerHTML=t; };
  $('#cSave').onclick=async()=>{ const b={site_key:s.key,held_on:$('#cDate').value,party:$('#cParty').value,attendees:$('#cAtt').value.trim()||null,summary:$('#cSum').value.trim(),
      agreements:$('#cAgr').value.trim()||null,followups:$('#cFol').value.trim()||null,status:$('#cSt').value};
    if(!b.summary){ cm('<span class="late">協議の内容を入力してください</span>'); return; }
    try{ await api(editId?'PUT':'POST',editId?`api/consultations/${editId}`:'api/consultations',b); await opsReload(); renderConsultTab(s); toast('協議記録を保存しました。',3000); }
    catch(e){ cm(`<span class="late">${esc(e.message)}</span>`); } };
  $('#cNew').onclick=()=>renderConsultTab(s);
  body.querySelectorAll('[data-cedit]').forEach(b=>b.onclick=()=>{ const c=OPS.consultations.find(x=>x.id===+b.dataset.cedit); if(!c) return; editId=c.id;
    $('#cDate').value=c.held_on; $('#cParty').value=c.party; $('#cAtt').value=c.attendees||''; $('#cSum').value=c.summary; $('#cAgr').value=c.agreements||''; $('#cFol').value=c.followups||''; $('#cSt').value=c.status;
    $('#conHead').textContent='協議記録の変更'; $('#cNew').hidden=false; $('#cSum').focus(); });
  body.querySelectorAll('[data-cdel]').forEach(b=>b.onclick=async()=>{ if(!confirm('この協議記録を一覧から外しますか？（記録は残ります）')) return;
    try{ await api('DELETE',`api/consultations/${b.dataset.cdel}`); await opsReload(); renderConsultTab(s); }catch(e){ toast(esc(e.message),6000); } });
  body.querySelectorAll('[data-zdel]').forEach(b=>b.onclick=async()=>{ if(!confirm('この区域・航路を地図から外しますか？（記録は残ります）')) return;
    try{ await api('DELETE',`api/map-features/${b.dataset.zdel}`); await opsReload(); renderConsultTab(s); }catch(e){ toast(esc(e.message),6000); } });
  body.querySelectorAll('[data-draw]').forEach(b=>b.onclick=()=>drawStart(s,b.dataset.draw));
  $('#zCancel').onclick=()=>drawStop();
  $('#zDone').onclick=async()=>{ const n=DRAW.pts.length, poly=DRAW.type==='Polygon';
    if(n<(poly?3:2)){ $('#zMsg').textContent=`点が足りません（${poly?'面は3点':'線は2点'}以上）`; return; }
    const name=$('#zName').value.trim(); if(!name){ $('#zMsg').textContent='名前を入力してください'; return; }
    const co=DRAW.pts.map(p=>[p.lon,p.lat]);
    try{ await api('POST','api/map-features',{site_key:s.key,kind:$('#zKind').value,name,geometry:poly?{type:'Polygon',coordinates:[co]}:{type:'LineString',coordinates:co}});
      drawStop(); state.layers.zones=true; await opsReload(); renderTools(); renderConsultTab(s); toast('区域・航路を保存しました。',3000); }
    catch(e){ $('#zMsg').textContent=e.message; } };
}

/* ---- 地図への描画（区域・航路）と、描くときのクリック ---- */
let zonesDirty=true; const ZN={ents:[]};
const seaH=s=>(GEOID0[s&&s.pref]??36)+1;   // 海面（ジオイド高）の少し上。作業船と同じ高さ
function zonesRender(){ if(!G.viewer) return; zonesDirty=false; const E=G.viewer.entities;
  for(const e of ZN.ents) E.remove(e); ZN.ents=[]; if(!state.layers.zones) return;
  for(const f of OPS.mapFeatures){ const s=byKey(f.site_key), h=seaH(s), [nm,col]=ZKIND[f.kind]||ZKIND.other, c=C3.Color.fromCssColorString(col);
    const ring=f.geometry.type==='Polygon'?f.geometry.coordinates[0]:f.geometry.coordinates, pos=C3.Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lo,la])=>[lo,la,h]));
    if(f.geometry.type==='Polygon') ZN.ents.push(E.add({polygon:{hierarchy:pos,height:h,material:c.withAlpha(.22),perPositionHeight:false}}));
    ZN.ents.push(E.add({polyline:{positions:pos,width:f.kind==='channel'?4:2.5,material:f.kind==='channel'?new C3.PolylineDashMaterialProperty({color:c,dashLength:18}):c}}));
    const mid=ring.reduce((a,[lo,la])=>[a[0]+lo/ring.length,a[1]+la/ring.length],[0,0]);
    ZN.ents.push(E.add({position:C3.Cartesian3.fromDegrees(mid[0],mid[1],h+2),label:{text:`${f.name}`,font:'12px sans-serif',fillColor:C3.Color.WHITE,outlineColor:c.darken(.5,new C3.Color()),outlineWidth:3,
      style:C3.LabelStyle.FILL_AND_OUTLINE,distanceDisplayCondition:new C3.DistanceDisplayCondition(0,2.5e4),disableDepthTestDistance:Number.POSITIVE_INFINITY}})); } }
const DRAW={on:false,type:null,pts:[],ent:null,hd:null,s:null};
function drawStart(s,type){ if(!G.viewer){ toast('地図の準備ができていません。',4000); return; } drawStop(true);
  Object.assign(DRAW,{on:true,type,pts:[],s}); flySite(s,siteView(s,{pitch:1.53,yaw:0,ty:0}));
  const h=seaH(s), a=C3.Ellipsoid.WGS84.radii, ell=new C3.Ellipsoid(a.x+h,a.y+h,a.z+h);
  DRAW.hd=new C3.ScreenSpaceEventHandler(G.viewer.scene.canvas);
  DRAW.hd.setInputAction(e=>{ const c=G.camera.pickEllipsoid(e.position,ell); if(!c) return; const cg=C3.Cartographic.fromCartesian(c,ell);
    DRAW.pts.push({lon:C3.Math.toDegrees(cg.longitude),lat:C3.Math.toDegrees(cg.latitude)}); drawMsg(); },C3.ScreenSpaceEventType.LEFT_CLICK);
  DRAW.ent=G.viewer.entities.add({polyline:{positions:new C3.CallbackProperty(()=>{ const p=DRAW.pts.map(q=>C3.Cartesian3.fromDegrees(q.lon,q.lat,h));
    return DRAW.type==='Polygon'&&p.length>2?[...p,p[0]]:p; },false),width:3,material:C3.Color.fromCssColorString('#fde68a')}});
  $('#zDone').hidden=false; $('#zCancel').hidden=false; drawMsg(); }
function drawMsg(){ const m=$('#zMsg'); if(m) m.textContent=`${DRAW.type==='Polygon'?'面':'線'}を描いています：${DRAW.pts.length} 点（地図をクリック。Esc でやめる）`; }
function drawStop(keepUi){ if(DRAW.hd){ DRAW.hd.destroy(); DRAW.hd=null; } if(DRAW.ent&&G.viewer){ G.viewer.entities.remove(DRAW.ent); DRAW.ent=null; } DRAW.on=false; DRAW.pts=[];
  if(!keepUi){ const d=$('#zDone'), c=$('#zCancel'), m=$('#zMsg'); if(d) d.hidden=true; if(c) c.hidden=true; if(m) m.textContent=''; } }
window.addEventListener('keydown',e=>{ if(e.key==='Escape'&&DRAW.on) drawStop(); });

/* ---- タブ・レイヤーへの組み込み ---- */
state.layers.zones=true;
{ const _rt=renderTools; renderTools=function(){ _rt(); if(PRESENT&&!OPS.mapFeatures.length) return;
    if(OPS.mapFeatures.length||SRV) $('#layers').insertAdjacentHTML('beforeend',`<button data-layer="zones" class="${state.layers.zones?'on':''}" title="作業区域・航路（手入力）">区域・航路</button>`); };
  const _sl=setLayer; setLayer=function(k,on){ _sl(k,on); if(k==='zones') zonesDirty=true; };
  const _rl=renderLegend; renderLegend=function(){ _rl(); if(!state.layers.zones||!OPS.mapFeatures.length) return;
    const kinds=[...new Set(OPS.mapFeatures.map(f=>f.kind))]; $('#legend').insertAdjacentHTML('beforeend',kinds.map(k=>`<div><span class="sw" style="background:${(ZKIND[k]||ZKIND.other)[1]}"></span>${(ZKIND[k]||ZKIND.other)[0]}</div>`).join('')); };
  const _rd=renderDock; renderDock=function(){ if(DRAW.on&&state.tab!=='consult') drawStop(); _rd(); };
  const _sel=select; select=function(id,doFly){ if(DRAW.on) drawStop(); _sel(id,doFly); };
}
(function ztick(){ const f=()=>{ requestAnimationFrame(f); if(zonesDirty&&G.viewer) try{ zonesRender(); }catch(e){ console.warn(e); zonesDirty=false; } }; requestAnimationFrame(f); })();
