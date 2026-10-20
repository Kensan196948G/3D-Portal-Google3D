/* =====================================================================
   9h. 現場台帳の登録・編集（サーバ版：DB が正）
   - 全国表示の「＋ 現場を登録」、現場のサマリの「✎ 台帳を編集」から、右側の入力欄を開く
   - 位置は地図をクリック（真上からの表示に切り替える）か経度・緯度で、範囲は東西・南北の m で指定（向きは東西・南北のまま）
   - 所在地（国土地理院の逆ジオコーダ）・地形（標高タイル）を起動時と同じ取り方で確かめてから保存する
     （施工範囲に標高データの無い所があると、全員の起動で失敗の案内が出てしまうため）
   - 支店・港の名前は、近くの現場・潮位表の地点から候補を出す（決めるのは入力する人）
   - 保存したら画面を読み込み直す（地形・計算・3D を作り直すため）
   ===================================================================== */
const LEDGER=GEO.ledger||null;
const SF={el:null, mode:null, s:null, ent:null, checked:null, picking:false, timer:0};
const CFLD={title:'正式工事名',place:'工事場所',agency:'発注機関',agency_no:'案件番号',award_date:'落札決定日',contract_date:'契約締結日',period_start:'当初の工期（開始）',
  period_end:'当初の工期（終了）',changes:'変更契約',role:'受注区分',jv_name:'JV の名称',jv_members:'JV の構成員',sources:'出典',verify:'確認状態'};
const CROLES=['単独','JV代表','JVサブ','JV構成員（役割未確認）'], CSRC=['契約書','変更契約書','JV協定書','公表資料','社内の受注伝票','その他'];
// 契約工期の終わり：変更契約があれば最後の変更後、無ければ当初
const contractEnd=c=>{ if(!c) return null; const ch=(c.changes||[]).filter(x=>x.period_end); return ch.length?ch[ch.length-1].period_end:c.period_end||null; };
const FLD={name:'工事名',br:'支店',port:'港・地区',client:'発注者',ccat:'発注者の区分',kind:'工種',start:'着工日',soil:'土質',lon:'経度',lat:'緯度',w:'東西の幅',d:'南北の奥行',sea:'海側',design:'計画高',seabed:'いまの海底'};
const canLedger=()=>SRV&&CAN_EDIT&&LEDGER&&!PRESENT;
const myBranches=()=>{ const b=SRV&&SRV.user.branches; return Array.isArray(b)?b:Object.keys(LEDGER.branches); };
const inScopeBr=br=>myBranches().includes(br);
const defOf=s=>SITE_DEFS.find(d=>d.key===s.key)||{};
const sfVal=id=>{ const e=$('#sf_'+id); return e?e.value.trim():''; };
const sfNum=id=>{ const v=parseFloat(sfVal(id)); return Number.isFinite(v)?v:null; };
const isMarineKind=k=>!!(LEDGER&&LEDGER.kinds[k]&&LEDGER.kinds[k].marine);

function siteFormOpen(mode,s){
  if(!canLedger()) return; if(typeof DRAW!=='undefined'&&DRAW.on) drawStop();
  const d=s?defOf(s):{}, L=LEDGER, today=localISO(new Date());
  const v={name:s?s.name:'', br:s?s.br:(myBranches()[0]||''), port:s?s.port:'', client:s?s.client:'', ccat:s?s.ccat:L.ccats[0], kind:s?s.kind:'yard',
    start:d.start||today, soil:s?s.soil:'sand', lon:s?s.lon:'', lat:s?s.lat:'', w:s?s.area.w:120, d:s?s.area.d:80, sea:s?(s.sea||''):'',
    design:d.design??'', seabed:d.seabed??''};
  Object.assign(SF,{mode,s,checked:null});
  if(!SF.el){ SF.el=document.createElement('div'); SF.el.id='siteForm'; SF.el.className='siteForm'; document.body.appendChild(SF.el); }
  const opt=(o,cur)=>Object.entries(o).map(([k,n])=>`<option value="${esc(k)}"${k===cur?' selected':''}>${esc(n)}</option>`).join('');
  const brs=Object.fromEntries(myBranches().map(b=>[b,L.branches[b]||b]));
  const inp=(id,val,extra='')=>`<input id="sf_${id}" value="${esc(val??'')}" ${extra}>`;
  SF.el.hidden=false;
  SF.el.innerHTML=`<div class="sfHead"><b>${mode==='new'?'現場を登録':'台帳を編集'}</b>${s?`<span class="hint">${esc(s.id)}</span>`:''}<button class="btn ghost" id="sfClose">閉じる</button></div>
    <div class="sfBody">
      <div class="sfSec">位置と範囲</div>
      <div class="btns"><button class="btn" id="sfPick">${SF.picking?'クリック待ち…':'地図をクリックして中心を置く'}</button></div>
      <div class="form sfGrid"><label>経度</label>${inp('lon',v.lon,'type="number" step="0.00001"')}<label>緯度</label>${inp('lat',v.lat,'type="number" step="0.00001"')}
        <label>東西の幅 m</label>${inp('w',v.w,`type="number" min="${L.size.min}" max="${L.size.max}" step="1"`)}<label>南北の奥行 m</label>${inp('d',v.d,`type="number" min="${L.size.min}" max="${L.size.max}" step="1"`)}</div>
      <div id="sfCheck" class="sfCheck hint">位置を決めると、所在地と地形を自動で確かめます。</div>
      <div class="sfSec">工事</div>
      <div class="form sfGrid"><label>工事名</label>${inp('name',v.name,'maxlength="80"')}
        <label>工種</label><select id="sf_kind">${opt(Object.fromEntries(Object.entries(L.kinds).map(([k,x])=>[k,x.label])),v.kind)}</select>
        <label>支店</label><select id="sf_br">${opt(brs,v.br)}</select>
        <label>港・地区</label><div>${inp('port',v.port,'maxlength="40"')}<div id="sfPortHint" class="hint"></div></div>
        <label>発注者</label>${inp('client',v.client,'maxlength="80"')}
        <label>発注者の区分</label><select id="sf_ccat">${opt(Object.fromEntries(L.ccats.map(x=>[x,x])),v.ccat)}</select>
        <label>着工日</label>${inp('start',v.start,'type="date"')}
        <label>土質</label><select id="sf_soil">${opt(L.soils,v.soil)}</select>
        <label>海側</label><select id="sf_sea">${opt({'':'なし（陸の中）',N:'北',E:'東',S:'南',W:'西'},v.sea)}</select></div>
      <div id="sfMarine" class="form sfGrid"><label>計画高（T.P. m）</label>${inp('design',v.design,'type="number" step="0.1"')}
        <label>いまの海底（T.P. m）</label>${inp('seabed',v.seabed,'type="number" step="0.1"')}</div>
      <div id="sfMarineNote" class="note">海上工事は、深浅測量を登録するまで、いまの海底の高さで一様な「仮の海底」を使います。${s&&(defOf(s).survey||{}).src&&!/仮の海底/.test(defOf(s).survey.src)?'この現場は台帳の深浅測量があるため、位置・範囲は変えられません。':''}</div>
      ${mode==='edit'&&s.tasks.some(t=>t.a>0)?'<div class="note">実績が入力されている現場は、工種を変えられません（サーバが止めます）。</div>':''}
      ${contractHTML(s?defOf(s).contract:null)}
      <div class="btns" style="margin-top:10px"><button class="btn" id="sfSave">保存</button>${mode==='edit'?'<button class="btn ghost" id="sfArchive">完了にする（一覧から外す）</button>':''}</div>
      <div id="sfMsg" class="hint"></div>
      ${mode==='edit'?'<div class="sfSec">台帳の変更の履歴</div><div id="sfHist" class="hint">読み込んでいます…</div>':''}
      ${mode==='new'&&SRV.user.role==='admin'?'<div class="sfSec">完了した現場（管理者）</div><div id="sfArch" class="hint">読み込んでいます…</div>':''}
      <div class="note">保存すると画面を読み込み直します。工事番号は登録のときに決まり、あとから変わりません。範囲の向きは東西・南北のままです（回転はできません）。</div>
    </div>`;
  $('#sfClose').onclick=siteFormClose; $('#sfPick').onclick=()=>pickStart();
  for(const id of ['lon','lat','w','d']) $('#sf_'+id).oninput=()=>{ SF.checked=null; previewRect(); scheduleCheck(); };
  $('#sf_kind').onchange=()=>{ kindUI(); SF.checked=null; scheduleCheck(); };
  $('#sfSave').onclick=siteSave; if($('#sfArchive')) $('#sfArchive').onclick=siteArchive;
  bindContract(); kindUI(); previewRect(); SF.orig=JSON.stringify(formSite());
  if(mode==='edit'){ loadHistory(s); scheduleCheck(0); }
  if($('#sfArch')) loadArchived();
}
function kindUI(){ const m=isMarineKind($('#sf_kind').value), k=LEDGER.kinds[$('#sf_kind').value]||{};
  $('#sfMarine').hidden=!m; $('#sfMarineNote').hidden=!m;
  if(m){ if(!sfVal('design')&&k.design!=null) $('#sf_design').value=k.design; if(!sfVal('seabed')&&k.seabed!=null) $('#sf_seabed').value=k.seabed; } }
function siteFormClose(){ pickStop(); if(SF.ent&&G.viewer){ G.viewer.entities.remove(SF.ent); SF.ent=null; } if(SF.el) SF.el.hidden=true; }

/* ---- 地図で中心を置く・範囲の表示 ---- */
function pickStart(){ if(!G.viewer){ toast('地図の準備ができていません。',4000); return; }
  SF.picking=true; $('#sfPick').textContent='地図をクリックしてください…（Esc でやめる）';
  document.body.classList.add('picking');   // 位置を決める間は、地図の上のラベル（都道府県・現場）がクリックを受けないようにする
  const h=37, a=C3.Ellipsoid.WGS84.radii, ell=new C3.Ellipsoid(a.x+h,a.y+h,a.z+h);
  window.PICK_HOOK=pos=>{ const c=G.camera.pickEllipsoid(pos,ell); if(!c) return; const cg=C3.Cartographic.fromCartesian(c,ell);
    $('#sf_lon').value=C3.Math.toDegrees(cg.longitude).toFixed(6); $('#sf_lat').value=C3.Math.toDegrees(cg.latitude).toFixed(6);
    pickStop(); SF.checked=null; previewRect(true); scheduleCheck(0); };
  if(state.mode==='site'){ const s=byId(state.sel); if(s) flySite(s,siteView(s,{pitch:1.53,yaw:0,ty:0})); } }
function pickStop(){ SF.picking=false; window.PICK_HOOK=null; document.body.classList.remove('picking'); const b=$('#sfPick'); if(b) b.textContent='地図をクリックして中心を置く'; }
window.addEventListener('keydown',e=>{ if(e.key==='Escape'&&SF.picking) pickStop(); });
function rectCorners(lon,lat,w,d){ const dx=w/2/(111320*Math.cos(lat*Math.PI/180)), dy=d/2/110574;
  return [[lon-dx,lat-dy],[lon+dx,lat-dy],[lon+dx,lat+dy],[lon-dx,lat+dy],[lon-dx,lat-dy]]; }
function previewRect(fly){ if(!G.viewer) return; const lon=sfNum('lon'), lat=sfNum('lat'), w=sfNum('w'), d=sfNum('d');
  if(SF.ent){ G.viewer.entities.remove(SF.ent); SF.ent=null; }
  if(lon==null||lat==null||!w||!d) return;
  const col=C3.Color.fromCssColorString('#fde68a'), pos=C3.Cartesian3.fromDegreesArrayHeights(rectCorners(lon,lat,w,d).flatMap(([a,b])=>[a,b,38]));
  SF.ent=G.viewer.entities.add({polyline:{positions:pos,width:3,material:col,depthFailMaterial:col}});
  if(fly&&state.mode!=='site') G.camera.flyTo({destination:C3.Cartesian3.fromDegrees(lon,lat,Math.max(w,d)*4+400),orientation:{heading:0,pitch:-C3.Math.PI_OVER_TWO,roll:0},duration:1.2}); }

/* ---- 所在地・地形の確認（起動時と同じ取り方） ---- */
function scheduleCheck(ms=800){ clearTimeout(SF.timer); SF.timer=setTimeout(siteCheck,ms); }
function formSite(){ return {lon:sfNum('lon'),lat:sfNum('lat'),w:sfNum('w'),d:sfNum('d'),kind:$('#sf_kind').value}; }
async function siteCheck(){
  const el=$('#sfCheck'), f=formSite(); if(!el) return;
  if(f.lon==null||f.lat==null||!f.w||!f.d){ el.textContent='位置（経度・緯度）と範囲を入れてください。'; return; }
  if(f.w<LEDGER.size.min||f.w>LEDGER.size.max||f.d<LEDGER.size.min||f.d>LEDGER.size.max){ el.innerHTML=`<span class="late">範囲は ${LEDGER.size.min}〜${LEDGER.size.max} m にしてください。</span>`; return; }
  const sig=JSON.stringify(f); el.textContent='国土地理院から所在地と地形を取得しています…';
  const P=window.PORTAL_LOADER, marine=isMarineKind(f.kind);
  const site={lon:f.lon,lat:f.lat,w:f.w,d:f.d, ...(marine?{survey:{nx:1,nz:1,src:'',E:'',emin:0,emax:0,emed:0}}:{})};
  let ad, tr;
  try{ ad=await P.address(site); }
  catch(e){ if(JSON.stringify(formSite())!==sig) return; const net=!/所在地を取得できません/.test(e.message||e);
    SF.checked={sig,ok:false}; el.innerHTML=net?`<span class="warnc">国土地理院に接続できませんでした（${esc(e.message||e)}）。</span><button class="btn ghost" id="sfRetry">もう一度</button>`
      :'<span class="late">所在地（市区町村）を決められない位置です。陸から 1 km 以内にしてください。</span>';
    if($('#sfRetry')) $('#sfRetry').onclick=()=>siteCheck(); return; }
  try{ tr=await P.terrain(site); }
  catch(e){ if(JSON.stringify(formSite())!==sig) return; const nodata=/標高データのない点/.test(e.message||e);
    SF.checked={sig,ok:false}; el.innerHTML=nodata?`<span class="late">施工範囲に海など標高データの無い所が含まれます（${esc(ad.pref+ad.city)}）。陸の工種は、範囲を陸の上にしてください。海の工事は工種を「浚渫」「海面埋立」にしてください。</span>`
      :`<span class="warnc">標高データを取得できませんでした（${esc(e.message||e)}）。</span><button class="btn ghost" id="sfRetry">もう一度</button>`;
    if($('#sfRetry')) $('#sfRetry').onclick=()=>siteCheck(); return; }
  if(JSON.stringify(formSite())!==sig) return;
  SF.checked={sig,ok:true,ad};
  el.innerHTML=`<span class="ahead">✓ 確認しました</span>　所在地：${esc(ad.pref+ad.city+ad.town)}地先${marine?'（海底は仮の海底を使います）':`／地形 T.P. ${tr.emin.toFixed(1)}〜${tr.emax.toFixed(1)} m（中央 ${tr.emed.toFixed(1)} m）`}`;
  suggest(f,ad);
}
// 候補：支店＝同じ都道府県の現場でいちばん多い支店（無ければ最寄りの現場）、港＝20 km 以内の現場の港（無ければ最寄りの潮位表の地点）
function suggest(f,ad){
  const km=s=>Math.hypot((s.lon-f.lon)*Math.cos(f.lat*Math.PI/180),s.lat-f.lat)*111;
  const same=SITES.filter(s=>s.pref===ad.pref), near=[...SITES].sort((a,b)=>km(a)-km(b));
  const cnt={}; for(const s of same) cnt[s.br]=(cnt[s.br]||0)+1;
  const br=Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0]||(near[0]&&near[0].br);
  if(SF.mode==='new'&&br&&inScopeBr(br)&&$('#sf_br').value!==br&&!SF.brTouched) $('#sf_br').value=br;
  const ps=near.find(s=>km(s)<=20), st=tideStation({lon:f.lon,lat:f.lat}), cand=ps?ps.port:(st?`${st.name}（潮位表の地点）`:'');
  const hint=$('#sfPortHint'); if(!hint) return;
  hint.innerHTML=cand?`候補：<a href="#" id="sfPortUse">${esc(cand)}</a>${ps?`（${km(ps).toFixed(1)} km の現場）`:''}`:'';
  if($('#sfPortUse')) $('#sfPortUse').onclick=e=>{ e.preventDefault(); $('#sf_port').value=ps?ps.port:st.name.replace(/（.*$/,''); };
  if(SF.mode==='new'&&!sfVal('port')&&ps) $('#sf_port').value=ps.port;
}

/* ---- 保存・完了・履歴 ---- */
async function siteSave(){
  const m=$('#sfMsg'), f=formSite(), marine=isMarineKind(f.kind);
  const body={name:sfVal('name'),br:$('#sf_br').value,port:sfVal('port'),client:sfVal('client'),ccat:$('#sf_ccat').value,kind:f.kind,start:sfVal('start'),
    soil:$('#sf_soil').value,lon:f.lon,lat:f.lat,w:f.w,d:f.d,sea:$('#sf_sea').value||null,design:marine?sfNum('design'):null,seabed:marine?sfNum('seabed'):null};
  const miss=['name','port','client','start'].filter(k=>!body[k]).map(k=>FLD[k]).concat(f.lon==null||f.lat==null?['位置']:[]).concat(marine&&body.design==null?['計画高']:[]).concat(marine&&body.seabed==null&&SF.mode==='new'?['いまの海底']:[]);
  if(miss.length){ m.innerHTML=`<span class="late">入力してください：${esc(miss.join('、'))}</span>`; return; }
  let ct; try{ ct=readContract(); }catch(e){ m.innerHTML=`<span class="late">${esc(e.message)}</span>`; return; }
  body.contract=ct;
  const needCheck=SF.mode==='new'||JSON.stringify(f)!==SF.orig;   // 編集で位置・範囲・工種を変えていなければ、確かめ直さない
  if(needCheck&&(!SF.checked||!SF.checked.ok||SF.checked.sig!==JSON.stringify(f))){ m.innerHTML='<span class="late">所在地と地形の確認が済んでいません（上の欄を確かめてください）。</span>'; scheduleCheck(0); return; }
  $('#sfSave').disabled=true; m.textContent='保存しています…';
  try{ const r=SF.mode==='new'?await api('POST','api/sites',body):await api('PUT',`api/sites/${SF.s.key}`,{...body,version:defOf(SF.s)._version});
    if(SF.mode==='edit'&&!r.changed.length){ m.textContent='変更はありません。'; $('#sfSave').disabled=false; return; }
    try{ sessionStorage.setItem('portal.reselect',r.key); }catch(e){}
    toast(SF.mode==='new'?`登録しました（工事番号 ${esc(r.no)}）。画面を読み込み直します。`:'保存しました。画面を読み込み直します。',3000); setTimeout(()=>location.reload(),900); }
  catch(e){ m.innerHTML=`<span class="late">${esc(e.message)}</span>`; $('#sfSave').disabled=false; }
}
async function siteArchive(){ const s=SF.s;
  if(!confirm(`「${s.name}」を完了にして一覧から外しますか？\n実績・測量・協議記録などは消えません（戻せるのは管理者です）。`)) return;
  try{ await api('POST',`api/sites/${s.key}/archive`,{version:defOf(s)._version}); toast('完了にしました。画面を読み込み直します。',3000); setTimeout(()=>location.reload(),900); }
  catch(e){ $('#sfMsg').innerHTML=`<span class="late">${esc(e.message)}</span>`; } }
async function loadHistory(s){ const el=$('#sfHist');
  try{ const h=await api('GET',`api/sites/${s.key}/history`); if(!el.isConnected) return;
    const act={create:'登録',update:'変更',archive:'完了',restore:'戻す'};
    el.innerHTML=h.length?`<table class="t"><tr><th>日時</th><th>操作</th><th>項目</th><th>だれが</th></tr>${h.map(x=>`<tr><td class="nw">${esc(new Date(x.at).toLocaleString('ja-JP'))}</td><td>${esc(act[x.action]||x.action)}</td>
      <td>${esc((x.changed_fields||[]).map(f=>f.startsWith('contract.')?'契約・'+(CFLD[f.slice(9)]||f.slice(9)):FLD[f]||f).join('、'))}</td><td>${esc(x.email||'—')}</td></tr>`).join('')}</table>`:'取り込み（seed）のまま、画面での変更はありません。'; }
  catch(e){ el.textContent=e.message; } }
async function loadArchived(){ const el=$('#sfArch');
  try{ const a=await api('GET','api/sites/archived'); el.innerHTML=a.length?`<table class="t">${a.map(x=>`<tr><td class="nw">${esc(x.no||'')}</td><td>${esc(x.name)}</td><td><button class="btn ghost" data-restore="${esc(x.key)}">戻す</button></td></tr>`).join('')}</table>`:'ありません。';
    el.querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{ try{ await api('POST',`api/sites/${b.dataset.restore}/restore`); toast('戻しました。画面を読み込み直します。',3000); setTimeout(()=>location.reload(),900); }catch(e){ toast(esc(e.message),6000); } }); }
  catch(e){ el.textContent=e.message; } }

/* ---- 入口（全国表示・現場のサマリ）と、読み込み直した後の選択 ---- */
{ const _rd=renderDock; renderDock=function(){ _rd(); if(!canLedger()||state.sel) return;
    const h=$('#dockBody .card h3'); if(h&&!$('#siteNewBtn')) h.insertAdjacentHTML('beforeend','<button class="btn ghost" id="siteNewBtn">＋ 現場を登録</button>');
    const b=$('#siteNewBtn'); if(b) b.onclick=e=>{ e.stopPropagation(); siteFormOpen('new'); }; };
  const _rs=renderSummary; renderSummary=function(){ _rs(); const s=byId(state.sel);
    if(s&&SRV&&!PRESENT&&!$('#sumContract')){ const box=contractSummary(s); const b=$('#summary .btns'); if(box&&b) b.insertAdjacentHTML('beforebegin',box); } if(!s||!canLedger()||!inScopeBr(s.br)) return;
    const box=$('#summary .btns'); if(box&&!$('#siteEditBtn')) box.insertAdjacentHTML('beforeend','<button class="btn ghost" id="siteEditBtn">✎ 台帳を編集</button>');
    const b=$('#siteEditBtn'); if(b) b.onclick=()=>siteFormOpen('edit',s); };
  const _sel=select; select=function(id,doFly){ if(SF.el&&!SF.el.hidden&&SF.mode==='edit'&&(!SF.s||SF.s.id!==id)) siteFormClose(); _sel(id,doFly); };
}
document.addEventListener('change',e=>{ if(e.target&&e.target.id==='sf_br') SF.brTouched=true; });
// 登録の入口を目立つ所にも出す：画面上部（会議巡回の隣）・地図のボタン列・台帳が空のときの一覧（編集者・管理者だけ）
(function(){ if(!SRV||!CAN_EDIT||!LEDGER) return;
  const tb=$('#tourBtn'); if(tb) tb.insertAdjacentHTML('beforebegin','<button class="btn" id="siteNewTop" title="現場を台帳に登録します（地図で位置と範囲を指定）">＋ 現場を登録</button>');
  const top=$('#siteNewTop'); if(top) top.onclick=()=>{ if(!PRESENT) siteFormOpen('new'); };
  const _rt=renderTools; renderTools=function(){ _rt(); if(PRESENT||state.mode!=='nation') return; const L=$('#layers'); if(L&&!$('#siteNewMap'))
    { L.insertAdjacentHTML('afterbegin','<button id="siteNewMap" class="on" title="現場を台帳に登録します">＋ 現場を登録</button>'); $('#siteNewMap').onclick=e=>{ e.stopPropagation(); siteFormOpen('new'); }; } };
  const _rl=renderLedger; renderLedger=function(){ _rl(); if(PRESENT||SITES.length) return; const el=$('#list .empty');
    if(el){ el.innerHTML='まだ現場が登録されていません。<br><button class="btn" id="siteNewEmpty" style="margin-top:10px">＋ 現場を登録</button>'; $('#siteNewEmpty').onclick=()=>siteFormOpen('new'); } };
  // ここでは描かない（画面の準備の前に描くと起動が止まる）。この後の画面の初期化で、差し替えた関数が呼ばれる
})();
(function(){ let k=null; try{ k=sessionStorage.getItem('portal.reselect'); sessionStorage.removeItem('portal.reselect'); }catch(e){}
  if(!k) return; const s=SITES.find(x=>x.key===k); if(s) setTimeout(()=>select(s.id),1500); })();

/* ---- 契約（正式工事名・発注機関・工期・受注区分・JV・出典・確認状態） ---- */
function contractHTML(c){ c=c||{}; const v=c.verify||{}, inS2='style="width:100%"';
  const vk=k=>`<label class="sfV"><input type="checkbox" data-v="${k}"${v[k]?' checked':''}> 確認済み${v[k]?`<span class="hint">（${esc(v[k].by)}・${esc(new Date(v[k].at).toLocaleDateString('ja-JP'))}）</span>`:''}</label>`;
  const row=(lab,html,k)=>`<label>${lab}</label><div>${html}${k?vk(k):''}</div>`;
  const ci=(id,val,extra='')=>`<input id="ct_${id}" value="${esc(val??'')}" ${extra} ${inS2}>`;
  const conf=VERIFY_KEYS.filter(k=>v[k]).length;
  return `<details class="sfDet"${c.title||c.agency?' open':''}><summary>契約（正式名・発注機関・工期・受注区分・JV・出典）<span class="hint">　確認済み ${conf}/${VERIFY_KEYS.length}</span></summary>
    <div class="form sfGrid">${row('正式工事名',ci('title',c.title,'maxlength="200" placeholder="契約書の工事名を原文のまま"'),'title')}
      ${row('工事場所',ci('place',c.place,'maxlength="200" placeholder="契約書・公表資料の記載のまま（番地が無ければそのまま）"'),'place')}
      ${row('発注機関',ci('agency',c.agency,'maxlength="120" placeholder="例：国土交通省 関東地方整備局 東京港湾事務所"'),'agency')}
      ${row('案件番号',ci('agency_no',c.agency_no,'maxlength="60" placeholder="発注機関の番号・調達案件番号"'),'agency_no')}
      ${row('落札決定日',ci('award_date',c.award_date,'type="date"'),'award_date')}${row('契約締結日（受注日）',ci('contract_date',c.contract_date,'type="date"'),'contract_date')}
      ${row('当初の工期',`<div class="sfPair">${ci('period_start',c.period_start,'type="date"')}<span>〜</span>${ci('period_end',c.period_end,'type="date"')}</div>`,'period')}
      ${row('変更契約',`<div id="ct_changes">${(c.changes||[]).map(changeRow).join('')}</div><button class="btn ghost" id="ct_addChange" type="button">＋ 変更契約</button>`,'changes')}
      ${row('受注区分',`<select id="ct_role" ${inS2}><option value="">（未入力）</option>${CROLES.map(r=>`<option${r===c.role?' selected':''}>${r}</option>`).join('')}</select>`,'role')}
      ${row('JV の名称・構成員',`${ci('jv_name',c.jv_name,'maxlength="120" placeholder="JV の正式名称"')}<textarea id="ct_jv_members" rows="2" placeholder="構成員（1行に1社。代表から）" ${inS2}>${esc((c.jv_members||[]).join('\n'))}</textarea>`,'jv')}
      ${row('出典',`<div id="ct_sources">${(c.sources||[]).map(sourceRow).join('')}</div><button class="btn ghost" id="ct_addSource" type="button">＋ 出典</button>`)}</div>
    <div class="note">不明な値は空欄のままにしてください（推測で埋めない）。「確認済み」は、契約書・変更契約書・JV協定書などの根拠と照合したときに付けます（付けた人と日時が残ります）。</div></details>`; }
const VERIFY_KEYS=['title','place','agency','agency_no','award_date','contract_date','period','changes','role','jv'];
const changeRow=x=>`<div class="sfRow" data-row="change"><input type="date" data-f="date" value="${esc((x&&x.date)||'')}" title="変更契約日"><input type="date" data-f="period_end" value="${esc((x&&x.period_end)||'')}" title="変更後の工期（終了）">
  <input data-f="note" maxlength="200" value="${esc((x&&x.note)||'')}" placeholder="例：第1回変更（工期延長）"><button class="btn ghost" type="button" data-del>✕</button></div>`;
const sourceRow=x=>`<div class="sfRow" data-row="source"><select data-f="kind">${CSRC.map(k=>`<option${x&&x.kind===k?' selected':''}>${k}</option>`).join('')}</select><input data-f="title" maxlength="120" value="${esc((x&&x.title)||'')}" placeholder="資料名">
  <input data-f="url" maxlength="500" value="${esc((x&&x.url)||'')}" placeholder="URL（任意）"><input type="date" data-f="checked_on" value="${esc((x&&x.checked_on)||'')}" title="確認日"><button class="btn ghost" type="button" data-del>✕</button></div>`;
function bindContract(){ const el=$('#siteForm'); if(!el) return;
  $('#ct_addChange').onclick=()=>$('#ct_changes').insertAdjacentHTML('beforeend',changeRow(null));
  $('#ct_addSource').onclick=()=>$('#ct_sources').insertAdjacentHTML('beforeend',sourceRow(null));
  el.addEventListener('click',e=>{ const b=e.target.closest('[data-del]'); if(b) b.closest('.sfRow').remove(); }); }
function readContract(){ const g=id=>{ const e=$('#ct_'+id); return e?e.value.trim():''; }, n=v=>v||null;
  const rows=(sel,keys)=>[...document.querySelectorAll(sel)].map(r=>Object.fromEntries(keys.map(k=>[k,(r.querySelector(`[data-f="${k}"]`).value||'').trim()||null])));
  const changes=rows('#ct_changes .sfRow',['date','period_end','note']).filter(x=>x.date||x.period_end||x.note);
  if(changes.some(x=>!x.date||!x.period_end)) throw new Error('変更契約は、変更契約日と変更後の工期（終了）を入れてください');
  const sources=rows('#ct_sources .sfRow',['kind','title','url','checked_on']).filter(x=>x.title||x.url);
  if(sources.some(x=>!x.title)) throw new Error('出典は資料名を入れてください');
  const verify={}; document.querySelectorAll('#siteForm [data-v]').forEach(cb=>{ if(cb.checked) verify[cb.dataset.v]=true; });
  return {title:n(g('title')),place:n(g('place')),agency:n(g('agency')),agency_no:n(g('agency_no')),award_date:n(g('award_date')),contract_date:n(g('contract_date')),
    period_start:n(g('period_start')),period_end:n(g('period_end')),changes,role:n(g('role')),jv_name:n(g('jv_name')),
    jv_members:g('jv_members').split(/\n/).map(x=>x.trim()).filter(Boolean),sources,verify}; }
// 現場のサマリ：契約工期（当初・変更後）と、予測竣工との差（契約工期に対する遅れ）
function contractSummary(s){ const c=defOf(s).contract; if(!c) return '';
  const end=contractEnd(c), d=end?s.cur.end-dn(end):null, conf=VERIFY_KEYS.filter(k=>(c.verify||{})[k]).length, nch=(c.changes||[]).length;
  return `<div id="sumContract" class="sumContract"><div class="dhead" style="margin:8px 0 4px">契約 <span class="hint">確認済み ${conf}/${VERIFY_KEYS.length}・出典 ${(c.sources||[]).length}件</span></div><dl>
    ${c.title?`<dt>正式工事名</dt><dd>${esc(c.title)}</dd>`:''}${c.agency?`<dt>発注機関</dt><dd>${esc(c.agency)}${c.agency_no?`（${esc(c.agency_no)}）`:''}</dd>`:''}
    ${c.role?`<dt>受注区分</dt><dd>${esc(c.role)}${c.jv_name?`・${esc(c.jv_name)}`:''}</dd>`:''}
    ${c.period_end?`<dt>契約工期</dt><dd>${c.period_start?esc(c.period_start.replace(/-/g,'/'))+' 〜 ':''}${esc(c.period_end.replace(/-/g,'/'))}${nch?`<br>変更後（第${nch}回）〜 ${esc(end.replace(/-/g,'/'))}`:''}</dd>`:''}
    ${end?`<dt>予測竣工</dt><dd>${ds(s.cur.end)}　<b class="${d>14?'late':d>0?'warnc':'ahead'}">契約工期に対して ${d>0?'+':''}${d}日</b></dd>`:''}</dl></div>`; }

