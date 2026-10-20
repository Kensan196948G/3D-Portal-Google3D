/* =====================================================================
   9g. 遅れの予兆（サーバ版）
   - 毎朝の定時処理が保存した「遅れの日次の記録」（正式な予測）を読み、前週比で悪化した現場を出す
   - 全国表示：遅れの予兆の一覧／遅れの分析タブ：その現場の遅れの推移
   ===================================================================== */
const TREND={sites:{}, rule:{deltaDays:7,compareDays:7}, latestDate:null, ok:false};
async function trendLoad(){ if(!SRV) return; try{ Object.assign(TREND,await api('GET','api/trends'),{ok:true}); }catch(e){ console.warn('遅れの推移',e); }
  if(!PRESENT) renderDock(); }
const trendOf=s=>TREND.sites[s.key];
const sgn=d=>`${d>0?'+':''}${d}日`;   // 早い（負）の値に + を付けない
function trendSVG(t){
  const pts=t.series.map(([d,v])=>[dn(d),v]), W=520, H=130, P=34, t0=pts[0][0], t1=Math.max(pts[pts.length-1][0],t0+7);
  const lo=Math.min(0,...pts.map(p=>p[1]))-2, hi=Math.max(15,...pts.map(p=>p[1]))+2, X=d=>P+(d-t0)/(t1-t0)*(W-P-8), Y=v=>8+(hi-v)/(hi-lo)*(H-30);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="${P}" x2="${W-8}" y1="${Y(0)}" y2="${Y(0)}" stroke="#334155"/><line x1="${P}" x2="${W-8}" y1="${Y(14)}" y2="${Y(14)}" stroke="#ef4444" stroke-dasharray="4 3" opacity=".6"/>
    <text x="${P-4}" y="${Y(0)+3}" font-size="9" fill="#64748b" text-anchor="end">0</text><text x="${P-4}" y="${Y(14)+3}" font-size="9" fill="#fca5a5" text-anchor="end">14</text>
    <polyline fill="none" stroke="#60a5fa" stroke-width="2" points="${pts.map(([d,v])=>`${X(d)},${Y(v)}`).join(' ')}"/>${pts.map(([d,v])=>`<circle cx="${X(d)}" cy="${Y(v)}" r="2.5" fill="#93c5fd"><title>${ds(d)} 遅れ ${v}日</title></circle>`).join('')}
    <text x="${P}" y="${H-6}" font-size="9.5" fill="#93a1bd">${ds(t0)}</text><text x="${W-8}" y="${H-6}" font-size="9.5" fill="#93a1bd" text-anchor="end">${ds(pts[pts.length-1][0])}</text></svg>`; }
function trendNote(){ const n=new Set(Object.values(TREND.sites).flatMap(t=>t.series.map(x=>x[0]))).size;
  return TREND.latestDate?`毎朝の記録：最新 ${TREND.latestDate.replace(/-/g,'/')}（${n} 日分）。${TREND.rule.compareDays} 日以上前の記録と比べ、遅れが ${TREND.rule.deltaDays} 日以上ふえた現場、または 14 日超へ悪化した現場を「予兆」とします。`
    :'毎朝の記録はまだありません（サーバの定時処理が毎朝 7:30 に記録します）。'; }
{ const _rd=renderDock; renderDock=function(){ _rd(); if(!SRV||PRESENT||!TREND.ok) return; const s=byId(state.sel), body=$('#dockBody');
    if(!s){ const rise=SITES.filter(x=>inScope(x)&&trendOf(x)&&trendOf(x).rising).sort((a,b)=>trendOf(b).delta-trendOf(a).delta);
      const card=document.createElement('div'); card.className='card'; card.style.marginTop='12px';
      card.innerHTML=`<h3>遅れの予兆 <small>前週比で悪化した現場（毎朝の記録から）</small></h3>
        ${rise.length?`<table class="t"><tr><th>工事</th><th>担当支店</th><th class="n">遅れ（予測）</th><th class="n">前回比</th><th>比べた記録</th></tr>${rise.map(x=>{ const t=trendOf(x);
          return `<tr class="click" data-id="${esc(x.id)}"><td>${esc(x.name)}</td><td>${esc(x.brName)}</td><td class="n late">${sgn(t.delay)}</td><td class="n late">${sgn(t.delta)}</td><td class="nw">${t.refDate.replace(/-/g,'/')}（${sgn(t.refDelay)}）</td></tr>`; }).join('')}</table>`
          :`<p class="hint">${TREND.latestDate?'前週より悪化した現場はありません。':'まだ判定できません。'}</p>`}<div class="note">${esc(trendNote())}</div>`;
      body.appendChild(card); return; }
    if(state.tab!=='ai') return; const t=trendOf(s), card=document.createElement('div'); card.className='card'; card.style.marginTop='12px';
    card.innerHTML=`<h3>遅れの推移 <small>毎朝の記録（正式な予測：What-if は含まない）</small>${t&&t.rising?'<span class="badge warn">予兆</span>':''}</h3>
      ${t&&t.series.length>1?trendSVG(t):'<p class="hint">記録が 2 日分以上たまると推移を表示します。</p>'}
      ${t&&t.delta!=null?`<p class="hint" style="margin:6px 0 0">${t.refDate.replace(/-/g,'/')} の ${sgn(t.refDelay)} → ${t.date.replace(/-/g,'/')} の ${sgn(t.delay)}（<b class="${t.delta>0?'late':'ahead'}">${sgn(t.delta)}</b>）</p>`:''}
      <div class="note">${esc(trendNote())}</div>`;
    body.appendChild(card); }; }
trendLoad();
