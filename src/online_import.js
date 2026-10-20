/* =====================================================================
   9i. 現場台帳の取り込み（CSV・サーバ版）
   - 記入用の CSV（現場台帳_記入用.csv と同じ列）を読み、1 行ずつ確かめてから登録する
   - 文字コード：UTF-8（BOM の有無を問わない）か、Excel が保存する Shift_JIS
   - 位置：「場所」の住所・地名を国土地理院の住所検索で経度・緯度にし、所在地と地形を起動時と同じ取り方で確かめる
   - 確かめられた行だけを登録する（1 件ずつの登録と同じ API・同じ検査。登録済みの工事名・案件番号は飛ばす）
   - 分からない値は推測で埋めない（発注者の区分・海上工事の計画高などの仮の値は、一覧に「要確認」と出す）
   ===================================================================== */
const IMP={rows:[], file:'', busy:false};
const IMP_COLS={name:['工事名'],place:['場所','住所'],kind:['工種'],br:['支店'],client:['発注者'],start:['着工'],end:['終了','工期の終'],
  w:['東西'],d:['南北'],sea:['海側'],role:['受注区分'],jv:['JV','ＪＶ'],agency_no:['案件番号'],memo:['メモ','備考']};
const SEA_JA={'北':'N','東':'E','南':'S','西':'W','なし':null,'':null};
// CSV（引用符・改行を含む値に対応）
function parseCSV(text){ const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){ const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=ch; continue; }
    if(ch==='"') q=true; else if(ch===','){ row.push(cell); cell=''; } else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n') i++; row.push(cell); rows.push(row); row=[]; cell=''; } else cell+=ch; }
  if(cell!==''||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}
function decodeCSV(buf){ try{ return new TextDecoder('utf-8',{fatal:true}).decode(buf).replace(/^﻿/,''); }catch(e){ return new TextDecoder('shift_jis').decode(buf); } }
const normDate=s=>{ const m=(s||'').normalize('NFKC').trim().match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/); return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:null; };
function guessCcat(client){ const c=(client||'').normalize('NFKC');   // 発注者の区分：名前から推す（要確認として出す）
  if(/株式会社|\(株\)|有限会社|合同会社/.test(c)) return '民間';
  if(/港湾管理組合|港湾局|港管理|港務局/.test(c)) return '港湾管理者';
  if(/国土交通省|整備局|開発局|総合事務局|省|庁/.test(c)) return '国';
  if(/[都道府県市町村]/.test(c)) return '自治体';
  return null; }
function findKind(t){ t=(t||'').normalize('NFKC').trim(); if(!t) return null;
  for(const [k,v] of Object.entries(LEDGER.kinds)){ if(v.label===t||k===t) return k; }
  for(const [k,v] of Object.entries(LEDGER.kinds)){ const a=v.label.replace(/[・（）()]/g,''); if(a.includes(t.replace(/[・（）()]/g,''))||t.includes(a)) return k; }
  if(/浚渫/.test(t)) return Object.keys(LEDGER.kinds).find(k=>/浚渫/.test(LEDGER.kinds[k].label))||null;
  if(/埋立/.test(t)) return Object.keys(LEDGER.kinds).find(k=>/埋立/.test(LEDGER.kinds[k].label))||null;
  return null; }
function findBranch(t){ t=(t||'').normalize('NFKC').trim(); if(!t) return null;
  const up=t.toUpperCase(); if(LEDGER.branches[up]) return up;
  return Object.keys(LEDGER.branches).find(k=>LEDGER.branches[k]===t||LEDGER.branches[k].replace('支店','')===t.replace('支店',''))||null; }
function normRole(t){ t=(t||'').normalize('NFKC').trim(); if(!t) return null;
  if(/単独/.test(t)) return '単独'; if(/代表/.test(t)) return 'JV代表'; if(/サブ/.test(t)) return 'JVサブ'; if(/構成員|JV/.test(t)) return 'JV構成員（役割未確認）'; return undefined; }

// CSV の行 → 登録の内容（と、足りない・確かめたい項目）
function rowToSite(h,r,i){ const col=k=>{ const j=h[k]; return j==null?'':(r[j]||'').trim(); };
  const out={line:i+2, name:col('name'), place:col('place'), errs:[], warns:[], st:'待ち'};
  if(!out.name||/^（例）|^\(例\)/.test(out.name)) return null;
  const kind=findKind(col('kind')), br=findBranch(col('br')), start=normDate(col('start')), end=col('end')?normDate(col('end')):null;
  if(!kind) out.errs.push(`工種「${col('kind')||'空欄'}」が分かりません`);
  if(!br) out.errs.push(`支店「${col('br')||'空欄'}」が分かりません`); else if(!myBranches().includes(br)) out.errs.push('閲覧範囲の外の支店です');
  if(!col('client')) out.errs.push('発注者が空欄です');
  if(!out.place) out.errs.push('場所が空欄です');
  if(!start) out.errs.push(`着工日「${col('start')||'空欄'}」が日付ではありません`);
  if(col('end')&&!end) out.errs.push(`工期の終了日「${col('end')}」が日付ではありません`);
  const ccat=guessCcat(col('client')); if(!ccat&&col('client')) out.warns.push('発注者の区分を推せないため「民間」にしています（要確認）');
  const sea=col('sea').normalize('NFKC'); if(!(sea in SEA_JA)) out.warns.push(`海側「${sea}」が分からないため「なし」にしています`);
  const role=normRole(col('role')); if(role===undefined) out.warns.push(`受注区分「${col('role')}」が分からないため空欄にしています`);
  const marine=kind&&isMarineKind(kind), k=kind?LEDGER.kinds[kind]:{};
  const num=s=>{ const v=parseFloat((s||'').normalize('NFKC')); return Number.isFinite(v)?v:null; };
  let w=num(col('w')), d=num(col('d'));
  if(w==null||d==null){ w=w??(marine?200:120); d=d??(marine?100:80); out.warns.push(`施工範囲が空欄のため ${w}×${d} m の仮の大きさにしています（要確認）`); }
  if(w<LEDGER.size.min||w>LEDGER.size.max||d<LEDGER.size.min||d>LEDGER.size.max) out.errs.push(`施工範囲は ${LEDGER.size.min}〜${LEDGER.size.max} m にしてください`);
  if(marine) out.warns.push(`海上工事の計画高（T.P.${k.design}m）・いまの海底（T.P.${k.seabed}m）は仮の値です（要確認）`);
  out.body={name:out.name.slice(0,80), br, port:(out.place.match(/[^\s　]+港/)||[out.place])[0].slice(0,40), client:col('client').slice(0,80), ccat:ccat||'民間', kind, start, soil:'sand',
    w, d, sea:SEA_JA[sea]??null, design:marine?k.design:null, seabed:marine?k.seabed:null,
    contract:{title:out.name, place:out.place, agency:col('client')||null, agency_no:col('agency_no')||null, period_start:start, period_end:end, role:role||null,
      jv_name:col('jv')||null, jv_members:[], changes:[], sources:[{kind:'その他', title:`台帳の取り込み（${IMP.file}${out.line}行目）`.slice(0,120), checked_on:localISO(new Date())}], verify:{}}};
  if(SITES.some(s=>s.name===out.body.name)||(out.body.contract.agency_no&&SITE_DEFS.some(x=>x.contract&&x.contract.agency_no===out.body.contract.agency_no)))
    { out.st='登録済み'; out.skip=true; }
  return out; }

async function geocode(place){ const tries=[place, place.replace(/[（(].*?[）)]/g,'').trim(), place.split(/[\s　]/)[0]].filter((x,i,a)=>x&&a.indexOf(x)===i);
  for(const q of tries){ const r=await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q='+encodeURIComponent(q)); if(!r.ok) throw new Error('住所検索 HTTP '+r.status);
    const j=await r.json(); const f=(Array.isArray(j)?j:[]).find(x=>x&&x.geometry&&x.properties); if(f) return {lon:+f.geometry.coordinates[0], lat:+f.geometry.coordinates[1], title:f.properties.title, q}; }
  return null; }
// 1 行ずつ：位置 → 所在地・地形（起動時と同じ取り方）。国土地理院に負担をかけないよう、順番に少し間をあけて
async function checkRows(){ const P=window.PORTAL_LOADER;
  for(const row of IMP.rows){ if(row.skip||row.errs.length){ if(!row.skip) row.st='登録できない'; drawImport(); continue; }
    row.st='位置を確かめています…'; drawImport();
    try{ const g=await geocode(row.place);
      if(!g){ row.errs.push('場所が国土地理院の住所検索で見つかりません（住所・地名を詳しくするか、1 件ずつの登録で地図から指定してください）'); row.st='登録できない'; drawImport(); continue; }
      row.geo=g; Object.assign(row.body,{lon:+g.lon.toFixed(6), lat:+g.lat.toFixed(6)});
      const marine=isMarineKind(row.body.kind), site={lon:row.body.lon,lat:row.body.lat,w:row.body.w,d:row.body.d,...(marine?{survey:{nx:1,nz:1,src:'',E:'',emin:0,emax:0,emed:0}}:{})};
      const ad=await P.address(site); row.addr=ad.pref+ad.city+ad.town;
      if(!marine) await P.terrain(site);
      row.st='登録できます'; if(g.q!==row.place) row.warns.push(`「${g.q}」で見つけた位置です（要確認）`);
    }catch(e){ const m=String(e.message||e);
      row.errs.push(/標高データのない点/.test(m)?'施工範囲に海など標高データの無い所が含まれます（陸の工種は範囲を陸の上に。1 件ずつの登録で地図から位置を直してください）'
        :/所在地を取得できません/.test(m)?'所在地（市区町村）を決められない位置です':`国土地理院から取得できませんでした（${m}）`);
      row.st='登録できない'; }
    drawImport(); await new Promise(r=>setTimeout(r,300)); }
  IMP.busy=false; drawImport(); }

function openImport(){ if(!canLedger()) return;
  let el=$('#impDlg'); if(!el){ el=document.createElement('div'); el.id='impDlg'; el.className='dlg'; document.body.appendChild(el); }
  IMP.rows=[]; IMP.file=''; el.hidden=false;
  el.innerHTML=`<div class="dlgBox" role="dialog" aria-modal="true" style="width:min(980px,100%);max-height:calc(100vh - 32px);overflow:auto"><h2>現場台帳の取り込み（CSV）</h2>
    <p class="hint">記入用の CSV（1 行に 1 現場）を選ぶと、場所から位置を決め、所在地と地形を 1 件ずつ確かめます。確かめられた行だけを登録します（登録済みの工事名・案件番号は飛ばします）。Excel で作った CSV（Shift_JIS）も読めます。</p>
    <div class="btns"><label class="btn" style="cursor:pointer">CSV を選ぶ<input type="file" id="impFile" accept=".csv,text/csv" hidden></label><button class="btn ghost" id="impTpl">記入用の CSV をダウンロード</button><span class="hint" id="impMsg"></span></div>
    <div id="impList" style="margin-top:10px"></div>
    <div class="btns" style="margin-top:10px"><button class="btn" id="impGo" disabled>確かめた行を登録</button><button class="btn ghost" id="impClose">閉じる</button></div></div>`;
  $('#impClose').onclick=()=>{ if(!IMP.busy) el.hidden=true; };
  $('#impTpl').onclick=downloadTemplate;
  $('#impFile').onchange=async e=>{ const f=e.target.files[0]; if(!f) return; IMP.file=f.name; const m=$('#impMsg');
    try{ const rows=parseCSV(decodeCSV(await f.arrayBuffer())); if(rows.length<2) throw new Error('行がありません');
      const head=rows[0].map(x=>x.normalize('NFKC').trim()), h={};
      const used=new Set();   // 1 つの列を 2 つの項目に使わない（「受注区分（…JV代表…）」と「JV の名称」など）
      for(const [k,names] of Object.entries(IMP_COLS)){ const j=head.findIndex((x,i)=>!used.has(i)&&names.some(n=>x.includes(n.normalize('NFKC')))); if(j>=0){ h[k]=j; used.add(j); } }
      const miss=['name','place','kind','br','client','start'].filter(k=>h[k]==null).map(k=>IMP_COLS[k][0]);
      if(miss.length) throw new Error(`見出しに無い列があります：${miss.join('、')}（記入用の CSV の 1 行目をそのまま使ってください）`);
      IMP.rows=rows.slice(1).map((r,i)=>rowToSite(h,r,i)).filter(Boolean);
      if(IMP.rows.length>200) throw new Error('一度に取り込めるのは 200 行までです');
      m.textContent=`${f.name}：${IMP.rows.length} 行`; IMP.busy=true; drawImport(); await checkRows(); }
    catch(err){ m.innerHTML=`<span class="late">${esc(err.message||err)}</span>`; IMP.busy=false; } };
  $('#impGo').onclick=registerRows;
}
function drawImport(){ const el=$('#impList'); if(!el) return;
  const cls=s=>s==='登録できます'||s==='登録しました'?'ahead':s==='登録できない'||s==='失敗'?'late':s==='登録済み'?'':'warnc';
  el.innerHTML=IMP.rows.length?`<table class="t"><tr><th>行</th><th>工事名</th><th>工種・支店</th><th>位置（国土地理院）</th><th>状態</th></tr>${IMP.rows.map(r=>`<tr>
      <td class="n">${r.line}</td><td>${esc(r.name)}</td><td class="nw">${esc(r.body.kind?LEDGER.kinds[r.body.kind].label:'—')}<br><span class="hint">${esc(r.body.br?LEDGER.branches[r.body.br]:'—')}</span></td>
      <td>${esc(r.addr||(r.geo?r.geo.title:r.place))}${r.geo?`<br><span class="hint">${r.body.lat}, ${r.body.lon}</span>`:''}</td>
      <td><b class="${cls(r.st)}">${esc(r.st)}</b>${r.errs.map(x=>`<div class="late" style="font-size:11.5px">${esc(x)}</div>`).join('')}${r.warns.map(x=>`<div class="hint" style="font-size:11.5px">${esc(x)}</div>`).join('')}</td></tr>`).join('')}</table>`:'';
  const ok=IMP.rows.filter(r=>r.st==='登録できます').length, go=$('#impGo');
  if(go){ go.disabled=IMP.busy||!ok; go.textContent=`確かめた ${ok} 件を登録`; } }
async function registerRows(){ const rows=IMP.rows.filter(r=>r.st==='登録できます'); if(!rows.length) return;
  if(!confirm(`${rows.length} 件を台帳に登録します。要確認の項目は、登録の後に「✎ 台帳を編集」で直せます。よろしいですか？`)) return;
  IMP.busy=true; drawImport(); let n=0;
  for(const r of rows){ try{ const x=await api('POST','api/sites',r.body); r.st='登録しました'; r.key=x.key; r.no=x.no; n++; }catch(e){ r.st='失敗'; r.errs.push(e.message); } drawImport(); }
  IMP.busy=false; drawImport();
  $('#impMsg').innerHTML=`<b class="ahead">${n} 件を登録しました。</b>画面を読み込み直すと、台帳と地図に出ます。<button class="btn" id="impReload" style="margin-left:6px">読み込み直す</button>`;
  $('#impReload').onclick=()=>location.reload(); }
function downloadTemplate(){ const head=['工事名（必須）','場所：住所または地名（必須）','工種（必須）','支店（必須）','発注者（必須）','着工日（必須・YYYY-MM-DD）','工期の終了日（YYYY-MM-DD）','施工範囲 東西 m','施工範囲 南北 m','海側の向き（北・東・南・西・なし）','受注区分（単独／JV代表／JVサブ／JV構成員）','JV の名称','発注機関の案件番号','メモ'];
  const q=v=>/[",\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;
  const csv='﻿'+[head,['（例）令和8年度 ○○港 ふ頭ヤード整備工事','北海道苫小牧市港町1丁目','ふ頭ヤード整備','北海道支店','国土交通省 北海道開発局 室蘭開発建設部','2026-11-02','2027-09-30','200','140','東','単独','','R8-○○-0001','例の行は消してください']].map(r=>r.map(q).join(',')).join('\r\n')+'\r\n';
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='現場台帳_記入用.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }

// 入口：「＋ 現場を登録」の隣（画面上部・地図のボタン列・空の台帳）
(function(){ if(!SRV||!CAN_EDIT||!LEDGER) return;
  const top=$('#siteNewTop'); if(top) top.insertAdjacentHTML('afterend','<button class="btn ghost" id="siteImportTop" title="記入用の CSV から、まとめて登録します">⬆ 台帳を取り込む</button>');
  const t=$('#siteImportTop'); if(t) t.onclick=()=>{ if(!PRESENT) openImport(); };
  const _rt=renderTools; renderTools=function(){ _rt(); const b=$('#siteNewMap'); if(b&&!$('#siteImportMap'))
    { b.insertAdjacentHTML('afterend','<button id="siteImportMap" title="記入用の CSV から、まとめて登録します">⬆ 台帳を取り込む</button>'); $('#siteImportMap').onclick=e=>{ e.stopPropagation(); openImport(); }; } };
  const _rl=renderLedger; renderLedger=function(){ _rl(); const b=$('#siteNewEmpty'); if(b&&!$('#siteImportEmpty'))
    { b.insertAdjacentHTML('afterend',' <button class="btn ghost" id="siteImportEmpty" style="margin-top:10px">⬆ 台帳を取り込む（CSV）</button>'); $('#siteImportEmpty').onclick=()=>openImport(); } };
})();
