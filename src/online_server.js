/* =====================================================================
   9d. サーバ版の画面（ログイン中の利用者・ログアウト・設定・AI による文章化）
   - 静的な配信（開発用）では何もしない
   ===================================================================== */
(()=>{ if(!SRV) return;
  const u=SRV.user, isAdmin=u.role==='admin', roleName={admin:'管理者',editor:'編集者',viewer:'閲覧者'}[u.role]||u.role;
  // ヘッダー：利用者・設定・ログアウト
  $('#keyBtn').insertAdjacentHTML('afterend',`<span class="userchip" title="${esc(u.email)}（${roleName}）">👤 ${esc(u.email.split('@')[0])}・${roleName}</span>
    <button class="btn ghost" id="setBtn" title="${isAdmin?'連携の設定・パスワード変更':'パスワード変更'}">⚙</button><button class="btn ghost" id="logoutBtn">ログアウト</button>`);
  $('#logoutBtn').onclick=async()=>{ try{ await api('POST','api/auth/logout'); }catch(e){} location.reload(); };
  $('#setBtn').onclick=()=>openSettings();
  if(SRV.features&&SRV.features.ais) setInterval(refreshAis,60000);
})();

async function refreshAis(){ if(document.hidden) return; try{ const r=await fetch('api/vessels'); if(!r.ok) return; const list=await r.json();
  for(const a of list){ const v=VESSELS.find(x=>x.id===a.id); if(v){ v.lon=a.lon; v.lat=a.lat; v.radius=0; } } }catch(e){} }

/* ---- 設定（管理者：desknet's NEO・メール・AI。全員：パスワード変更） ---- */
function delaySummary(){ const set=SITES, late=set.filter(s=>s.cur.delay>14), warn=set.filter(s=>s.cur.delay>0&&s.cur.delay<=14);
  return {total:set.length, late:late.length, warn:warn.length, lines:[...late,...warn].sort((a,b)=>b.cur.delay-a.cur.delay).map(s=>`${s.id} ${s.name}（${s.brName}）予測 +${s.cur.delay}日`)}; }
async function openSettings(){
  let el=$('#setDlg'); if(!el){ el=document.createElement('div'); el.id='setDlg'; el.className='dlg'; document.body.appendChild(el); }
  el.hidden=false; el.innerHTML=`<div class="dlgBox" role="dialog" aria-modal="true" style="width:min(760px,100%)"><h2>設定</h2><div id="setBody"><p>読み込んでいます…</p></div>
    <div class="btns" style="margin-top:10px"><button class="btn ghost" id="setClose">閉じる</button></div></div>`;
  $('#setClose').onclick=()=>{ el.hidden=true; };
  const pw=`<h3 style="font-size:13px;margin:14px 0 6px">パスワードの変更</h3><div class="form" style="grid-template-columns:auto 1fr">
    <label>いまのパスワード</label><input type="password" id="pwCur" autocomplete="current-password" style="width:auto;text-align:left">
    <label>新しいパスワード（12文字以上）</label><input type="password" id="pwNew" autocomplete="new-password" style="width:auto;text-align:left"></div>
    <div class="btns" style="margin-top:6px"><button class="btn" id="pwSave">変更する</button><span class="hint" id="pwMsg"></span></div>`;
  if(!SRV||SRV.user.role!=='admin'){ $('#setBody').innerHTML=pw; bindPw(); return; }
  let S; try{ S=await api('GET','api/settings'); }catch(e){ $('#setBody').innerHTML=`<p class="keyErr">${esc(e.message)}</p>`+pw; bindPw(); return; }
  const sec=(k)=>S[k].secretSet?`<span class="badge ok" style="margin-left:0">設定済み</span>`:`<span class="badge warn" style="margin-left:0">未設定</span>`;
  const inp=(id,v,ph='')=>`<input id="${id}" value="${esc(v??'')}" placeholder="${esc(ph)}" style="width:100%;text-align:left">`;
  const ta=(id,v)=>`<textarea id="${id}" rows="3" style="width:100%;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:12px">${esc(v??'')}</textarea>`;
  $('#setBody').innerHTML=`<p class="hint"><b>メール</b>は、有効にして SMTP・宛先・STARTTLS をそろえると、毎朝 7:30 の定時処理が<b>遅れの予兆がある日だけ 1日1回</b>送ります。<b>desknet's NEO</b> は API の仕様の確認待ちのため、文面の確認だけです。「文面を確認」で送る内容を確かめられます。トークン・パスワードは画面では扱わず、サーバの <code>server/.env</code> に置きます。</p>
    <h3 style="font-size:13px;margin:12px 0 6px">desknet's NEO への掲示（API 接続設定） ${sec('neo')} <small style="color:var(--muted)">${esc(S.neo.secretEnv)}</small></h3>
    <div class="form" style="grid-template-columns:auto 1fr"><label>有効にする</label><input type="checkbox" id="neoOn"${S.neo.enabled?' checked':''} style="width:auto">
      <label>API の接続先（https://）</label>${inp('neoUrl',S.neo.baseUrl,'https://（社内の desknet’s NEO）')}<label>掲示先（掲示板・インフォメーションの ID）</label>${inp('neoBoard',S.neo.boardId)}
      <label>掲示する時刻</label>${inp('neoTime',S.neo.schedule,'08:00')}<label>件名</label>${inp('neoTitle',S.neo.title)}<label>本文の型</label>${ta('neoTpl',S.neo.template)}</div>
    <div class="note">desknet's NEO の API の仕様（エンドポイント・認証方式・掲示先の指定）は<b>要確認</b>です。使える差し込み：{date} {total} {late} {warn} {lines}</div>
    <div class="btns" style="margin-top:6px"><button class="btn" data-save="neo">保存</button><button class="btn ghost" data-prev="neo">文面を確認</button></div>
    <h3 style="font-size:13px;margin:16px 0 6px">メールでの通知（遅れの予兆） ${sec('mail')} <small style="color:var(--muted)">${esc(S.mail.secretEnv)}</small></h3>
    <div class="form" style="grid-template-columns:auto 1fr"><label>有効にする</label><input type="checkbox" id="mailOn"${S.mail.enabled?' checked':''} style="width:auto">
      <label>SMTP サーバ</label>${inp('mailHost',S.mail.smtpHost,'smtp.example.co.jp')}<label>ポート</label>${inp('mailPort',S.mail.smtpPort,'587')}
      <label>TLS（STARTTLS）</label><input type="checkbox" id="mailTls"${S.mail.tls?' checked':''} style="width:auto"><label>SMTP のユーザー</label>${inp('mailUser',S.mail.smtpUser)}
      <label>差出人</label>${inp('mailFrom',S.mail.from,'portal@example.co.jp')}<label>宛先（カンマ区切り）</label>${inp('mailTo',(S.mail.to||[]).join(', '))}
      <label>送る時刻（参考）</label>${inp('mailTime',S.mail.schedule,'07:30')}<label>件名</label>${inp('mailSubj',S.mail.subject)}<label>本文の型</label>${ta('mailTpl',S.mail.template)}</div>
    <div class="note">実際に送る時刻はサーバの定時処理（systemd のタイマー 毎朝 7:30）で決まります。使える差し込み：{date} {total} {late} {warn} {lines} {rising} {rising_lines}</div>
    <div class="btns" style="margin-top:6px"><button class="btn" data-save="mail">保存</button><button class="btn ghost" data-prev="mail">文面を確認</button></div>
    <h3 style="font-size:13px;margin:16px 0 6px">遅れの予兆の判定</h3>
    <div class="form" style="grid-template-columns:auto 1fr"><label>比べる記録（何日以上前）</label>${inp('wnCmp',S.warning.compareDays,'7')}<label>予兆とする悪化（日）</label>${inp('wnDelta',S.warning.deltaDays,'7')}</div>
    <div class="note">毎朝の記録（正式な予測）を、指定した日数以上前でいちばん新しい記録と比べます。14 日以内から 14 日超へ悪化した現場も予兆です。</div>
    <div class="btns" style="margin-top:6px"><button class="btn" data-save="warning">保存</button></div>
    <div id="prevBox" class="card" style="margin-top:10px" hidden></div>
    <h3 style="font-size:13px;margin:16px 0 6px">AI による文章化（Claude） ${SRV.features.ai?'<span class="badge ok" style="margin-left:0">有効</span>':'<span class="badge" style="margin-left:0">無効</span>'}</h3>
    <p class="hint">「遅れの分析」タブの説明を AI が文章にします。有効にするには <code>server/.env</code> に <code>AI_ENABLED=1</code> と <code>ANTHROPIC_API_KEY</code> を置き、サービスを再起動します（FortiGate で <code>api.anthropic.com</code> の許可が必要）。送るのは計算結果（数値と要因）だけです。</p>
    <h3 style="font-size:13px;margin:16px 0 6px">AIS（作業船の位置） ${SRV.features.ais?'<span class="badge ok" style="margin-left:0">取り込み口 有効</span>':'<span class="badge" style="margin-left:0">未接続</span>'}</h3>
    <p class="hint">AIS 受信機・AIS サービスから <code>POST /api/ais/ingest</code>（<code>Authorization: Bearer</code> ＝ <code>server/.env</code> の <code>AIS_INGEST_TOKEN</code>）で位置を送ると、作業船のレイヤーに出ます。いま表示しているのはデモ（架空）です。</p>`+pw;
  const val=id=>$('#'+id).value, chk=id=>$('#'+id).checked;
  const read=k=>k==='warning'?{compareDays:parseInt(val('wnCmp'),10)||7,deltaDays:parseInt(val('wnDelta'),10)||7}:k==='neo'?{enabled:chk('neoOn'),baseUrl:val('neoUrl').trim(),boardId:val('neoBoard').trim(),schedule:val('neoTime').trim(),title:val('neoTitle'),template:val('neoTpl')}
    :{enabled:chk('mailOn'),smtpHost:val('mailHost').trim(),smtpPort:parseInt(val('mailPort'),10)||587,tls:chk('mailTls'),smtpUser:val('mailUser').trim(),from:val('mailFrom').trim(),
      to:val('mailTo').split(/[,\s]+/).filter(Boolean),schedule:val('mailTime').trim(),subject:val('mailSubj'),template:val('mailTpl')};
  $('#setBody').querySelectorAll('[data-save]').forEach(b=>b.onclick=async()=>{ try{ await api('PUT',`api/settings/${b.dataset.save}`,read(b.dataset.save)); toast('保存しました。',3000); }catch(e){ toast('保存できませんでした：'+esc(e.message),8000); } });
  $('#setBody').querySelectorAll('[data-prev]').forEach(b=>b.onclick=async()=>{ const box=$('#prevBox'); box.hidden=false; box.innerHTML='<p class="hint">作成しています…</p>';
    try{ const r=await api('POST',`api/notify/preview/${b.dataset.prev}`,delaySummary());
      box.innerHTML=`<h3>${r.channel==='neo'?"desknet's NEO に掲示する内容":'メールで送る内容'} <small>${r.enabled?'有効':'無効'}・秘密情報 ${r.secretSet?'設定済み':'未設定'}・送信はしません</small></h3>
        ${r.channel==='neo'?`<div class="hint">接続先：${esc(r.endpoint)}／掲示先：${esc(r.board)}</div><div><b>${esc(r.title)}</b></div>`:`<div class="hint">サーバ：${esc(r.server)}／差出人：${esc(r.from)}／宛先：${esc(r.to.join(', '))}</div><div><b>${esc(r.subject)}</b></div>`}
        <pre style="white-space:pre-wrap;font-size:12px;margin:6px 0">${esc(r.body)}</pre><div class="note">${esc(r.note)}${r.apiNote?' '+esc(r.apiNote):''}</div>`; }
    catch(e){ box.innerHTML=`<p class="keyErr">${esc(e.message)}</p>`; } });
  bindPw();
}
function bindPw(){ $('#pwSave').onclick=async()=>{ const m=$('#pwMsg'); try{ await api('POST','api/auth/password',{current:$('#pwCur').value,new:$('#pwNew').value}); m.textContent='変更しました。もう一度ログインしてください。'; setTimeout(()=>location.reload(),1500); }
  catch(e){ m.textContent=e.message; } }; }

/* ---- 遅れの分析：AI による文章化（有効なときだけ） ---- */
const _rdk=renderDock;
renderDock=function(){ _rdk(); const s=byId(state.sel); if(!SRV||!SRV.features.ai||PRESENT||!s||state.tab!=='ai') return;
  const card=document.createElement('div'); card.className='card'; card.style.marginTop='12px';
  card.innerHTML=`<h3>AI による説明文 <small>Claude（計算結果だけを送ります）</small></h3><div class="btns"><button class="btn" id="aiGo">AI で説明文を作る</button></div><div id="aiOut" class="hint" style="margin-top:8px"></div>`;
  $('#dockBody').appendChild(card);
  $('#aiGo').onclick=async()=>{ const out=$('#aiOut'); out.textContent='作成しています…（数十秒かかることがあります）'; $('#aiGo').disabled=true;
    const an=analyzeDelay(s), rec=s.cur.delay>0?recoverPlans(s):{plans:[]};
    const payload={site:s.id, name:s.name, kind:s.k.label, branch:s.brName, plannedEnd:ds(s.planEnd), forecastEnd:ds(s.cur.end), delayDays:s.cur.delay, actualPct:an.a, planPct:an.pl,
      factors:an.fx.map(([k,v])=>({factor:k, detail:v})), lateTasks:an.slip.slice(0,5).map(x=>({task:x.t.n, slipDays:x.F-x.t.te})),
      recovery:rec.plans.map(o=>({change:planTxt(o.q,s.p), forecastEnd:ds(o.end), delayDays:o.delay})), note:'架空の工事のサンプル'};
    try{ const r=await api('POST','api/ai/explain',payload); out.innerHTML=`<div style="white-space:pre-wrap;font-size:12.5px;line-height:1.8;color:var(--text)">${esc(r.text)}</div><div class="note">作成：${esc(r.model)}。数値はワールドモデルの計算が正です。</div>`; }
    catch(e){ out.textContent='作成できませんでした：'+e.message; } finally{ const b=$('#aiGo'); if(b) b.disabled=false; } };
};

