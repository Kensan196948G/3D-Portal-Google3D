'use strict';
/* =====================================================================
   0. 埋め込み地理データ（ビルド時に生成）
   ===================================================================== */
const GEO = window.GEO;  // 起動時に loader.js が取得して組み立てる（data/*.json と国土地理院）

/* =====================================================================
   1. ユーティリティ
   ===================================================================== */
const $ = s => document.querySelector(s);
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a)*t;
const sm = t => t<=0 ? 0 : t>=1 ? 1 : t*t*(3-2*t);
const ease = t => t<.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normText = t => (t||'').normalize('NFKC').toLowerCase().replace(/[\s\-‐−–—_]/g,'');
const fmtN = v => isFinite(v) ? Math.round(v).toLocaleString('ja-JP') : '—';
const fmt1 = v => isFinite(v) ? (Math.round(v*10)/10).toLocaleString('ja-JP',{minimumFractionDigits:1,maximumFractionDigits:1}) : '—';
const hex = h => { h=h.replace('#',''); return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255]; };
const mix = (a,b,t) => [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)];
const rgba = (c,a=1) => [c[0],c[1],c[2],a];
const inRect = (x,z,cx,cz,w,d) => Math.abs(x-cx)<=w/2 && Math.abs(z-cz)<=d/2;
const DAY = 86400000;
const dn = s => { const [y,m,d]=s.split('-').map(Number); return Math.round(Date.UTC(y,m-1,d)/DAY); };
const ds = n => { const d=new Date(Math.floor(n)*DAY); return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}`; };
const ym = n => { const d=new Date(Math.floor(n)*DAY); return `${String(d.getUTCFullYear()).slice(2)}/${d.getUTCMonth()+1}`; };
const monthOf = n => new Date(Math.floor(n)*DAY).getUTCMonth()+1;
function decI16(b64){ const bin=atob(b64), n=bin.length>>1, out=new Float32Array(n);
  for(let i=0;i<n;i++){ let v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8); if(v>32767) v-=65536; out[i]=v/10; } return out; }
function decLine(a){ const out=[]; let x=a[0], y=a[1]; out.push([x/1000,y/1000]); for(let i=2;i<a.length;i+=2){ x+=a[i]; y+=a[i+1]; out.push([x/1000,y/1000]); } return out; }

/* =====================================================================
   2. 全国の座標系（km）・都道府県
   ===================================================================== */
const LON0=137, LAT0=36, KX=Math.cos(LAT0*Math.PI/180)*111.32, KZ=110.574;
const toNat = (lon,lat) => [(lon-LON0)*KX, -(lat-LAT0)*KZ];
const fromNat = (X,Z) => [X/KX+LON0, -Z/KZ+LAT0];
const MAPB = {lon0:122.5, lon1:149.0, lat0:24.0, lat1:46.0};
const [MX0,MZ1]=toNat(MAPB.lon0,MAPB.lat0), [MX1,MZ0]=toNat(MAPB.lon1,MAPB.lat1);
const PREFS = GEO.prefs.map(p=>{ const rings=p.rings.map(decLine); let b=[999,999,-999,-999];
  for(const r of rings) for(const [x,y] of r){ b[0]=Math.min(b[0],x); b[1]=Math.min(b[1],y); b[2]=Math.max(b[2],x); b[3]=Math.max(b[3],y); }
  return {code:p.code, name:p.name, pt:p.pt, rings, bbox:b, short:p.name.replace(/(都|府|県)$/,'')}; });
const ROADS = GEO.roads.map(decLine);
const CITIES = GEO.cities.map(([pi,name,lon,lat])=>({pi,name,lon,lat,pref:PREFS[pi].name}));
// 政令指定都市は「市」単位の代表点（区の平均）も用意
(()=>{ const agg={}; for(const c of CITIES){ const m=c.name.match(/^(.+?市)(.+区)$/); if(m){ const k=c.pi+'|'+m[1]; (agg[k]=agg[k]||{pi:c.pi,name:m[1],pts:[]}).pts.push(c); } }
  for(const a of Object.values(agg)) CITIES.push({pi:a.pi,name:a.name,pref:PREFS[a.pi].name,lon:a.pts.reduce((s,c)=>s+c.lon,0)/a.pts.length,lat:a.pts.reduce((s,c)=>s+c.lat,0)/a.pts.length,agg:true}); })();
function pointInPref(lon,lat){
  for(const p of PREFS){ const b=p.bbox; if(lon<b[0]||lon>b[2]||lat<b[1]||lat>b[3]) continue;
    for(const r of p.rings){ let inside=false; for(let i=0,j=r.length-1;i<r.length;j=i++){ const [xi,yi]=r[i],[xj,yj]=r[j];
      if(((yi>lat)!==(yj>lat)) && lon<(xj-xi)*(lat-yi)/(yj-yi)+xi) inside=!inside; } if(inside) return p; } }
  return null;
}
// 住所文字列 → 位置（国土地理院 住所検索・オンライン）。結果が届いたら台帳を描き直す
const ADDR={q:'',res:[],timer:null,enter:''};
const normQ=q=>(q||'').normalize('NFKC').trim();
function lookupAddress(q){
  const t=normQ(q); if(t.length<2) return [];
  if(ADDR.q===t) return ADDR.res;
  clearTimeout(ADDR.timer);
  ADDR.timer=setTimeout(async()=>{ try{
      const r=await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q='+encodeURIComponent(t)); if(!r.ok) return;
      const j=await r.json(); ADDR.q=t;
      ADDR.res=(Array.isArray(j)?j:[]).filter(f=>f&&f.geometry&&f.properties).slice(0,3).map(f=>({label:f.properties.title,lon:+f.geometry.coordinates[0],lat:+f.geometry.coordinates[1],level:'国土地理院 住所検索'}));
      if(normQ(state.q)===t){ renderLedger(); if(ADDR.enter===t&&ADDR.res[0]&&!useG()){ const c=ADDR.res[0]; showMark(c.lon,c.lat,c.label); } }
      if(ADDR.enter===t) ADDR.enter='';
    }catch(e){ console.warn('address search',e); } },350);
  return [];
}

/* =====================================================================
   3. 地域係数（都道府県別・サンプル値）
   rain：雨天・休止率% ／ ws,we：冬期（積雪・凍結）期間の月 ／ wf：冬期の土工稼働率 ／ dExt：残土処分場までの標準距離km
   ===================================================================== */
const REGION_RAW = GEO.region;  // data/master.json（サンプル値）
const REGION = Object.fromEntries(Object.entries(REGION_RAW).map(([k,[rain,ws,we,wf,dExt]])=>[k,{rain,ws,we,wf,dExt}]));
const inWinter = (r,d) => { if(!r.ws) return false; const m=monthOf(d); return r.ws<=r.we ? (m>=r.ws&&m<=r.we) : (m>=r.ws||m<=r.we); };
const winterTxt = r => r.ws ? `${r.ws}月〜${r.we}月（土工稼働 ${Math.round(r.wf*100)}%）` : 'なし';

/* =====================================================================
   4. 現場（架空）定義：位置は港湾地区内の仮の施工範囲、地形は国土地理院 標高タイル
   ===================================================================== */
const BASE_DATE='2026-10-06', B=dn(BASE_DATE);
const T_MIN=dn('2025-06-01'), T_MAX=dn('2028-09-30');
const SOILS = { sand:{name:'砂質土',L:1.20,C:0.90}, clay:{name:'粘性土',L:1.30,C:0.90}, gravel:{name:'礫質土',L:1.20,C:0.95}, rock:{name:'軟岩',L:1.40,C:1.10} };

// 工種テンプレート（みらい建設工業：港湾・海岸・陸上土木・港湾建築）
// [名称, 開始日オフセット, 日数, 重み, 役割, 工法, 先行(任意)]
// cat：工種区分（台帳の絞り込み）／fh：計画地盤高の決め方（balance＝切盛バランス高、raise＝現況中央値＋raise、bldg＝現況中央値＋0.3m）
// 水域側の護岸・堤体は、現場データの sea（施工範囲のどの辺が水域に接するか）に合わせて配置する
const seaSeg=(w,d,sea,o)=> (sea==='E'||sea==='W')
  ? {kind:'seg',axis:'z',x:(sea==='W'?-1:1)*(w/2-o.off),z:0,w:o.thick,d:d*.92,y0:o.y0,h:o.h,n:o.n,role:'wall',col:o.col}
  : {kind:'seg',axis:'x',x:0,z:(sea==='N'?-1:1)*(d/2-o.off),w:w*.92,d:o.thick,y0:o.y0,h:o.h,n:o.n,role:'wall',col:o.col};
const KINDS = {
  yard:{type:'土木',cat:'港湾',label:'ふ頭ヤード整備',scale:'ヤード舗装 約2.5ha（As舗装・排水・照明）',fh:'balance',pit:0,pitLabel:'—',crane:false,mD:12,color:'#0ea5e9',
    blocks:(w,d)=>[-.3,0,.3].map(k=>({kind:'road',x0:-w*.44,x1:w*.44,z:d*k,w:d*.25,n:10,layer:'pave',role:'road'})),
    tasks:[['準備工',0,30,.04,'','仮設ヤード・既設舗装の切断、ふ頭利用者との調整'],['既設舗装撤去・切盛（土工）',30,110,.26,'earth','バックホウで撤去・不陸整正、発生材は場外搬出'],['地盤改良（表層）',140,60,.12,'','セメント系固化材による表層改良'],
      ['路盤・舗装',200,140,.38,'road','上層路盤・アスファルト舗装（区画ごとに供用切替）'],['排水・照明・付帯',280,100,.14,'','排水溝・照明塔・車止め'],['完成検査',380,30,.06,'','出来形・品質検査、引渡し']]},
  reclaim:{type:'土木',cat:'港湾',label:'ふ頭用地造成',scale:'ふ頭用地 嵩上げ造成（計画天端 現況＋1.5m）・護岸改良',fh:'raise',raise:1.5,pit:0,pitLabel:'—',crane:false,mD:10,color:'#6366f1',
    blocks:(w,d,sea)=>[seaSeg(w,d,sea,{off:4,thick:4,y0:-1.0,h:2.6,n:10,col:'#b7bcc4'}),{kind:'road',x0:-w*.4,x1:w*.4,z:0,w:12,n:8,layer:'pave',role:'road'}],
    tasks:[['準備工',0,40,.04,'','仮設・測量、既設護岸の調査'],['護岸改良',40,150,.18,'wall','既設護岸の嵩上げ・前面補強',0],['盛土・嵩上げ（土工）',100,220,.40,'earth','購入土・浚渫土の陸揚げ材で層厚30cm締固め',0],
      ['地盤改良',260,120,.12,'','バーチカルドレーン・プレロード（沈下対策）'],['排水・舗装',380,120,.20,'road','排水溝・場内道路舗装'],['完成検査',500,30,.06,'','出来形・沈下観測、引渡し']]},
  seawall:{type:'土木',cat:'海岸',label:'防潮堤・海岸堤防',scale:'海岸堤防 嵩上げ（天端 計画地盤＋3.5m）L=約220m・管理用通路',fh:'balance',pit:0,pitLabel:'—',crane:false,mD:8,color:'#14b8a6',
    blocks:(w,d,sea)=>{ const wall=seaSeg(w,d,sea,{off:10,thick:8,y0:0,h:3.5,n:12,col:'#c3c7cc'});
      return (sea==='E'||sea==='W') ? [wall] : [wall,{kind:'road',x0:-w*.44,x1:w*.44,z:wall.z-(sea==='N'?-1:1)*10,w:5,n:12,layer:'pave',role:'road'}]; },
    tasks:[['準備・仮設',0,40,.05,'','工事用道路・仮締切、近隣・漁協・港湾利用者への説明'],['床掘・盛土（土工）',40,90,.18,'earth','既設堤背面の床掘・盛土、発生土は場内流用'],['基礎工',120,90,.15,'','基礎コンクリート・止水矢板'],
      ['堤体工',190,200,.40,'wall','堤体コンクリート打設（ブロックごと）'],['天端・管理用通路',360,90,.14,'road','天端被覆・管理用通路舗装'],['完成検査',450,30,.08,'','出来形・品質検査、引渡し']]},
  road:{type:'土木',cat:'陸上土木',label:'臨港道路',scale:'臨港道路 改良 L=約250m（4車線・中央分離帯）',fh:'balance',pit:0,pitLabel:'—',crane:false,mD:6,color:'#f97316',
    blocks:(w,d)=>[{kind:'road',x0:-w*.48,x1:w*.48,z:-d*.17,w:10,n:12,layer:'pave',role:'road'},{kind:'road',x0:-w*.48,x1:w*.48,z:d*.17,w:10,n:12,layer:'pave',role:'road'},
      {kind:'seg',axis:'x',x:0,z:0,w:w*.9,d:1.6,y0:0,h:.35,n:12,role:'safety',col:'#d1d5db'}],
    tasks:[['準備工',0,30,.04,'','交通切替・仮設、港湾物流への影響調整'],['切盛（土工）',30,90,.20,'earth','路床までの切盛、発生土は場内流用'],['排水構造物',100,90,.14,'','側溝・集水桝・横断管'],
      ['路盤・舗装',180,120,.40,'road','下層・上層路盤、アスファルト舗装'],['安全施設・区画線',290,60,.14,'safety','中央分離帯・防護柵・区画線'],['完成検査',350,30,.08,'','出来形検査・供用']]},
  ind:{type:'土木',cat:'陸上土木',label:'産業用地造成',scale:'産業用地造成（単一造成高）・調整池',fh:'balance',pit:3,pitLabel:'調整池深さ',crane:false,mD:20,color:'#a855f7',
    blocks:(w,d)=>[{kind:'water',x:w*.33,z:d*.26,w:34,d:30,role:'pond',pond:true},
      {kind:'road',x0:-w*.38,x1:w*.2,z:-d*.1,w:10,n:8,layer:'pave',role:'road'},{kind:'road',x0:-w*.38,x1:w*.38,z:-d*.32,w:8,n:8,layer:'pave',role:'road'}],
    tasks:[['準備・伐採',0,45,.04,'','伐採・除根、工事用道路'],['切土・盛土（土工）',47,260,.38,'earth','丘陵部を切土し低地へ流用盛土'],['調整池',240,150,.10,'pond','掘込式調整池・放流施設',1],
      ['排水・場内道路',330,150,.18,'road','U型側溝・雨水管、場内道路舗装',1],['法面・緑化',450,90,.12,'green','法面整形・植生基材吹付',3],['完成検査',540,30,.18,'','出来形・品質検査、引渡し',4]]},
  whouse:{type:'建築',cat:'港湾建築',label:'港湾倉庫',scale:'S造 地上2階（荷さばき・保管）',fh:'bldg',pit:.8,pitLabel:'根切り深さ',crane:false,mD:8,color:'#10b981',
    blocks:(w,d)=>[{kind:'bldg',x:0,z:-6,w:Math.round(w*.74),d:Math.round(d*.6),n:2,uh:7.5,pitK:1}],
    tasks:[['準備工',0,30,.03,'','仮設事務所・測量'],['敷地造成（土工）',30,75,.08,'earth','不陸整正・場内流用'],['杭・基礎',105,90,.14,'found','鋼管杭（埋立地盤の支持層まで）・地中梁'],
      ['鉄骨・躯体',195,140,.28,'frame','移動式クレーンで鉄骨建方'],['外装',300,120,.14,'finish','折板屋根・外壁パネル・シャッター',3],['設備・内装',330,150,.25,'','冷蔵・荷役・防災設備',4],['外構・検査',480,60,.08,'','構内舗装・完了検査']]},
};
// 支店（担当組織）。港湾ごとの担当支店の割り当ては仮定（正式な所管は未確認）
const BRANCHES = {HK:'北海道支店',TH:'東北支店',TK:'東京支店',CB:'中部支店',OS:'大阪支店',CG:'中国支店',KS:'九州支店'};
// 現場（すべて架空）。並びは GEO.sel / GEO.terr と同じ
const SITE_DEFS = GEO.defs;  // data/sites.json（現場台帳。すべて架空）
const SITE_COLORS=['#3b82f6','#10b981','#8b5cf6','#e11d48','#0ea5e9','#f97316','#14b8a6','#a855f7','#eab308','#ec4899','#22c55e','#6366f1','#06b6d4','#f43f5e','#84cc16'];

/* =====================================================================
   5. ワールドモデル
   ===================================================================== */
// 5-1 稼働日カーブ（地域係数：雨天休止・冬期稼働率を反映）
function buildWorkCurve(s,p){
  const n=T_MAX-T_MIN+2, cw=new Float64Array(n), r=s.region;
  for(let i=1;i<n;i++){ const d=T_MIN+i-1; let f=p.days/7*(1-p.rain/100); if(inWinter(r,d)) f*=p.winterF/100; cw[i]=cw[i-1]+f; }
  return cw;
}
const Wd = (cw,d) => { const x=clamp(d-T_MIN,0,cw.length-1), i=Math.floor(x); return i>=cw.length-1?cw[cw.length-1]:lerp(cw[i],cw[i+1],x-i); };
function addWork(cw,d0,need){ const base=Wd(cw,d0); let lo=d0, hi=T_MAX; if(Wd(cw,hi)-base<need) return hi+Math.ceil((need-(Wd(cw,hi)-base))/.5);
  for(let k=0;k<40;k++){ const m=(lo+hi)/2; if(Wd(cw,m)-base>=need) hi=m; else lo=m; } return Math.ceil(hi); }

// 5-2 地形：現況 E（標高タイル）・計画面 D（計画地盤高＋根切り）
function buildTerrain(s){
  const t=s.terr, {w,d}=s.area, nx=t.nx, nz=t.nz, dx=w/nx, dz=d/nz, nv=(nx+1)*(nz+1);
  const E5=decI16(t.E), C=decI16(t.C), cn=t.cn, cw=t.cw;
  s.ctx={C,cn,cw,cmin:Math.min(...C),cmax:Math.max(...C)};
  const E=new Float32Array(nv), LX=new Float32Array(nv), LZ=new Float32Array(nv), R=new Float32Array(nv), VAR=new Float32Array(nv);
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++){
    const k=j*(nx+1)+i, x=-w/2+i*dx, z=-d/2+j*dz, ed=Math.min(w/2-Math.abs(x), d/2-Math.abs(z));
    E[k]=lerp(sampleCtx(s,x,z), E5[k], sm(ed/8)) - s.yRef;   // 境界は周辺地形（10m）へ連続させる
    LX[k]=x; LZ[k]=z; R[k]=i/nx; VAR[k]=.5+.5*Math.sin(i*12.9898+j*78.233)*Math.sin(i*3.1+j*1.7);
  }
  s.g={nx,nz,dx,dz,nv,E,D:new Float32Array(nv),LX,LZ,R,VAR,SL:new Float32Array(nv),H:new Float32Array(E)};
  buildDesign(s);
}
function sampleCtx(s,x,z){ // 周辺1km地形（絶対標高）
  const c=s.ctx, st=c.cw/c.cn, fx=clamp((x+c.cw/2)/st,0,c.cn-1e-4), fz=clamp((z+c.cw/2)/st,0,c.cn-1e-4), i=Math.floor(fx), j=Math.floor(fz), u=fx-i, v=fz-j, W=c.cn+1, C=c.C;
  return lerp(lerp(C[j*W+i],C[j*W+i+1],u), lerp(C[(j+1)*W+i],C[(j+1)*W+i+1],u), v);
}
function coreAt(s,x,z){
  const F=s.FH-s.yRef; let D=F;
  for(const b of s.blocks){
    if(b.kind==='bldg' && inRect(x,z,b.x,b.z,b.w+2,b.d+2)) D=Math.min(D, F-s.pit*(b.pitK??1));
    if(b.pond){ const di=Math.min(x-(b.x-b.w/2), (b.x+b.w/2)-x, z-(b.z-b.d/2), (b.z+b.d/2)-z); if(di>0) D=Math.min(D, Math.max(F-s.pit, F-di*.5)); }
  }
  return D;
}
function buildDesign(s){
  const g=s.g, {w,d}=s.area, mD=s.k.mD, W=g.nx+1;
  for(let k=0;k<g.nv;k++){ const x=g.LX[k], z=g.LZ[k], ed=Math.min(w/2-Math.abs(x), d/2-Math.abs(z)); g.D[k]=lerp(g.E[k], coreAt(s,x,z), sm(ed/mD)); }
  for(let j=0;j<=g.nz;j++) for(let i=0;i<=g.nx;i++){
    const k=j*W+i, i0=Math.max(0,i-1), i1=Math.min(g.nx,i+1), j0=Math.max(0,j-1), j1=Math.min(g.nz,j+1);
    g.SL[k]=Math.hypot((g.D[j*W+i1]-g.D[j*W+i0])/((i1-i0)*g.dx),(g.D[j1*W+i]-g.D[j0*W+i])/((j1-j0)*g.dz)); }
  // メッシュ法（四隅点高・遷移セル補正）
  const A=g.dx*g.dz; g.colCut=new Float64Array(g.nx); g.colFill=new Float64Array(g.nx); g.Vc=0; g.Vf=0;
  for(let j=0;j<g.nz;j++) for(let i=0;i<g.nx;i++){
    let P=0,N=0; for(const k of [j*W+i,j*W+i+1,(j+1)*W+i,(j+1)*W+i+1]){ const v=g.E[k]-g.D[k]; if(v>0)P+=v; else N-=v; }
    if(P+N<1e-9) continue; const c=A/4*P*P/(P+N), f=A/4*N*N/(P+N); g.colCut[i]+=c; g.colFill[i]+=f; g.Vc+=c; g.Vf+=f; }
  g.minH=Infinity; g.maxH=-Infinity; for(let k=0;k<g.nv;k++){ g.minH=Math.min(g.minH,g.E[k],g.D[k]); g.maxH=Math.max(g.maxH,g.E[k],g.D[k]); }
}

// 5-3 土量バランス・土積曲線
function earthBalance(s,p){
  const g=s.g, so=SOILS[p.soil], u=p.usable/100, Vc=g.Vc, Vf=g.Vf;
  const needNat=Vf/so.C, usableNat=Vc*u, sur=usableNat-needNat;
  const outNat=Math.max(0,sur)+Vc*(1-u), borrowNat=Math.max(0,-sur);
  const Q=Math.max(1,Vc+borrowNat), extNat=outNat+borrowNat, extFrac=extNat/Q;
  const outLoose=outNat*so.L, borrowLoose=borrowNat*so.L, n=g.nx, sup=[], dem=[];
  for(let i=0;i<n;i++){ sup.push(g.colCut[i]*u*so.C); dem.push(g.colFill[i]); }
  const gi=clamp(Math.floor((s.gate.x+s.area.w/2)/g.dx),0,n-1);
  const Sx=sup.reduce((a,b)=>a+b,0)-dem.reduce((a,b)=>a+b,0), sup2=sup.slice(), dem2=dem.slice(); if(Sx>0) dem2[gi]+=Sx; else sup2[gi]-=Sx;
  let M=0, Mr=0, cost=0; const curve=[], raw=[];
  for(let i=0;i<n;i++){ Mr+=sup[i]-dem[i]; raw.push(Mr); M+=sup2[i]-dem2[i]; curve.push(M); cost+=Math.abs(M)*g.dx; }
  const moved=sup2.reduce((a,b)=>a+b,0);
  return {so,u,Vc,Vf,needNat,usableNat,sur,outNat,borrowNat,Q,extNat,extFrac,outLoose,borrowLoose,
    tripsOut:Math.ceil(outLoose/p.cap),tripsIn:Math.ceil(borrowLoose/p.cap),sup,dem,raw,curve,gi,avgHaul:moved>0?cost/moved:0};
}
// 5-4 施工能力とボトルネック
function capacity(s,p,eb){
  const hf=p.hours/8, so=eb.so, ex=p.ex*p.qEx*hf, capNat=p.cap/so.L, dInt=Math.max(30,eb.avgHaul);
  const cycInt=4+(2*dInt/1000)/15*60+2, cycExt=5+(2*p.dExt)/30*60+3;
  const tpm=(eb.extFrac*cycExt+(1-eb.extFrac)*cycInt)/capNat, truck=p.trucks*p.hours*60*.85/tpm;
  const roller=eb.Vf>1?p.rollers*p.qR*hf*(eb.Q/eb.Vf):Infinity;
  const list=[['掘削・積込（バックホウ）',ex],['運搬（ダンプ）',truck],['敷均し・締固め（ローラ）',roller]];
  const min=Math.min(ex,truck,roller); return {ex,truck,roller,min,bn:list.find(x=>x[1]===min)[0],list,cycInt,cycExt,dInt,tpm};
}
const planP = (t,T) => clamp((T-t.ts)/t.dur,0,1);
// 5-5 観測による較正（η）
function calibrate(s){
  const p=s.p0, eb=earthBalance(s,p), cap=capacity(s,p,eb), t=s.tasks[s.earthIdx], cw=buildWorkCurve(s,p);
  if(t && t.a>0 && t.a<1){ const wd=Wd(cw,B)-Wd(cw,t.ts), ach=t.a*eb.Q/Math.max(1,wd); s.eta=clamp(ach/Math.max(1,cap.min),.35,1.15); s.etaSrc='obs'; s.achieved=ach; }
  else { s.eta=.8; s.etaSrc=t&&t.a>=1?'done':'prior'; }
}
// 5-6 遷移関数による工程ロールアウト
function forecast(s,p,eb,cap,cw){
  const out=[], rate=Math.max(1,s.eta*cap.min);
  s.tasks.forEach((t,i)=>{
    const pr=t.pred>=0?out[t.pred]:null, pt=t.pred>=0?s.tasks[t.pred]:null; let S,F;
    if(t.a>=1){ S=t.ts; F=Math.min(t.te,B); }
    else if(t.a>0){ S=t.ts;
      if(t.earth) F=addWork(cw,B,eb.Q*(1-t.a)/rate);
      else { const pp=planP(t,B), spi=pp>.05?clamp(t.a/pp,.5,1.3):1; F=B+Math.ceil((1-t.a)*t.dur/spi); } }
    else { S=Math.max(t.ts,B,pr?pr.F+(t.ts-pt.te):t.ts); F=t.earth?addWork(cw,S,eb.Q/rate):S+t.dur; }
    if(pr && t.a<1) F=Math.max(F,pr.F+Math.min(30,Math.max(0,t.te-pt.te)));
    F=Math.max(F,S+1); out.push({S,F});
  });
  return out;
}
function resources(s,p,eb,cap){
  const so=eb.so, rate=Math.max(1,s.eta*cap.min), t=s.tasks[s.earthIdx], workdays=eb.Q/rate;
  const tripsExt=(eb.outLoose+eb.borrowLoose)/p.cap, tripsInt=Math.max(0,eb.Q-eb.extNat)*so.L/p.cap;
  const truckKm=tripsExt*2*p.dExt+tripsInt*2*cap.dInt/1000, fuel=workdays*p.hours*(p.ex*15+p.rollers*8)+truckKm/3.5;
  return {rate,workdays,remWork:workdays*(1-(t?t.a:0)),tripsExt,tripsInt,truckKm,fuel,co2:fuel*2.58/1000,dailyExt:rate*eb.extFrac*so.L/p.cap};
}
function simulate(s,p){
  const eb=earthBalance(s,p), cap=capacity(s,p,eb), cw=buildWorkCurve(s,p), fc=forecast(s,p,eb,cap,cw), end=Math.max(...fc.map(x=>x.F));
  return {p,eb,cap,cw,fc,end,delay:end-s.planEnd,earthEnd:s.earthIdx>=0?fc[s.earthIdx].F:null,res:resources(s,p,eb,cap)};
}
// 5-7 状態 S(t)
function taskP(s,i,T,sim=s.cur){
  const t=s.tasks[i], f=sim.fc[i];
  if(t.earth){ const cw=sim.cw, W=d=>Wd(cw,d), r=(a,b,c)=>clamp((W(T)-W(a))/Math.max(1e-6,W(b)-W(a)),0,1);
    if(t.a>=1) return r(t.ts,f.F); if(t.a>0) return T<=B ? t.a*r(t.ts,B) : t.a+(1-t.a)*r(B,f.F); return r(f.S,f.F); }
  if(t.a>=1) return clamp((T-t.ts)/Math.max(1,f.F-t.ts),0,1);
  if(t.a>0){ if(T<=B) return t.a*clamp((T-t.ts)/Math.max(1,B-t.ts),0,1); return t.a+(1-t.a)*clamp((T-B)/Math.max(1,f.F-B),0,1); }
  return clamp((T-f.S)/Math.max(1,f.F-f.S),0,1);
}
function stateAt(s,T,sim=s.cur){
  const roles={}; let overall=0,plan=0,e=0;
  s.tasks.forEach((t,i)=>{ const p=taskP(s,i,T,sim); overall+=t.w*p; plan+=t.w*planP(t,T); if(t.role) roles[t.role]=p; if(t.earth) e=p; });
  return {T,overall,plan,e,roles,winter:inWinter(s.region,T)};
}
const actualAtBase = s => s.tasks.reduce((a,t)=>a+t.w*t.a,0);
const planAtBase = s => s.tasks.reduce((a,t)=>a+t.w*planP(t,B),0);

// 5-8 現場の生成（台帳）
const ID_SEQ={};
// 工事用ゲート：水域に接する辺の反対側（陸側）に置く
function gateFor(g){ const sea=g.sea;
  if(sea==='S') return {x:Math.round(g.w*.3),z:-g.d/2,ox:0,oz:-1};
  if(sea==='E') return {x:-g.w/2,z:Math.round(g.d*.2),ox:-1,oz:0};
  if(sea==='W') return {x:g.w/2,z:Math.round(g.d*.2),ox:1,oz:0};
  return {x:Math.round(g.w*.3),z:g.d/2,ox:0,oz:1}; }
const SITES = GEO.sel.map((g,i)=>{
  const def=SITE_DEFS[i], k=KINDS[g.kind], pref=PREFS.find(p=>p.name===g.pref);
  // 工事番号（仮採番）：支店コード-着工年度-連番。正式な採番規則は未決（MCDX-ADR-0008）
  const [sy,sm]=def.start.split('-').map(Number), fy=sm>=4?sy:sy-1, sq=(ID_SEQ[def.br+fy]=(ID_SEQ[def.br+fy]||0)+1);
  const s={ id:`${def.br}-${fy}-${String(sq).padStart(4,'0')}`, name:def.name, kind:g.kind, k, type:k.type, cat:k.cat,
    pref:g.pref, city:g.city, town:g.town, lgcode:g.lgcode, addr:`${g.pref}${g.city}${g.town}地先`, sea:g.sea||null,
    lon:g.lon, lat:g.lat, client:def.client, ccat:def.ccat, scale:k.scale, br:def.br, brName:BRANCHES[def.br], port:def.port,
    dept:`${BRANCHES[def.br]} 工事部 ${def.port}作業所`,
    color:SITE_COLORS[i%SITE_COLORS.length], area:{w:g.w,d:g.d}, rot:0, terr:GEO.terr[i], region:REGION[g.pref],
    gate:gateFor(g), perf:def.perf, soil:def.soil };
  const [X,Z]=toNat(s.lon,s.lat); s.nat=[X,Z];
  // 工程（ダミー実績は計画×施工効率から生成）
  const st=dn(def.start);
  s.tasks=k.tasks.map(([n,off,dur,w,role,m,pred],ti)=>({n,ts:st+off,te:st+off+dur,dur,w,role:role==='earth'?'':role,earth:role==='earth',m,pred:pred!==undefined?pred:ti-1}));
  s.tasks.forEach(t=>{ const pp=planP(t,B); let a = pp>=1 ? (B-t.te>45 ? 1 : Math.min(1, def.perf+(B-t.te)/45*(1-def.perf))) : clamp(pp*def.perf,0,1); t.a=Math.round(a*100)/100; if(t.a>.995) t.a=1; });
  s.planStart=Math.min(...s.tasks.map(t=>t.ts)); s.planEnd=Math.max(...s.tasks.map(t=>t.te)); s.earthIdx=s.tasks.findIndex(t=>t.earth);
  s.blocks=k.blocks(g.w,g.d,g.sea||'S'); s.pit=k.pit;
  if(k.crane){ const mb=s.blocks[0]; s.crane={x:mb.x,z:mb.z-(mb.d/2+7),h:mb.n*mb.uh+18,jib:Math.round(Math.max(mb.w,mb.d)*1.1)}; }
  // 計画地盤高：balance＝切盛バランス高（二分法）、raise＝現況中央値＋嵩上げ高、bldg＝現況中央値+0.3m
  s.yRef=Math.round(s.terr.emed*10)/10; s.FH=s.yRef; buildTerrain(s);
  const base={soil:def.soil,usable:85};
  if(k.fh==='balance'){ let lo=s.yRef-15, hi=s.yRef+15;
    for(let it=0;it<32;it++){ s.FH=(lo+hi)/2; buildDesign(s); const so=SOILS[base.soil]; if(s.g.Vc*base.usable/100*so.C-s.g.Vf>0) lo=s.FH; else hi=s.FH; }
    s.FH=Math.round(s.FH*10)/10; }
  else if(k.fh==='raise') s.FH=Math.round((s.terr.emed+k.raise)*10)/10;
  else s.FH=Math.round((s.terr.emed+.3)*10)/10;
  buildDesign(s); s.FH0=s.FH;
  s.grade=()=>s.FH-s.yRef;
  for(const b of s.blocks){ if(b.kind==='bldg') b.y0f=()=>b.basement?(s.FH-s.yRef)-s.pit*(b.pitK??1)+.8:(s.FH-s.yRef);
    if(b.kind==='seg') b.y0f=()=>(s.FH-s.yRef)+b.y0; if(b.kind==='water') b.y0f=()=>(s.FH-s.yRef)-s.pit+.3; }
  // 施工計画（行動 a）：地域係数を初期値とし、計画工期で終わる編成を自動設定
  const r=s.region, p={soil:def.soil,usable:85,cap:6.0,ex:1,qEx:300,trucks:1,dExt:r.dExt,rollers:1,qR:600,hours:8,days:6,rain:r.rain,winterF:Math.round(r.wf*100)};
  const t=s.tasks[s.earthIdx], cw=buildWorkCurve(s,p), eb=earthBalance(s,p), need=eb.Q/Math.max(5,Wd(cw,t.te)-Wd(cw,t.ts));
  p.ex=clamp(Math.round(need/(p.qEx*.8)+.3),1,8); const c1=capacity(s,{...p,trucks:1},eb); p.trucks=clamp(Math.round(need/(c1.truck*.8)+.3),1,40);
  if(isFinite(c1.roller)) p.rollers=clamp(Math.ceil(need/(c1.roller/p.rollers*.85)),1,6);
  s.p0={...p}; s.p={...p};
  calibrate(s); s.cur=simulate(s,s.p); s.base=s.cur;
  return s;
});
SITES.sort((a,b)=>a.id<b.id?-1:1);
function resim(s){ s.cur=simulate(s,s.p); worldDirty=true; }
function siteTop(s){ return Math.max(s.g.maxH, ...s.blocks.map(b=>b.kind==='bldg'?b.y0f()+b.n*b.uh:(b.y0f?b.y0f():s.FH-s.yRef)+(b.h||1)), s.crane?(s.FH-s.yRef)+s.crane.h:0); }

/* =====================================================================
   6. 状態（UI）
   ===================================================================== */
const state={ mode:'nation', sel:null, q:'', chip:'all', pref:'', br:'', T:B, playing:false, speed:30, tab:'earth', mark:null,
  layers:{heat:false,design:false,equip:true,route:true,crane:false,labels:true,roads:false,photo:false}, autoRotate:false, dockOpen:true };
let worldDirty=true, sceneDirty=true, uiDirty=true, terrainDirty=true, mapDirty=true;
const byId = id => SITES.find(s=>s.id===id);
const delayOf = s => s.cur.delay;
function matches(s){
  if(state.pref && s.pref!==state.pref) return false;
  if(state.br && s.br!==state.br) return false;
  if(['港湾','海岸','陸上土木','港湾建築'].includes(state.chip) && s.cat!==state.chip) return false;
  if(state.chip==='官公庁' && s.ccat==='民間') return false;
  if(state.chip==='民間' && s.ccat!=='民間') return false;
  if(state.chip==='delay' && delayOf(s)<=14) return false;
  if(state.chip==='wx' && !(wxLevel(s)>0)) return false;
  const q=normText(state.q); if(!q) return true;
  return [s.id,s.name,s.addr,s.client,s.ccat,s.cat,s.k.label,s.dept,s.port,s.brName].some(v=>normText(v).includes(q));
}
const filtered = () => SITES.filter(matches);
// 支店・都道府県の絞り込み（ポートフォリオ・サマリの集計範囲）
const inScope = s => (!state.br||s.br===state.br) && (!state.pref||s.pref===state.pref);
const scopeName = () => [state.br?BRANCHES[state.br]:'', state.pref].filter(Boolean).join('・') || '全社';
function delayBadge(s){ const d=delayOf(s);
  if(d>14) return `<span class="badge late">予測 +${d}日</span>`; if(d>0) return `<span class="badge warn">予測 +${d}日</span>`; return `<span class="badge ok">計画内</span>`; }
function setT(T){ state.T=clamp(T,T_MIN,T_MAX); worldDirty=true; uiDirty=true; }
function worldUpdate(){ for(const s of SITES) s.st=stateAt(s,state.T); worldDirty=false; sceneDirty=true; terrainDirty=true; }
for(const s of SITES) s.st=stateAt(s,state.T);

/* =====================================================================
   7. UI：台帳・サマリ・住所検索
   ===================================================================== */
function hl(text){ const q=state.q.trim(); if(!q) return esc(text); const i=text.toLowerCase().indexOf(q.toLowerCase()); if(i<0) return esc(text);
  return esc(text.slice(0,i))+'<mark>'+esc(text.slice(i,i+q.length))+'</mark>'+esc(text.slice(i+q.length)); }
(()=>{ const cnt={}; for(const s of SITES) cnt[s.pref]=(cnt[s.pref]||0)+1;
  $('#prefSel').innerHTML=`<option value="">全国（${SITES.length}現場）</option><optgroup label="現場のある都道府県">`+
    PREFS.filter(p=>cnt[p.name]).map(p=>`<option value="${p.name}">${p.name}（${cnt[p.name]}）</option>`).join('')+`</optgroup><optgroup label="その他">`+
    PREFS.filter(p=>!cnt[p.name]).map(p=>`<option value="${p.name}">${p.name}（0）</option>`).join('')+`</optgroup>`;
  const bc={}; for(const s of SITES) bc[s.br]=(bc[s.br]||0)+1;
  $('#brSel').innerHTML=`<option value="">全支店</option>`+Object.entries(BRANCHES).map(([k,n])=>`<option value="${k}">${n}（${bc[k]||0}）</option>`).join(''); })();
function setBranch(br){
  state.br=br; $('#brSel').value=br; mapDirty=true; sceneDirty=true; renderLedger(); renderSummary(); if(!state.sel) renderDock();
  if(state.mode!=='nation') return; const set=SITES.filter(s=>!br||s.br===br);
  if(!br||!set.length){ flyHome(1.6); return; }
  const b=[Math.min(...set.map(s=>s.lon))-.6,Math.min(...set.map(s=>s.lat))-.45,Math.max(...set.map(s=>s.lon))+.6,Math.max(...set.map(s=>s.lat))+.45];
  flyPref({main:b}); }
function setPref(name, fly=true){
  state.pref=name; $('#prefSel').value=name; mapDirty=true; sceneDirty=true; renderLedger(); renderSummary(); if(!state.sel) renderDock();
  if(fly && state.mode==='nation'){ const p=PREFS.find(x=>x.name===name);
    if(p) flyPref(p); else flyHome(1.6); }
}
function renderLedger(){
  const list=filtered(), T=state.T;
  $('#count').textContent=`表示 ${list.length} / ${SITES.length} 件`;
  $('#ledgerTitle').textContent=`現場台帳（${ds(T)}${T>B?'・予測':''}）`;
  let h='';
  const cand=(!useG() && state.q.trim().length>=2) ? lookupAddress(state.q) : [];  // Google 3D 表示中は Google 以外のジオコーディング結果を地図に出さない
  for(const c of cand) h+=`<div class="addr"><span>📍 <b>${esc(c.label)}</b><small>${esc(c.level)}（オンライン）</small></span><button class="btn" data-lon="${c.lon}" data-lat="${c.lat}" data-label="${esc(c.label)}">地図で表示</button></div>`;
  h+= list.length ? list.map(s=>{ const st=s.st, p=Math.round(st.overall*100), pl=Math.round(st.plan*100);
    return `<button class="row${state.sel===s.id?' sel':''}" data-id="${s.id}" role="option" aria-selected="${state.sel===s.id}">
      <div class="r1"><span class="dot" style="background:${s.color}"></span><span class="sid">${hl(s.id)}</span><span>${esc(s.cat)}・${esc(s.k.label)}</span>${delayBadge(s)}${wxBadge(s)}</div>
      <div class="nm">${hl(s.name)}</div><div class="ad">${hl(s.addr)}</div>
      <div class="r3"><div class="bar" title="${T>B?'予測':'実績'} ${p}% ／ 計画 ${pl}%"><i style="width:${p}%;background:${s.color}"></i><b style="left:calc(${pl}% - 1px)"></b></div><span>${p}%</span></div></button>`; }).join('')
    : `<div class="empty">該当する現場がありません</div>`;
  $('#list').innerHTML=h;
}
$('#list').addEventListener('click',e=>{
  const a=e.target.closest('[data-lon]'); if(a){ showMark(+a.dataset.lon,+a.dataset.lat,a.dataset.label); return; }
  const r=e.target.closest('.row'); if(r) select(r.dataset.id); });
function showMark(lon,lat,label){ state.mark={lon,lat,label}; if(state.sel) select(null,false); flyPoint(lon,lat); sceneDirty=true; }
function renderSummary(){
  const el=$('#summary'), s=byId(state.sel);
  if(!s){ const set=SITES.filter(inScope), late=set.filter(x=>delayOf(x)>14).length;
    const avg=set.length?Math.round(set.reduce((a,x)=>a+actualAtBase(x),0)/set.length*100):0, vc=set.reduce((a,x)=>a+x.g.Vc,0), out=set.reduce((a,x)=>a+x.cur.eb.outLoose,0);
    const r=state.pref?REGION[state.pref]:null;
    el.innerHTML=`<div class="dhead" style="margin-bottom:6px">${esc(scopeName())}（基準日 ${ds(B)}）</div>
      <div class="kpis"><div class="kpi"><div class="v">${set.length}</div><div class="l">稼働現場</div></div>
        <div class="kpi"><div class="v">${avg}%</div><div class="l">平均進捗（実績）</div></div>
        <div class="kpi"><div class="v ${late?'late':'ahead'}">${late}</div><div class="l">遅延予測（14日超）</div></div>
        <div class="kpi"><div class="v">${fmtN(vc/1000)}<small style="font-size:11px;color:var(--muted)"> 千m³</small></div><div class="l">切土量 合計（地山）</div><div class="s">残土 ${fmtN(out)} m³（ほぐし）</div></div></div>
      ${r?`<table class="t" style="margin-bottom:10px"><tr><td>雨天・休止率</td><td>${r.rain}%</td></tr><tr><td>冬期</td><td>${winterTxt(r)}</td></tr><tr><td>残土運搬距離</td><td>${r.dExt} km（標準）</td></tr></table>`:''}
      <p class="hint">日本地図の現場ピン、または台帳の行を選ぶと、その現場の3D（周辺は Google 実写3D）へ移動します。支店・都道府県・工種区分・発注区分で絞り込めます。${useG()?'Google 3D 表示中は、地図への住所表示（国土地理院の住所検索）を止めています（Google 以外のジオコーディングを併用しないため）。':'検索欄に住所を入れると、国土地理院の住所検索（オンライン）で位置を探します。'}</p>
      ${wxSummaryHTML()}${branchTable()}
      <div class="foot">工事名・発注者・工程・計画はすべて架空（サンプル）で、みらい建設工業の実際の工事ではありません。位置は実在の港湾地区内に置いた仮の施工範囲、施工範囲の地形は国土地理院の標高データ、周辺の街並みは Google の実写3D（オンライン）です。工事番号は仮採番、地域係数はサンプル値です。</div>`;
    return; }
  const a=Math.round(actualAtBase(s)*100), pl=Math.round(planAtBase(s)*100), d=delayOf(s);
  el.innerHTML=`<div class="dhead"><span class="dot" style="background:${s.color}"></span><span class="sid">${esc(s.id)}</span><span>・${esc(s.cat)}</span>${delayBadge(s)}</div>
    <h2>${esc(s.name)}</h2>
    <dl><dt>所在地</dt><dd>${esc(s.addr)}<br><span style="color:var(--muted);font-size:11px">${esc(s.port)}の港湾地区内に置いた仮の施工範囲（中心）。住所は国土地理院 逆ジオコーダ<br>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${s.sea?`／水域側：${({N:'北',S:'南',E:'東',W:'西'})[s.sea]}`:''}</span></dd>
      <dt>工事番号</dt><dd>${esc(s.id)} <span class="badge" style="margin-left:4px">仮採番</span></dd>
      <dt>担当</dt><dd>${esc(s.dept)}</dd>
      <dt>発注者</dt><dd>${esc(s.client)}<br><span style="color:var(--muted);font-size:11px">発注区分：${esc(s.ccat)}</span></dd><dt>工種・規模</dt><dd>${esc(s.k.label)}／${esc(s.scale)}</dd>
      <dt>計画工期</dt><dd>${ds(s.planStart)} 〜 ${ds(s.planEnd)}</dd>
      <dt>施工範囲</dt><dd>${s.area.w} × ${s.area.d} m</dd>
      <dt>計画地盤高</dt><dd>T.P. ${fmt1(s.FH)} m${s.pit?`／${esc(s.k.pitLabel)} ${fmt1(s.pit)} m`:''}</dd>
      <dt>現況地盤</dt><dd>T.P. ${fmt1(s.g.minH+s.yRef)}〜${fmt1(Math.max(...s.g.E)+s.yRef)} m（${esc(s.terr.src)}）</dd>
      <dt>表示高さ</dt><dd>${useG()?(s.geoCal?`Google 地表に合わせ補正済（ジオイド高 ${fmt1(s.geo)} m）`:`概算（ジオイド高 ${fmt1(s.geo)} m）・現場表示後に自動補正`):'簡易地形モード（国土地理院 標高）'}</dd>
      <dt>地域条件</dt><dd>雨天 ${s.region.rain}%／冬期 ${winterTxt(s.region)}</dd></dl>
    <div class="kpis"><div class="kpi"><div class="v">${a}%</div><div class="l">実績（基準日）</div><div class="s">計画 ${pl}%（${a-pl>=0?'+':''}${a-pl}pt）</div></div>
      <div class="kpi"><div class="v ${d>14?'late':d>0?'warnc':'ahead'}">${d>0?'+'+d:d}<small style="font-size:11px;color:var(--muted)"> 日</small></div><div class="l">竣工 遅延予測</div><div class="s">予測 ${ds(s.cur.end)}</div></div></div>
    <div class="btns"><button class="btn" id="goSite">現場を正面に</button><button class="btn ghost" id="goTop">真上から</button><button class="btn ghost" id="goNation">◀ 全国へ</button><button class="btn ghost" id="printSite">🖨 現場概要を印刷</button></div>`;
  $('#goSite').onclick=()=>flySite(s,siteView(s)); $('#goTop').onclick=()=>flySite(s,siteView(s,{pitch:1.53,yaw:0,ty:0})); $('#goNation').onclick=()=>select(null); $('#printSite').onclick=()=>printSite(s);
}
function select(id, doFly=true){
  const prev=state.sel; state.sel=id; sceneDirty=true; terrainDirty=true;
  const s=byId(id);
  if(s){ state.mark=null; enterSite(s, prev===null && doFly); }
  else if(state.mode==='site') enterNation(byId(prev));
  renderLedger(); renderSummary(); renderDock(); renderTools();
  const row=document.querySelector(`.row[data-id="${id}"]`); if(row) row.scrollIntoView({block:'nearest'});
}
$('#basedate').textContent=`基準日（実績の最終観測）${ds(B)}`;
if(GEO.fetched) $('#basedate').title=`データ取得 ${new Date(GEO.fetched.at).toLocaleString('ja-JP')}（国土地理院・自社サーバ）`;
$('#q').addEventListener('input',e=>{ state.q=e.target.value; renderLedger(); sceneDirty=true; });
$('#q').addEventListener('keydown',e=>{
  if(e.key==='Enter'){ const l=filtered(); if(l.length && state.q.trim()) select(l[0].id); else if(!useG()){ const c=lookupAddress(state.q)[0]; if(c) showMark(c.lon,c.lat,c.label); else ADDR.enter=normQ(state.q); } }
  if(e.key==='Escape'){ e.target.value=''; state.q=''; renderLedger(); sceneDirty=true; e.target.blur(); } });
$('#prefSel').addEventListener('change',e=>{ if(state.sel) select(null,false); setPref(e.target.value); });
$('#brSel').addEventListener('change',e=>{ if(state.sel) select(null,false); setBranch(e.target.value); });
$('#chips').addEventListener('click',e=>{ const c=e.target.closest('.chip'); if(!c) return;
  state.chip=c.dataset.chip; document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c)); renderLedger(); sceneDirty=true; });

/* =====================================================================
   8. タイムライン
   ===================================================================== */
const tlRange=$('#tlRange'); tlRange.min=T_MIN; tlRange.max=T_MAX; tlRange.step=1; tlRange.value=B;
const bp=(B-T_MIN)/(T_MAX-T_MIN)*100; tlRange.style.setProperty('--bp',bp+'%'); $('#tlBase').style.left=`calc(8px + (100% - 16px) * ${bp/100})`;
(()=>{ let h=''; for(const y of [2026,2027,2028]){ const p=(dn(`${y}-01-01`)-T_MIN)/(T_MAX-T_MIN); h+=`<span class="tlmark" style="left:calc(8px + (100% - 16px) * ${p})">${y}</span>`; }
  $('#tlwrap').insertAdjacentHTML('beforeend',h+`<span class="tlmark" style="left:calc(8px + (100% - 16px) * ${bp/100});bottom:-1px;color:#fff">基準日</span>`); })();
tlRange.addEventListener('input',()=>setT(+tlRange.value));
$('#tlNow').onclick=()=>{ state.playing=false; updPlayBtn(); setT(B); };
$('#tlPlay').onclick=togglePlay; $('#tlSpeed').onchange=e=>state.speed=+e.target.value;
function togglePlay(){ if(!state.playing && state.T>=T_MAX-1) setT(B); state.playing=!state.playing; updPlayBtn(); }
function updPlayBtn(){ $('#tlPlay').textContent=state.playing?'⏸ 停止':'▶ 再生'; }
function updateTimelineUI(){
  const T=state.T, pred=T>B; if(+tlRange.value!==Math.floor(T)) tlRange.value=Math.floor(T);
  $('#tlDate').textContent=ds(T); const m=$('#tlMode'); m.className='tlmode '+(pred?'pred':'obs'); m.textContent=pred?'予測（モデル）':'実績（観測）';
  const s=byId(state.sel), w=s&&s.st.winter&&s.region.ws?'・冬期':'';
  const f=$('#modeflag'); f.className='modeflag '+(pred?'pred':'obs');
  f.textContent=(pred?`予測（モデル） ${ds(T)}／基準日+${Math.floor(T-B)}日`:(Math.floor(T)===B?`実績（観測） ${ds(T)}`:`実績（観測・補間） ${ds(T)}`))+w;
}

/* =====================================================================
   9. ドック（管理パネル）
   ===================================================================== */
const TABS=[['earth','土量算出'],['plan','土工計画'],['const','施工計画'],['sched','工程管理'],['wm','ワールドモデル'],['wx','気象・海象'],['prog','実績入力（デモ）']];
function renderDock(){
  const s=byId(state.sel), tabs=$('#dtabs');
  tabs.innerHTML=(s?`<span class="dtitle"><span class="dot" style="background:${s.color}"></span> ${esc(s.id)}</span>`:`<span class="dtitle">${esc(scopeName())}のポートフォリオ</span>`)
    +TABS.map(([k,n])=>`<button class="dtab${s&&state.tab===k?' on':''}" data-tab="${k}" ${s?'':'disabled'}>${n}</button>`).join('')
    +`<button class="dclose" id="dclose">${state.dockOpen?'▼ 閉じる':'▲ 開く'}</button>`;
  tabs.querySelectorAll('.dtab').forEach(b=>b.onclick=()=>{ if(!s) return; state.tab=b.dataset.tab; if(!state.dockOpen) toggleDock(); renderDock(); });
  $('#dclose').onclick=toggleDock;
  if(!s){ $('#dockBody').innerHTML=portfolioHTML(); bindPortfolio(); return; }
  ({earth:renderEarthTab,plan:renderPlanTab,const:renderConstTab,sched:renderSchedTab,wm:renderWMTab,wx:renderWxTab,prog:renderProgTab})[state.tab](s);
}
function toggleDock(){ state.dockOpen=!state.dockOpen; $('#dock').classList.toggle('closed',!state.dockOpen); renderDock(); }
function refreshDockTime(){
  const s=byId(state.sel);
  if(!s){ const a=$('#pfBody'); if(a) a.innerHTML=portfolioTable(); const g=$('#pfGantt'); if(g) g.innerHTML=portfolioGantt(); return; }
  if(state.tab==='sched'){ $('#ganttBox').innerHTML=ganttSVG(s); $('#scurveBox').innerHTML=scurveSVG(s); bindGanttClick(s); }
  if(state.tab==='wm') $('#wmState').innerHTML=wmStateHTML(s);
  if(state.tab==='const') renderConstTab(s);
}
const FIELDS={ FH:['計画地盤高 FH','T.P. m',-50,3000,.1], pit:['根切り深さ','m',0,20,.1],
  soil:['土質',''], usable:['流用可能率','%',0,100,5], cap:['ダンプ積載（ほぐし）','m³/台',2,12,.5],
  ex:['バックホウ（0.7m³級）','台',0,12,1], qEx:['　日当り掘削積込','m³/台日',100,800,10], trucks:['ダンプトラック（10t）','台',0,60,1], dExt:['場外運搬距離','km',1,60,1],
  rollers:['ブルドーザ＋ローラ','組',0,8,1], qR:['　日当り締固め','m³/組日',200,1500,50], hours:['稼働時間','h/日',4,12,1], days:['稼働日','日/週',4,7,1],
  rain:['雨天・休止率','%',0,40,1], winterF:['冬期の土工稼働率','%',0,100,5] };
function fieldHTML(s,k,label){
  const [lab,unit,min,max,step]=FIELDS[k];
  if(k==='soil') return `<label for="f_soil">${lab}</label><span class="in"><select id="f_soil" data-k="soil">${Object.entries(SOILS).map(([key,v])=>`<option value="${key}"${s.p.soil===key?' selected':''}>${v.name}（L=${v.L.toFixed(2)}／C=${v.C.toFixed(2)}）</option>`).join('')}</select></span>`;
  const val = k==='FH'?s.FH : k==='pit'?s.pit : s.p[k];
  return `<label for="f_${k}">${label||lab}</label><span class="in"><input id="f_${k}" type="number" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${Math.round(val*10)/10}">${unit}</span>`;
}
function bindFields(s,onChange){
  $('#dockBody').querySelectorAll('[data-k]').forEach(el=>el.addEventListener(el.dataset.k==='FH'||el.dataset.k==='pit'?'change':'input',()=>{
    const k=el.dataset.k; let v=el.value;
    if(k!=='soil'){ v=parseFloat(v); if(!isFinite(v)) return; const [, ,min,max]=FIELDS[k]; v=clamp(v,min,max); }
    if(k==='FH'||k==='pit'){ s[k]=v; buildDesign(s); s.base=simulate(s,s.p0); terrainDirty=true; designDirty(s); }
    else s.p[k]=v;
    resim(s); uiDirty=true; renderLedger(); renderSummary(); onChange(); }));
  const r=$('#resetFleet'); if(r) r.onclick=()=>{ s.p={...s.p0}; s.FH=s.FH0; s.pit=s.k.pit; buildDesign(s); designDirty(s); s.base=simulate(s,s.p0); resim(s); terrainDirty=true; renderLedger(); renderSummary(); renderDock(); };
}
let designDirty=()=>{}, siteGL=()=>{};
const changed = s => JSON.stringify(s.p)!==JSON.stringify(s.p0)||s.FH!==s.FH0||s.pit!==s.k.pit;
const whatIfNote = s => changed(s) ? `<span class="badge warn" style="margin-left:0">What-if 適用中</span>` : `<span class="badge" style="margin-left:0">初期計画（較正済）</span>`;

function renderEarthTab(s){
  const g=s.g;
  $('#dockBody').innerHTML=`<div class="g3">
    <div class="card"><h3>切盛土量 <small>メッシュ法（四隅点高）・実地形</small></h3><div id="earthKpi"></div></div>
    <div class="card"><h3>切盛分布図 <small>計画面 − 現況</small></h3><canvas class="heat" id="heat"></canvas>
      <div class="hleg"><span>盛土</span><span class="grad"></span><span>切土</span><span>±4m</span></div>
      <div class="note">現況：国土地理院 ${esc(s.terr.src)}（${fmt1(g.dx)}m格子に補間、${g.nx}×${g.nz}セル）。計画面：計画地盤高＋${esc(s.k.pitLabel)}、外周 ${s.k.mD}m 幅で現況へすり付け（法面）。白枠は構造物、▲はゲート。</div></div>
    <div class="card"><h3>算出条件 ${whatIfNote(s)}</h3>
      <div class="form">${fieldHTML(s,'FH')}${s.k.pit?fieldHTML(s,'pit',s.k.pitLabel):''}<div class="sep"></div>${fieldHTML(s,'soil')}${fieldHTML(s,'usable')}${fieldHTML(s,'cap')}</div>
      <div id="earthBal" style="margin-top:10px"></div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="resetFleet">初期条件に戻す</button><button class="btn ghost" id="heatOn">3Dでヒートマップ</button></div></div></div>`;
  const upd=()=>{ $('#earthKpi').innerHTML=earthKpiHTML(s); $('#earthBal').innerHTML=earthBalHTML(s); drawHeat(s); };
  upd(); bindFields(s,upd); $('#heatOn').onclick=()=>setLayer('heat',true);
}
function earthKpiHTML(s){ const eb=s.cur.eb;
  return `<div class="tiles">
    <div class="tile cut"><div class="v">${fmtN(eb.Vc)}<small>m³</small></div><div class="l">切土量（地山）</div></div>
    <div class="tile fill"><div class="v">${fmtN(eb.Vf)}<small>m³</small></div><div class="l">盛土量（締固め後）</div></div>
    <div class="tile"><div class="v">${fmtN(eb.needNat)}<small>m³</small></div><div class="l">盛土に要する地山量 Vf/C</div></div>
    <div class="tile"><div class="v ${eb.sur>=0?'':'warnc'}">${eb.sur>=0?'+':''}${fmtN(eb.sur)}<small>m³</small></div><div class="l">${eb.sur>=0?'流用後の余剰（地山）':'不足＝搬入土（地山）'}</div></div>
    <div class="tile"><div class="v">${fmtN(eb.outLoose)}<small>m³</small></div><div class="l">残土搬出量（ほぐし）</div></div>
    <div class="tile"><div class="v">${fmtN(eb.tripsOut+eb.tripsIn)}<small>台</small></div><div class="l">場外ダンプ 延べ台数</div></div></div>`; }
function earthBalHTML(s){ const eb=s.cur.eb, so=eb.so;
  return `<table class="t"><tr><th>項目</th><th class="n">数量</th><th>式</th></tr>
    <tr><td>流用土（地山）</td><td class="n">${fmtN(eb.usableNat)}</td><td>Vc×${(eb.u*100).toFixed(0)}%</td></tr>
    <tr><td>場外搬出（ほぐし）</td><td class="n">${fmtN(eb.outLoose)}</td><td>（余剰＋不適）×L ${so.L.toFixed(2)}</td></tr>
    <tr><td>搬入土（購入土・浚渫土流用、ほぐし）</td><td class="n">${fmtN(eb.borrowLoose)}</td><td>不足×L</td></tr>
    <tr><td>取扱土量 Q（地山）</td><td class="n">${fmtN(eb.Q)}</td><td>Vc＋搬入土</td></tr></table>`; }
function drawHeat(s){
  const c=$('#heat'); if(!c) return; const g=s.g, sc=Math.max(2,Math.floor(320/g.nx)); c.width=g.nx*sc; c.height=g.nz*sc; const x=c.getContext('2d');
  for(let j=0;j<g.nz;j++) for(let i=0;i<g.nx;i++){ let v=0; for(const [a,b] of [[0,0],[1,0],[0,1],[1,1]]){ const k=(j+b)*(g.nx+1)+i+a; v+=g.E[k]-g.D[k]; } v/=4;
    const t=clamp(v/4,-1,1), col=t>0?mix([.97,.98,.99],hex('#dc2626'),t):mix([.97,.98,.99],hex('#2563eb'),-t);
    x.fillStyle=`rgb(${col.map(q=>Math.round(q*255)).join(',')})`; x.fillRect(i*sc,j*sc,sc,sc); }
  const X=lx=>(lx+s.area.w/2)/s.area.w*c.width, Y=lz=>(lz+s.area.d/2)/s.area.d*c.height;
  x.strokeStyle='rgba(15,23,42,.9)'; x.lineWidth=2;
  for(const b of s.blocks){ if(b.kind==='road') x.strokeRect(X(b.x0),Y(b.z-b.w/2),((b.x1-b.x0)/s.area.w)*c.width,(b.w/s.area.d)*c.height);
    else x.strokeRect(X(b.x-b.w/2),Y(b.z-b.d/2),(b.w/s.area.w)*c.width,(b.d/s.area.d)*c.height); }
  x.fillStyle='#f59e0b'; const gx=X(s.gate.x), gy=Y(s.gate.z)-6; x.beginPath(); x.moveTo(gx,gy+8); x.lineTo(gx-7,gy-5); x.lineTo(gx+7,gy-5); x.closePath(); x.fill();
  x.fillStyle='#0f172a'; x.font='bold 13px sans-serif'; x.fillText('N↑',6,16);
}
function renderPlanTab(s){
  $('#dockBody').innerHTML=`<div class="g3">
    <div class="card"><h3>機械編成・稼働条件 ${whatIfNote(s)}</h3>
      <div class="form">${['ex','qEx','trucks','dExt','rollers','qR','hours','days'].map(k=>fieldHTML(s,k)).join('')}<div class="sep"></div>${fieldHTML(s,'rain')}${s.region.ws?fieldHTML(s,'winterF'):''}</div>
      <div class="note">雨天・休止率・冬期稼働率・運搬距離の初期値は ${esc(s.pref)} の地域係数（サンプル値）。冬期：${winterTxt(s.region)}</div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="resetFleet">初期計画に戻す</button></div></div>
    <div class="card"><h3>施工能力とボトルネック <small>地山 m³/日</small></h3><div id="capBox"></div></div>
    <div class="card"><h3>土積曲線（マスカーブ） <small>締固め換算 m³</small></h3><div id="massBox"></div></div></div>`;
  const upd=()=>{ $('#capBox').innerHTML=capHTML(s); $('#massBox').innerHTML=massSVG(s)+massNote(s); }; upd(); bindFields(s,upd);
}
function capHTML(s){
  const c=s.cur.cap, r=s.cur.res, max=Math.max(...c.list.map(x=>isFinite(x[1])?x[1]:0),1), t=s.tasks[s.earthIdx], ef=s.cur.fc[s.earthIdx], eb=s.cur.eb;
  const bars=c.list.map(([n,v])=>`<div class="cbar${v===c.min?' bn':''}"><span>${n}</span><div class="track"><i style="width:${isFinite(v)?v/max*100:100}%"></i></div><span class="n">${isFinite(v)?fmtN(v):'—'}</span></div>`).join('');
  const etaTxt=s.etaSrc==='obs'?`実績から推定（基準日まで ${fmtN(s.achieved)} m³/稼働日）`:s.etaSrc==='done'?'土工完了済（参考値）':'観測なし：既定値';
  const status=t.a>=1?`<b class="ahead">土工完了（実績）</b>`:`完了予測 <b>${ds(ef.F)}</b>（計画 ${ds(t.te)}、<span class="${ef.F>t.te?'late':'ahead'}">${ef.F>t.te?'+':''}${ef.F-t.te}日</span>）`;
  return `${bars}<table class="t" style="margin-top:8px">
    <tr><td>ボトルネック</td><td><b class="warnc">${esc(c.bn)}</b></td></tr>
    <tr><td>実効率 η</td><td>${s.eta.toFixed(2)}（${etaTxt}）</td></tr>
    <tr><td>実効施工量</td><td>${fmtN(r.rate)} m³/稼働日</td></tr>
    <tr><td>土工所要</td><td>全体 ${fmtN(r.workdays)} 稼働日／残 ${fmtN(r.remWork)} 稼働日</td></tr>
    <tr><td>土工</td><td>${status}</td></tr>
    <tr><td>運搬サイクル</td><td>場内 ${fmt1(c.cycInt)} 分（平均 ${fmtN(c.dInt)} m）／場外 ${fmt1(c.cycExt)} 分</td></tr>
    <tr><td>場外ダンプ</td><td>${fmt1(r.dailyExt)} 台/日（ゲート通過 往復 ${fmtN(r.dailyExt*2)} 台/日）</td></tr></table>
    <div class="note">取扱土量 Q=${fmtN(eb.Q)} m³。稼働日は地域係数（雨天・冬期）で日々変化し、冬期は土工の進みが遅くなります。</div>`;
}
function massSVG(s){
  const eb=s.cur.eb, g=s.g, W=520, H=230, L=48, Rm=10, Tp=14, Bm=28, n=eb.curve.length;
  const vals=[0,...eb.raw], mx=Math.max(...vals), mn=Math.min(...vals), span=(mx-mn)||1, X=i=>L+(i+1)/n*(W-L-Rm), Y=v=>Tp+(mx-v)/span*(H-Tp-Bm);
  const bmax=Math.max(...eb.sup,...eb.dem,1), y0=Y(0); let bars='';
  for(let i=0;i<n;i++){ const bw=Math.max(1,(W-L-Rm)/n*.7), x=X(i)-(W-L-Rm)/n*.5, hs=eb.sup[i]/bmax*40, hd=eb.dem[i]/bmax*40;
    bars+=`<rect x="${x-bw/2}" y="${y0-hs}" width="${bw}" height="${hs}" fill="#dc2626" opacity=".55"/><rect x="${x-bw/2}" y="${y0}" width="${bw}" height="${hd}" fill="#2563eb" opacity=".55"/>`; }
  const pts=a=>a.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  let ticks=''; for(let k=0;k<=4;k++){ const v=mn+span*k/4; ticks+=`<line x1="${L}" x2="${W-Rm}" y1="${Y(v)}" y2="${Y(v)}" stroke="#22304d"/><text x="${L-4}" y="${Y(v)+3}" font-size="9.5" fill="#93a1bd" text-anchor="end">${fmt1(v/1000)}k</text>`; }
  let xl=''; for(let k=0;k<=4;k++){ const i=Math.round((n-1)*k/4); xl+=`<text x="${X(i)}" y="${H-12}" font-size="9.5" fill="#93a1bd" text-anchor="middle">${Math.round(-s.area.w/2+(i+1)*g.dx)}m</text>`; }
  const gx=X(eb.gi);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="土積曲線">${ticks}<line x1="${L}" x2="${W-Rm}" y1="${y0}" y2="${y0}" stroke="#64748b"/>${bars}
    <polyline points="${L},${y0} ${pts(eb.raw)}" fill="none" stroke="#f59e0b" stroke-width="2"/>
    <line x1="${gx}" x2="${gx}" y1="${Tp}" y2="${H-Bm}" stroke="#fde68a" stroke-dasharray="3 3"/><text x="${gx+3}" y="${Tp+9}" font-size="10" fill="#fde68a">ゲート</text>
    ${xl}<text x="${W-Rm}" y="${H-1}" font-size="9.5" fill="#93a1bd" text-anchor="end">測点（西→東）</text></svg>`;
}
function massNote(s){ const eb=s.cur.eb, end=eb.raw[eb.raw.length-1];
  return `<div class="note">曲線：累加土量（流用切土×C − 盛土）。柱：測点別 切土（赤）・盛土（青）。終点（${end>=0?'+':''}${fmtN(end)} m³）が余剰（＋）／不足（−）。ゲートで残土・搬入土を受け払いした場合の場内平均運搬距離は <b>${fmtN(eb.avgHaul)} m</b>。</div>`; }

function renderConstTab(s){
  const T=state.T, fc=s.cur.fc, r=s.cur.res, eb=s.cur.eb, p=s.p, rg=s.region;
  const steps=s.tasks.map((t,i)=>{ const pp=taskP(s,i,T), cls=pp>=1?'done':pp>0?'cur':'';
    return `<li class="${cls}"><span class="no">${pp>=1?'✓':i+1}</span><div><b>${esc(t.n)}</b> <span class="meta">${ds(fc[i].S)}〜${ds(fc[i].F)}（${Math.round(pp*100)}%）</span><div class="meta">${esc(t.m)}</div></div></li>`; }).join('');
  const per=2*(s.area.w+s.area.d), ef=s.tasks[s.earthIdx], act=ef&&ef.a<1, guards=1+(r.dailyExt*2>60?1:0)+(r.dailyExt*2>120?1:0);
  const crane=s.crane?`<tr><td>タワークレーン</td><td>作業半径 ${s.crane.jib} m／高さ ${Math.round(s.crane.h)} m</td></tr><tr><td>立入禁止範囲</td><td>半径 ${s.crane.jib+5} m（3D「揚重範囲」）</td></tr>`:`<tr><td>揚重</td><td>移動式クレーン（必要時に配置計画）</td></tr>`;
  $('#dockBody').innerHTML=`<div class="g3">
    <div class="card"><h3>施工手順 <small>${ds(T)} 時点・予測工程</small></h3><ul class="steps">${steps}</ul></div>
    <div class="card"><h3>地域条件・仮設・安全</h3><table class="t">
      <tr><td>所在地</td><td>${esc(s.pref)}${esc(s.city)}</td></tr>
      <tr><td>雨天・休止率</td><td>${p.rain}%（地域係数 ${rg.rain}%）</td></tr>
      <tr><td>冬期</td><td>${rg.ws?`${rg.ws}月〜${rg.we}月・土工稼働 ${p.winterF}%`:'積雪・凍結による休止なし'}${state.T&&s.st.winter&&rg.ws?' <b class="warnc">（表示時点は冬期）</b>':''}</td></tr>
      <tr><td>残土運搬距離</td><td>${p.dExt} km（地域標準 ${rg.dExt} km）</td></tr>
      <tr><td>仮囲い延長</td><td>約 ${fmtN(per)} m</td></tr>${crane}
      <tr><td>工事車両</td><td>${act?`場外ダンプ ${fmt1(r.dailyExt)} 台/日・往復 ${fmtN(r.dailyExt*2)} 台/日`:'土工完了・資材搬入のみ'}</td></tr>
      <tr><td>交通誘導員</td><td>${act?guards:1} 名（ゲート配置の目安）</td></tr></table>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" data-ly="route">3Dで搬出ルート</button><button class="btn ghost" data-ly="design">3Dで計画面</button></div></div>
    <div class="card"><h3>主要機械編成（土工） ${whatIfNote(s)}</h3><table class="t">
      <tr><th>機械</th><th class="n">台数</th><th class="n">能力</th></tr>
      <tr><td>バックホウ 0.7m³級</td><td class="n">${p.ex}</td><td class="n">${fmtN(s.cur.cap.ex)} m³/日</td></tr>
      <tr><td>ダンプトラック 10t</td><td class="n">${p.trucks}</td><td class="n">${fmtN(s.cur.cap.truck)} m³/日</td></tr>
      <tr><td>ブルドーザ＋ローラ</td><td class="n">${p.rollers}</td><td class="n">${isFinite(s.cur.cap.roller)?fmtN(s.cur.cap.roller)+' m³/日':'—'}</td></tr></table>
      <table class="t" style="margin-top:8px"><tr><td>土質</td><td>${eb.so.name}（L ${eb.so.L.toFixed(2)}／C ${eb.so.C.toFixed(2)}）</td></tr>
      <tr><td>燃料（土工全体）</td><td>約 ${fmtN(r.fuel/1000)} kL</td></tr><tr><td>CO₂（概算）</td><td>約 ${fmt1(r.co2)} t-CO₂</td></tr><tr><td>運搬走行距離</td><td>約 ${fmtN(r.truckKm)} km</td></tr></table>
      <div class="note">燃料原単位はサンプル値（バックホウ15 L/h、ローラ8 L/h、ダンプ3.5 km/L、軽油2.58 kg-CO₂/L）。</div></div></div>`;
  $('#dockBody').querySelectorAll('[data-ly]').forEach(b=>b.onclick=()=>setLayer(b.dataset.ly,true));
}
function renderSchedTab(s){
  $('#dockBody').innerHTML=`<div class="g2"><div class="card"><h3>ガントチャート <small>灰＝計画／色＝実績・予測（濃色は基準日実績）。クリックでワールド時刻を移動</small></h3><div id="ganttBox"></div></div>
    <div class="card"><h3>出来高曲線（Sカーブ）</h3><div id="scurveBox"></div><div id="schedNote"></div></div></div>`;
  $('#ganttBox').innerHTML=ganttSVG(s); $('#scurveBox').innerHTML=scurveSVG(s); bindGanttClick(s);
  const d=s.cur.delay; let i=s.cur.fc.findIndex(x=>x.F===s.cur.end); const ch=[]; while(i>=0&&ch.length<8){ const f=s.cur.fc[i], t=s.tasks[i]; ch.unshift(t.n+(f.F>t.te?`(+${f.F-t.te})`:'')); i=t.pred; }
  $('#schedNote').innerHTML=`<table class="t" style="margin-top:6px"><tr><td>計画竣工</td><td>${ds(s.planEnd)}</td></tr>
    <tr><td>予測竣工</td><td><b class="${d>14?'late':d>0?'warnc':'ahead'}">${ds(s.cur.end)}（${d>0?'+':''}${d}日）</b></td></tr>
    <tr><td>遅延の連鎖</td><td>${esc(ch.join(' → '))}</td></tr>${s.region.ws?`<tr><td>冬期</td><td>${winterTxt(s.region)}</td></tr>`:''}</table>`;
}
function ganttGeom(s){ const t0=s.planStart-20, t1=Math.max(s.planEnd,s.cur.end,s.base.end)+25, W=900, LW=170; return {t0,t1,W,LW,X:d=>LW+(d-t0)/(t1-t0)*(W-LW-12)}; }
function monthTicks(t0,t1,X,y1,y2,every,winter){
  let h=''; const d0=new Date(t0*DAY); let y=d0.getUTCFullYear(), m=d0.getUTCMonth()+1, k=0;
  for(;;){ const d=Math.round(Date.UTC(y,m,1)/DAY); if(d>t1) break;
    if(winter && inWinter(winter,d)){ const d2=Math.round(Date.UTC(m===11?y+1:y,(m+1)%12,1)/DAY); h+=`<rect x="${X(d)}" y="${y1}" width="${Math.max(0,X(Math.min(d2,t1))-X(d))}" height="${y2-y1}" fill="#60a5fa" opacity=".08"/>`; }
    if(k++%every===0){ const x=X(d); h+=`<line x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" stroke="#22304d"/><text x="${x+2}" y="${y1-4}" font-size="9.5" fill="#93a1bd">${ym(d)}</text>`; }
    m++; if(m>11){m=0;y++;} }
  return h;
}
function ganttSVG(s){
  const {t0,t1,W,LW,X}=ganttGeom(s), RH=28, Tp=28, H=Tp+s.tasks.length*RH+8, fc=s.cur.fc, col=s.color, T=state.T, months=(t1-t0)/30, every=months>26?3:months>14?2:1;
  let h=`<svg class="chart" id="gantt" viewBox="0 0 ${W} ${H}" style="cursor:crosshair" role="img" aria-label="ガントチャート">`+monthTicks(t0,t1,X,Tp-6,H-4,every,s.region.ws?s.region:null);
  s.tasks.forEach((t,i)=>{ const y=Tp+i*RH, f=fc[i], late=f.F-t.te;
    h+=`<text x="6" y="${y+17}" font-size="13" fill="#e2e8f0">${esc(t.n.length>10?t.n.slice(0,10)+'…':t.n)}</text>`;
    h+=`<rect x="${X(t.ts)}" y="${y+3}" width="${Math.max(1,X(t.te)-X(t.ts))}" height="5" rx="2" fill="#475569"/>`;
    const fx=X(f.S), fw=Math.max(2,X(f.F)-X(f.S));
    h+=`<rect x="${fx}" y="${y+10}" width="${fw}" height="13" rx="3" fill="${col}" fill-opacity=".28" stroke="${col}" stroke-opacity=".8"/>`;
    if(t.a>0) h+=`<rect x="${fx}" y="${y+10}" width="${fw*t.a}" height="13" rx="3" fill="${col}"/>`;
    h+=`<text x="${fx+fw+5}" y="${y+21}" font-size="12" fill="${late>14?'#fca5a5':late>0?'#fde68a':'#93a1bd'}">${Math.round(t.a*100)}%${late>0?`  +${late}日`:late<0?`  ${late}日`:''}${t.earth?'  ◆モデル予測':''}</text>`; });
  const xb=X(B), xt=X(T);
  h+=`<line x1="${xb}" x2="${xb}" y1="${Tp-4}" y2="${H-4}" stroke="#fff" stroke-dasharray="4 3"/><text x="${xb+3}" y="${H-6}" font-size="9.5" fill="#fff">基準日</text>`;
  h+=`<line x1="${xt}" x2="${xt}" y1="${Tp-4}" y2="${H-4}" stroke="#f59e0b" stroke-width="2"/><text x="${xt+3}" y="${Tp+7}" font-size="9.5" fill="#fde68a">${ds(T)}</text>`;
  if(s.region.ws) h+=`<text x="${W-8}" y="${H-6}" font-size="9.5" fill="#93c5fd" text-anchor="end">青帯＝冬期</text>`;
  return h+'</svg>';
}
function bindGanttClick(s){ const svg=$('#gantt'); if(!svg) return;
  svg.onclick=e=>{ const r=svg.getBoundingClientRect(), {t0,t1,W,LW}=ganttGeom(s), vx=(e.clientX-r.left)/r.width*W; if(vx<LW) return; setT(t0+(vx-LW)/(W-LW-12)*(t1-t0)); }; }
function scurveSVG(s){
  const {t0,t1}=ganttGeom(s), W=420, H=230, L=36, Rm=10, Tp=14, Bm=24, T=state.T, X=d=>L+(d-t0)/(t1-t0)*(W-L-Rm), Y=v=>Tp+(1-v)*(H-Tp-Bm);
  const pl=[], ac=[], pr=[], pb=[];
  for(let d=t0; d<=t1; d+=5){ const st=stateAt(s,d); pl.push(`${X(d).toFixed(1)},${Y(st.plan).toFixed(1)}`);
    if(d<=B) ac.push(`${X(d).toFixed(1)},${Y(st.overall).toFixed(1)}`); if(d>=B-5) pr.push(`${X(d).toFixed(1)},${Y(st.overall).toFixed(1)}`);
    if(d>=B && s.base!==s.cur) pb.push(`${X(d).toFixed(1)},${Y(stateAt(s,d,s.base).overall).toFixed(1)}`); }
  let h=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="出来高曲線">`;
  for(let k=0;k<=4;k++) h+=`<line x1="${L}" x2="${W-Rm}" y1="${Y(k/4)}" y2="${Y(k/4)}" stroke="#22304d"/><text x="${L-4}" y="${Y(k/4)+3}" font-size="9.5" fill="#93a1bd" text-anchor="end">${k*25}%</text>`;
  h+=monthTicks(t0,t1,X,Tp,H-Bm,99,s.region.ws?s.region:null);
  for(let d=t0, k=0; d<=t1; d+=1){ const dt=new Date(d*DAY); if(dt.getUTCDate()===1 && (dt.getUTCMonth()%6===0)) h+=`<text x="${X(d)}" y="${H-8}" font-size="9.5" fill="#93a1bd" text-anchor="middle">${ym(d)}</text>`; }
  h+=`<polyline points="${pl.join(' ')}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  if(pb.length) h+=`<polyline points="${pb.join(' ')}" fill="none" stroke="#64748b" stroke-width="1.4"/>`;
  h+=`<polyline points="${pr.join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 3"/><polyline points="${ac.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.4"/>`;
  const st=stateAt(s,T);
  h+=`<line x1="${X(B)}" x2="${X(B)}" y1="${Tp}" y2="${H-Bm}" stroke="#fff" stroke-dasharray="4 3" opacity=".7"/><line x1="${X(T)}" x2="${X(T)}" y1="${Tp}" y2="${H-Bm}" stroke="#f59e0b"/><circle cx="${X(T)}" cy="${Y(st.overall)}" r="4" fill="#f59e0b"/>`;
  h+=`<text x="${L+4}" y="${Tp+10}" font-size="10" fill="#94a3b8">┄ 計画</text><text x="${L+52}" y="${Tp+10}" font-size="10" fill="${s.color}">━ 実績</text><text x="${L+100}" y="${Tp+10}" font-size="10" fill="#fde68a">┅ 予測</text>${pb.length?`<text x="${L+148}" y="${Tp+10}" font-size="10" fill="#94a3b8">━ 初期計画の予測</text>`:''}`;
  return h+'</svg>';
}
function renderWMTab(s){
  $('#dockBody').innerHTML=`<div class="g3">
    <div class="card"><h3>ワールドモデルの構成 <small>観測→状態推定→遷移→予測→描画</small></h3>${wmDiagram()}
      <div class="note">状態 S(t)＝実地形（港湾地区の座標×標高タイル）・出来形・重機配置。基準日までは実績で較正（η・SPI）。以降は施工計画（行動 a）と地域係数（雨天・冬期）を含む遷移関数で日単位に予測します。</div></div>
    <div class="card"><h3>状態ベクトル S(t) <small>タイムラインに連動</small></h3><div id="wmState"></div></div>
    <div class="card"><h3>What-if（行動 a の比較）</h3><div id="wmWhatIf"></div>
      <div class="btns" style="margin-top:8px"><button class="btn" id="goPlan">編成を変更</button><button class="btn ghost" id="goEarth">計画地盤高を変更</button><button class="btn ghost" id="resetFleet">初期計画に戻す</button><button class="btn ghost" id="playFwd">予測を再生</button></div></div></div>`;
  $('#wmState').innerHTML=wmStateHTML(s); $('#wmWhatIf').innerHTML=wmWhatIfHTML(s);
  $('#goPlan').onclick=()=>{ state.tab='plan'; renderDock(); }; $('#goEarth').onclick=()=>{ state.tab='earth'; renderDock(); };
  $('#resetFleet').onclick=()=>{ s.p={...s.p0}; s.FH=s.FH0; s.pit=s.k.pit; buildDesign(s); designDirty(s); s.base=simulate(s,s.p0); resim(s); terrainDirty=true; renderLedger(); renderSummary(); renderDock(); };
  $('#playFwd').onclick=()=>{ setT(B); state.playing=true; updPlayBtn(); };
}
function wmDiagram(){
  const box=(x,y,w,a,b,c)=>`<rect x="${x}" y="${y}" width="${w}" height="38" rx="8" fill="#1b2945" stroke="${c}"/><text x="${x+w/2}" y="${y+16}" font-size="11" fill="#fff" text-anchor="middle" font-weight="600">${a}</text><text x="${x+w/2}" y="${y+30}" font-size="9.5" fill="#93a1bd" text-anchor="middle">${b}</text>`;
  const ar=(x1,y1,x2,y2)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1.5" marker-end="url(#ah)"/>`;
  return `<svg class="chart" viewBox="0 0 360 210" role="img" aria-label="ワールドモデル構成図"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#64748b"/></marker></defs>
    ${box(8,10,104,'観測 O(t)','実績・住所・標高','#22c55e')}${box(128,10,104,'状態推定','η・SPI の較正','#22c55e')}${box(248,10,104,'状態 S(t)','実地形・出来形・重機','#60a5fa')}
    ${box(248,86,104,'遷移 f(S,a,r)','能力×η×地域係数','#f59e0b')}${box(128,86,104,'予測 S(t+Δ)','日単位ロールアウト','#f59e0b')}${box(8,86,104,'行動 a','編成・計画地盤高','#e879f9')}
    ${box(68,162,224,'描画・意思決定','全国／3D／工程／土量／What-if','#94a3b8')}
    ${ar(112,29,128,29)}${ar(232,29,248,29)}${ar(300,48,300,86)}${ar(248,105,232,105)}${ar(112,105,248,112)}${ar(180,124,180,162)}</svg>`;
}
function wmStateHTML(s){
  const T=state.T, st=stateAt(s,T), eb=s.cur.eb, e=st.e, rows=[];
  rows.push(['時刻 t',`${ds(T)}（${T>B?'予測':'実績'}）${st.winter&&s.region.ws?'・冬期':''}`]);
  rows.push(['全体進捗',`${(st.overall*100).toFixed(1)}%（計画 ${(st.plan*100).toFixed(1)}%）`]);
  rows.push(['土工進捗 e',`${(e*100).toFixed(1)}%`]);
  rows.push(['切土 累計',`${fmtN(eb.Vc*e)} / ${fmtN(eb.Vc)} m³`]); rows.push(['盛土 累計',`${fmtN(eb.Vf*e)} / ${fmtN(eb.Vf)} m³`]);
  rows.push(['場外ダンプ 累計',`${fmtN((eb.tripsOut+eb.tripsIn)*e)} 台`]);
  const daily=s.p.days/7*(1-s.p.rain/100)*(st.winter&&s.region.ws?s.p.winterF/100:1);
  rows.push(['稼働日係数',`${daily.toFixed(2)}（雨天${s.p.rain}%${st.winter&&s.region.ws?`・冬期${s.p.winterF}%`:''}）`]);
  rows.push(['稼働重機',e>.001&&e<.999?`BH ${s.p.ex}・DT ${s.p.trucks}・転圧 ${s.p.rollers}`:'（土工なし）']);
  s.tasks.forEach((t,i)=>{ if(!t.earth) rows.push([t.n,`${(taskP(s,i,T)*100).toFixed(0)}%`]); });
  rows.push(['竣工予測',`${ds(s.cur.end)}（${s.cur.delay>0?'+':''}${s.cur.delay}日）`]);
  return `<table class="t">${rows.map(([a,b])=>`<tr><td style="color:var(--muted)">${esc(a)}</td><td>${b}</td></tr>`).join('')}</table>`;
}
function wmWhatIfHTML(s){
  const a=s.base, b=s.cur, et=s.tasks[s.earthIdx], df=(x,y)=>{ const d=y-x; return d===0?'±0':(d>0?'+':'')+d; };
  const row=(n,x,y,fmt,unit,better)=>{ const d=y-x, cls=Math.abs(d)<1e-9?'':((better==='lower'?d<0:d>0)?'ahead':'late');
    return `<tr><td>${n}</td><td class="n">${fmt(x)}${unit}</td><td class="n">${fmt(y)}${unit}</td><td class="n ${cls}">${Math.abs(d)<1e-9?'—':(d>0?'+':'')+fmt(d)}</td></tr>`; };
  return `<table class="t"><tr><th>指標</th><th class="n">初期計画</th><th class="n">現在の a</th><th class="n">差</th></tr>
    <tr><td>土工完了</td><td class="n">${et.a>=1?'完了':ds(a.earthEnd)}</td><td class="n">${et.a>=1?'完了':ds(b.earthEnd)}</td><td class="n ${b.earthEnd<a.earthEnd?'ahead':b.earthEnd>a.earthEnd?'late':''}">${et.a>=1?'—':df(a.earthEnd,b.earthEnd)+'日'}</td></tr>
    <tr><td>竣工予測</td><td class="n">${ds(a.end)}</td><td class="n">${ds(b.end)}</td><td class="n ${b.end<a.end?'ahead':b.end>a.end?'late':''}">${df(a.end,b.end)}日</td></tr>
    ${row('切土量',a.eb.Vc,b.eb.Vc,fmtN,'','lower')}${row('残土（ほぐし）',a.eb.outLoose,b.eb.outLoose,fmtN,'','lower')}
    ${row('実効施工量',a.res.rate,b.res.rate,fmtN,'','higher')}${row('場外ダンプ/日',a.res.dailyExt,b.res.dailyExt,fmt1,'','lower')}${row('CO₂（土工）',a.res.co2,b.res.co2,fmt1,'t','lower')}</table>
    <div class="note">${et.a>=1?'土工は完了済のため、編成変更は工程に影響しません（計画地盤高の変更は土量のみ再計算）。':`ボトルネック：${esc(b.cap.bn)}。計画地盤高を上下させると切盛バランスと残土量が変わります。`}</div>`;
}
function portfolioHTML(){
  return `<div class="g2b"><div class="card"><h3>現場別サマリ <small>${ds(state.T)} 時点・行クリックで現場へ</small><button class="btn ghost" id="csvOut" style="margin-left:auto">CSV 出力</button></h3><div id="pfBody">${portfolioTable()}</div></div>
    <div class="card"><h3>地域条件（現場のある都道府県） <small>サンプル値</small></h3>${regionTable()}<h3 style="margin-top:12px">全現場の工程 <small>灰＝計画／色＝予測</small></h3><div id="pfGantt">${portfolioGantt()}</div></div></div>`;
}
function portfolioTable(){ const set=SITES.filter(inScope);
  return `<table class="t"><tr><th>工事番号</th><th>工事名</th><th>担当支店</th><th class="n">進捗</th><th class="n">計画</th><th class="n">切土</th><th class="n">盛土</th><th class="n">残土</th><th>予測竣工</th></tr>`+
    set.map(s=>{ const st=s.st, d=s.cur.delay; return `<tr class="click" data-id="${s.id}"><td><span class="dot" style="background:${s.color}"></span> ${s.id}</td><td><div class="pfname" title="${esc(s.name)}">${esc(s.name)}</div></td><td class="nw">${esc(s.brName)}</td>
      <td class="n">${Math.round(st.overall*100)}%</td><td class="n">${Math.round(st.plan*100)}%</td><td class="n">${fmtN(s.g.Vc)}</td><td class="n">${fmtN(s.g.Vf)}</td><td class="n">${fmtN(s.cur.eb.outLoose)}</td>
      <td class="nw ${d>14?'late':d>0?'warnc':'ahead'}">${ds(s.cur.end)}（${d>0?'+':''}${d}日）</td></tr>`; }).join('')+`</table><div class="note">土量 m³（切土：地山、盛土：締固め後、残土：ほぐし）。工事番号は仮採番。</div>`; }
function branchTable(){ const rows=Object.entries(BRANCHES).filter(([k])=>!state.br||k===state.br).map(([k,n])=>{ const set=SITES.filter(s=>s.br===k&&(!state.pref||s.pref===state.pref)); if(!set.length) return '';
    const late=set.filter(s=>delayOf(s)>14).length, avg=Math.round(set.reduce((a,s)=>a+actualAtBase(s),0)/set.length*100);
    return `<tr><td>${esc(n)}</td><td class="n">${set.length}</td><td class="n">${avg}%</td><td class="n ${late?'late':''}">${late}</td></tr>`; }).join('');
  return rows?`<table class="t" style="margin-bottom:10px"><tr><th>支店</th><th class="n">現場</th><th class="n">平均進捗</th><th class="n">遅延予測</th></tr>${rows}</table>`:''; }
function regionTable(){ const prefs=[...new Set(SITES.filter(inScope).map(s=>s.pref))];
  return `<table class="t"><tr><th>都道府県</th><th class="n">雨天休止</th><th>冬期（土工稼働）</th><th class="n">残土距離</th></tr>`+
    prefs.map(p=>{ const r=REGION[p]; return `<tr><td>${esc(p)}</td><td class="n">${r.rain}%</td><td>${r.ws?`${r.ws}〜${r.we}月（${Math.round(r.wf*100)}%）`:'—'}</td><td class="n">${r.dExt}km</td></tr>`; }).join('')+`</table>`; }
function portfolioGantt(){ const set=SITES.filter(inScope); if(!set.length) return '<div class="empty">現場がありません</div>';
  const t0=Math.min(...set.map(s=>s.planStart))-15, t1=Math.max(...set.map(s=>Math.max(s.planEnd,s.cur.end)))+20, W=640, LW=150, RH=22, Tp=24, H=Tp+set.length*RH+6, X=d=>LW+(d-t0)/(t1-t0)*(W-LW-10);
  let h=`<svg class="chart" viewBox="0 0 ${W} ${H}">`+monthTicks(t0,t1,X,Tp-6,H-4,3);
  set.forEach((s,i)=>{ const y=Tp+i*RH; h+=`<text x="6" y="${y+14}" font-size="10.5" fill="#e2e8f0">${esc(s.id)} ${esc(s.port)}</text>
    <rect x="${X(s.planStart)}" y="${y+2}" width="${X(s.planEnd)-X(s.planStart)}" height="4" rx="2" fill="#475569"/>
    <rect x="${X(s.planStart)}" y="${y+8}" width="${X(s.cur.end)-X(s.planStart)}" height="10" rx="3" fill="${s.color}" fill-opacity=".3" stroke="${s.color}"/>
    <rect x="${X(s.planStart)}" y="${y+8}" width="${(X(s.cur.end)-X(s.planStart))*s.st.overall}" height="10" rx="3" fill="${s.color}"/>`; });
  return h+`<line x1="${X(B)}" x2="${X(B)}" y1="${Tp-4}" y2="${H-4}" stroke="#fff" stroke-dasharray="4 3"/><line x1="${X(state.T)}" x2="${X(state.T)}" y1="${Tp-4}" y2="${H-4}" stroke="#f59e0b" stroke-width="2"/></svg>`; }
function bindPortfolio(){ $('#dockBody').onclick=e=>{ if(e.target.closest('#csvOut')){ exportCSV(); return; } const r=e.target.closest('tr.click'); if(r) select(r.dataset.id); }; }

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

/* ---- 実績入力（デモ）：このブラウザにだけ保存。サーバには送らない ---- */
const PROG_KEY='mirai-kensetsu-portal-progress-demo-v1';
const progLoad=()=>{ try{ return JSON.parse(localStorage.getItem(PROG_KEY)||'{}')||{}; }catch(e){ return {}; } };
const progSave=o=>{ try{ localStorage.setItem(PROG_KEY,JSON.stringify(o)); return true; }catch(e){ return false; } };
const PROG0={}; for(const s of SITES) PROG0[s.id]=s.tasks.map(t=>t.a);
function progApply(s,vals){ s.tasks.forEach((t,i)=>{ if(vals&&vals[i]!=null&&isFinite(vals[i])) t.a=clamp(Math.round(vals[i]*100)/100,0,1); });
  calibrate(s); s.base=simulate(s,s.p0); s.cur=simulate(s,s.p); worldDirty=true; sceneDirty=true; terrainDirty=true; uiDirty=true; }
(()=>{ const saved=progLoad(); for(const s of SITES) if(saved[s.id]&&Array.isArray(saved[s.id].a)) progApply(s,saved[s.id].a); })();
function renderProgTab(s){
  const saved=progLoad()[s.id];
  $('#dockBody').innerHTML=`<div class="g2"><div class="card"><h3>実績進捗の入力 <small>基準日 ${ds(B)} 時点の各工程の出来高（%）</small></h3>
    <table class="t"><tr><th>工程</th><th>工法</th><th class="n">計画</th><th class="n">初期値</th><th class="n">実績 %</th></tr>
    ${s.tasks.map((t,i)=>`<tr><td class="nw">${esc(t.n)}</td><td>${esc(t.m||'')}</td><td class="n">${Math.round(planP(t,B)*100)}%</td><td class="n">${Math.round(PROG0[s.id][i]*100)}%</td>
      <td class="n"><input type="number" min="0" max="100" step="1" value="${Math.round(t.a*100)}" data-pi="${i}" style="width:64px;background:#0a1323;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 6px;text-align:right"></td></tr>`).join('')}</table>
    <div class="btns" style="margin-top:8px"><button class="btn" id="progApply">反映して予測し直す</button><button class="btn ghost" id="progReset">初期値に戻す</button></div></div>
    <div class="card"><h3>保存とやり取り</h3>
      <div class="hint" style="margin-bottom:8px"><span class="badge warn" style="margin-left:0">デモ</span> 画面の現場は架空です。入力は<b>このブラウザにだけ</b>保存され、サーバや他の人には送られません。共有するときは JSON ファイルで書き出して渡します。</div>
      <div class="hint">この現場の保存：${saved?`${new Date(saved.at).toLocaleString('ja-JP')}`:'なし'}</div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" id="progExport">全現場の入力を書き出す（JSON）</button><label class="btn ghost" style="cursor:pointer">読み込む（JSON）<input type="file" id="progImport" accept="application/json,.json" hidden></label></div>
      <div class="note">反映すると、実績から実効率 η を較正し直し、竣工予測・遅延・3D の出来形が変わります（ワールドモデルの計算は同じ）。</div></div></div>`;
  const body=$('#dockBody');
  $('#progApply').onclick=()=>{ const v=[...body.querySelectorAll('[data-pi]')].map(el=>clamp(parseFloat(el.value)/100,0,1));
    progApply(s,v); const o=progLoad(); o[s.id]={a:s.tasks.map(t=>t.a),at:new Date().toISOString()}; const ok=progSave(o);
    renderLedger(); renderSummary(); renderProgTab(s); if(!ok) toast('このブラウザでは保存できませんでした（プライベートモードなど）。反映はこの画面を閉じるまで有効です。'); };
  $('#progReset').onclick=()=>{ progApply(s,PROG0[s.id]); const o=progLoad(); delete o[s.id]; progSave(o); renderLedger(); renderSummary(); renderProgTab(s); };
  $('#progExport').onclick=()=>download(`現場実績_デモ_${localDate()}.json`,'application/json',JSON.stringify({kind:'mirai-portal-progress-demo',note:'架空現場のデモ入力',exportedAt:new Date().toISOString(),sites:progLoad()},null,1));
  $('#progImport').onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); if(j.kind!=='mirai-portal-progress-demo'||typeof j.sites!=='object') throw new Error('形式が違います');
      const o=progLoad(); let n=0; for(const [id,v] of Object.entries(j.sites)){ const x=byId(id); if(x&&v&&Array.isArray(v.a)&&v.a.length===x.tasks.length&&v.a.every(a=>typeof a==='number'&&a>=0&&a<=1)){ progApply(x,v.a); o[id]={a:x.tasks.map(t=>t.a),at:v.at||new Date().toISOString()}; n++; } }
      progSave(o); renderLedger(); renderSummary(); renderProgTab(s); toast(`${n} 現場の実績を読み込みました。`,5000); }
    catch(err){ toast('読み込めませんでした：'+esc(err.message||err)); } };
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

/* =====================================================================
   10. 3Dビュー（CesiumJS ＋ Google Photorealistic 3D Tiles）
   - 周辺の街並み・地形：Google Map Tiles API（Photorealistic 3D Tiles）※オンライン専用
   - 施工範囲：Google の 3D を切り抜き（ClippingPolygon）、自社の地形・構造物・重機を重ねる
   - キーが無い／接続できない場合：簡易地形モード（国土地理院の標高による周辺1km地形）
   ===================================================================== */
const C3 = window.Cesium;
// 公開サーバに置いて第三者に共有する場合：HTTPリファラ制限（そのURLのみ）と API 制限（Map Tiles API のみ）をかけたキーを
// ここに入れておくと、閲覧者はキー入力なしで表示できます。個人のキーを制限なしで入れたまま配布しないでください。
const EMBED_GOOGLE_KEY = (window.PORTAL_CONFIG&&String(window.PORTAL_CONFIG.googleMapTilesKey||'').trim())||'';  // data/config.json（サーバにだけ置く）
const KEY_STORE = 'mirai-kensetsu-site-portal-google3d-key';
const lsGet = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
const lsSet = (k,v) => { try { if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); } catch(e){} };
const G = { viewer:null, scene:null, camera:null, tileset:null, google:false, locked:null, flying:false, ptrDown:false, failShown:false, fail:0 };
state.layers.g3d = true;
const useG = () => G.google && state.layers.g3d;

// ジオイド高（楕円体高 − 標高）の初期概算。Google 地表との比較で現場ごとに自動補正する。
const GEOID0 = {'北海道':31,'宮城県':38,'東京都':37,'神奈川県':37,'愛知県':38,'静岡県':40,'大阪府':37,'兵庫県':37,'広島県':35,'岡山県':36,'福岡県':33,'熊本県':33};
for(const s of SITES){ s.geo = GEOID0[s.pref] ?? 36; s.geoCal = false; }
// 都道府県の本土側（最大リング）の範囲：飛び地・離島を除いて移動先を決める
for(const p of PREFS){ let best=p.rings[0]; for(const r of p.rings) if(r.length>best.length) best=r;
  const b=[999,999,-999,-999]; for(const [x,y] of best){ b[0]=Math.min(b[0],x); b[1]=Math.min(b[1],y); b[2]=Math.max(b[2],x); b[3]=Math.max(b[3],y); } p.main=b; }

function trs(x,y,z,ry,sx,sy,sz){ const c=Math.cos(ry),s=Math.sin(ry), f=v=>Math.abs(v)<1e-3?(v<0?-1e-3:1e-3):v; sx=f(sx); sy=f(sy); sz=f(sz);
  return new Float32Array([c*sx,0,-s*sx,0,0,sy,0,0,s*sz,0,c*sz,0,x,y,z,1]); }
function sampleH(s,lx,lz){ const g=s.g, fx=(lx+s.area.w/2)/g.dx, fz=(lz+s.area.d/2)/g.dz;
  if(fx<0||fz<0||fx>g.nx||fz>g.nz) return sampleCtx(s,lx,lz)-s.yRef;
  const i=Math.min(Math.floor(fx),g.nx-1), j=Math.min(Math.floor(fz),g.nz-1), u=fx-i, v=fz-j, W=g.nx+1, H=g.H;
  return lerp(lerp(H[j*W+i],H[j*W+i+1],u), lerp(H[(j+1)*W+i],H[(j+1)*W+i+1],u), v); }

/* ---- 座標変換：現場ローカル（x=東, y=上, z=南, 原点＝施工範囲中心・T.P.=yRef）→ 地球中心座標 ---- */
let P_YUP=null, P_INV=null; const _m1=[], _m2=[];
function siteFrame(s){ // ローカル(y-up) → ECEF
  if(!s.fr || s.frGeo!==s.geo){ s.enu=C3.Transforms.eastNorthUpToFixedFrame(C3.Cartesian3.fromDegrees(s.lon,s.lat,s.yRef+s.geo));
    s.fr=C3.Matrix4.multiply(s.enu,P_YUP,new C3.Matrix4()); s.frGeo=s.geo; s.pinPos=null; }
  return s.fr; }
function enuAt(s,ty){ return C3.Transforms.eastNorthUpToFixedFrame(C3.Cartesian3.fromDegrees(s.lon,s.lat,s.yRef+s.geo+ty)); }
function L2W(s,x,y,z,res){ return C3.Matrix4.multiplyByPoint(siteFrame(s), new C3.Cartesian3(x,y,z), res||new C3.Cartesian3()); }
function itemMatrix(s,m,res){ C3.Matrix4.fromArray(m,0,_m1); C3.Matrix4.multiply(siteFrame(s),_m1,_m2); return C3.Matrix4.multiply(_m2,P_INV,res||new C3.Matrix4()); }
function pinPos(s){ siteFrame(s); if(!s.pinPos) s.pinPos=C3.Cartesian3.fromDegrees(s.lon,s.lat,s.yRef+s.geo+2); return s.pinPos; }

/* ---- 表示モードの切替（ヘッダーの状態表示） ---- */
function setStatus(kind,msg){
  const el=$('#netStatus'); el.className='net '+kind;
  el.textContent={init:'3D 準備中',loading:'Google 3D 接続中…',google:'Google 実写3D（オンライン）',simple:'簡易地形モード',error:'Google 3D 未接続',nolib:'3D 表示不可'}[kind]||kind;
  el.title=msg||({google:'周辺の街並み・地形は Google Map Tiles API（Photorealistic 3D Tiles）。工事・計画はすべて架空です。',simple:'Google 3D を使わず、国土地理院の標高データによる周辺1kmの地形で表示しています。',error:msg}[kind]||'');
  renderLedger(); renderSummary();
}
let toastTimer=0;
function toast(msg,ms=7000){ const t=$('#toast'); t.innerHTML=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.hidden=true,ms); }

/* ---- Google 3D の接続 ---- */
async function connectGoogle(key){
  if(!G.viewer||!key) return false;
  setStatus('loading');
  try{
    const ts=await C3.createGooglePhotorealistic3DTileset({key, onlyUsingWithGoogleGeocoder:true},  // ジオコーダは未使用（Google 表示中は ABR 住所の地図表示も停止）
      {cacheBytes:512*1024*1024, maximumCacheOverflowBytes:256*1024*1024, showCreditsOnScreen:true});
    if(G.tileset){ G.scene.primitives.remove(G.tileset); }
    G.tileset=ts; G.scene.primitives.add(ts); G.google=true; G.fail=0; G.failShown=false;
    ts.tileFailed.addEventListener(()=>{ G.fail++; if(G.fail>=6&&!G.failShown){ G.failShown=true;
      toast('一部の Google 3D タイルを取得できません。<br>1日の上限（クォータ）・請求先・キーのリファラ制限・ネットワークを確認してください。',10000); } });
    applyClip(); mapDirty=true; setStatus('google'); renderTools(); renderLegend();
    const s=byId(state.sel); if(s){ s.geoCal=false; calibrateGeoid(s); }
    return true;
  }catch(e){
    G.google=false; console.warn(e);
    setStatus('error','Google 3D に接続できませんでした（詳細は APIキー画面）');
    const d=await diagnoseGoogle(key,e);
    toast(`Google 3D に接続できませんでした：${esc(d.title)}<br>簡易地形モードで表示しています。原因と対処は APIキー画面に表示しました。`,12000);
    openKeyDialog(d, key);
    return false;
  }
}
// 接続できなかった原因を調べる（Google の応答コードとエラーメッセージから日本語の対処を出す）
async function diagnoseGoogle(key,err){
  const page=location.origin+location.pathname, out={title:'', steps:[], raw:''};
  if(location.protocol==='file:'){ out.title='ファイルを直接開いています'; out.steps=['このファイルは Web サーバに置いて https:// で開いてください（GitHub Pages、社内Webサーバなど）。','手元で試すだけなら、ファイルのあるフォルダで <code>python -m http.server 8000</code> を実行し、<code>http://localhost:8000/ファイル名.html</code> を開きます。その場合、キーのリファラ制限に <code>http://localhost:8000/*</code> を追加してください。']; }
  let r=null;
  try{ r=await fetch('https://tile.googleapis.com/v1/3dtiles/root.json?key='+encodeURIComponent(key),{cache:'no-store'}); }
  catch(e2){
    if(!out.title){ out.title='Google のサーバ（tile.googleapis.com）に接続できません'; }
    out.steps.push('この画面をどこで開いているか確認してください。Claude アプリ内のプレビューやメール添付のプレビューでは外部への通信が止められます。ブラウザ（Chrome / Edge）で URL を開いてください。',
      '社内ネットワークのプロキシ・UTM（FortiGate の Webフィルタ／SSLインスペクション等）で <code>tile.googleapis.com</code> と <code>cdn.jsdelivr.net</code> が許可されているか確認してください。',
      'スマホのテザリングなど社外回線で同じ URL を開いて表示できれば、社内ネットワーク側の制限です。');
    out.raw=String(err&&err.message||err||e2);
    return out; }
  let msg='', reason='';
  try{ const j=await r.clone().json(); msg=(j.error&&j.error.message)||''; reason=JSON.stringify(j.error&&j.error.details||'').match(/"reason":"([A-Z_]+)"/)?.[1]||(j.error&&j.error.status)||''; }catch(e3){}
  out.raw=`HTTP ${r.status}${reason?' '+reason:''}：${msg}`.slice(0,400);
  if(r.ok){ out.title=out.title||'キーは有効ですが、3D の初期化で失敗しました'; out.steps.push('ページを再読み込みしてもう一度試してください。続く場合は下の詳細を担当者に伝えてください。'); out.raw+=' ／ '+String(err&&(err.message||err.statusCode)||err).slice(0,300); return out; }
  const m=(msg+' '+reason).toLowerCase();
  if(r.status===400||m.includes('api_key_invalid')||m.includes('not valid')){ out.title='APIキーが無効です'; out.steps.push('キーをコピーし直してください（前後の空白・改行に注意）。作成直後は有効になるまで数分かかることがあります。'); }
  else if(m.includes('referer')||m.includes('referrer')){ out.title='HTTPリファラ制限でこのページが許可されていません'; out.steps.push(`Cloud Console → APIとサービス → 認証情報 → このキー → 「ウェブサイトの制限」に <code>${esc(location.origin)}/*</code> を追加してください（反映まで最大5分）。ブラウザは Google へサイト名（<code>${esc(location.origin)}/</code>）だけを送るので、フォルダ名まで入れた登録では一致しません。`); }
  else if(m.includes('has not been used')||m.includes('is disabled')||m.includes('service_disabled')||m.includes('not been enabled')){ out.title='Map Tiles API が有効になっていません'; out.steps.push('Cloud Console → APIとサービス → ライブラリ で「Map Tiles API」を検索し「有効にする」を押してください（キーを作ったのと同じプロジェクトで）。'); }
  else if(m.includes('billing')){ out.title='プロジェクトに請求先アカウントが設定されていません'; out.steps.push('Cloud Console → お支払い で、キーのプロジェクトに請求先アカウントをリンクしてください。あわせて予算アラートと1日の上限も設定してください。'); }
  else if(m.includes('api_key_service_blocked')||m.includes('blocked')){ out.title='キーの「API の制限」で Map Tiles API が許可されていません'; out.steps.push('認証情報 → このキー → 「API の制限」で <b>Map Tiles API</b> にチェックを入れて保存してください。'); }
  else if(r.status===404){ out.title='キーは有効ですが、このキーのプロジェクトで 3D Tiles を使える状態になっていません'; out.steps.push('まず「お支払い」で、キーのプロジェクトに<b>請求先アカウントがリンクされているか</b>確認してください（いちばん多い原因です。無料枠だけで使う場合もリンクが必要）。','Cloud Console 上部のプロジェクト選択が、キーを作ったプロジェクトになっているか確認してください。','そのプロジェクトで「APIとサービス → 有効な API」に <b>Map Tiles API</b> があるか確認し、なければ有効にしてください。','直らない場合は、Google Maps Platform の「キーと認証情報」から新しいキーを作り直して試してください。'); }
  else if(r.status===429||m.includes('quota')||m.includes('rate')){ out.title='利用上限（クォータ）に達しています'; out.steps.push('Cloud Console → Map Tiles API → 割り当て で上限を確認してください。日付が変わると回復します。'); }
  else { out.title=out.title||`Google が接続を拒否しました（HTTP ${r.status}）`; out.steps.push('下の詳細メッセージを確認してください。Map Tiles API の有効化・請求先・キーの制限の3点を見直すと多くの場合解決します。'); }
  return out;
}
function disconnectGoogle(){ if(G.tileset){ G.scene.primitives.remove(G.tileset); G.tileset=null; } G.google=false; setStatus('simple'); mapDirty=true; renderTools(); renderLegend(); }

/* ---- APIキー入力ダイアログ ---- */
function openKeyDialog(diag,triedKey){
  const d=$('#keyDlg'); d.hidden=false; $('#keyErr').hidden=true;
  const k=lsGet(KEY_STORE); $('#keyIn').value=triedKey||k||''; $('#keySave').checked=true; $('#keyForget').hidden=!k;
  const dg=$('#keyDiag'); dg.hidden=!(diag&&typeof diag==='object'&&diag.title);
  if(!dg.hidden) dg.innerHTML=`<b>接続できなかった原因：${esc(diag.title)}</b><ol>${diag.steps.map(t=>`<li>${t}</li>`).join('')}</ol>`+
    `<div class="diagRaw">このページのURL：<code>${esc(location.href.split('#')[0].split('?')[0])}</code><br>詳細：${esc(diag.raw||'—')}</div>`;
  setTimeout(()=>$('#keyIn').focus(),30);
}
function closeKeyDialog(){ $('#keyDlg').hidden=true; }
$('#keyBtn').onclick=()=>openKeyDialog();
$('#keyOk').onclick=async()=>{
  const k=$('#keyIn').value.trim(); if(!/^[A-Za-z0-9_\-]{20,80}$/.test(k)){ const e=$('#keyErr'); e.textContent='APIキーの形式が正しくないようです（例：AIza で始まる39文字）。'; e.hidden=false; return; }
  const save=$('#keySave').checked; closeKeyDialog(); const ok=await connectGoogle(k); if(ok) lsSet(KEY_STORE,save?k:null);
};
$('#keyIn').addEventListener('keydown',e=>{ if(e.key==='Enter') $('#keyOk').click(); if(e.key==='Escape') $('#keySkip').click(); });
$('#keySkip').onclick=()=>{ closeKeyDialog(); if(!G.google) setStatus(G.viewer?'simple':'nolib'); };
$('#keyForget').onclick=()=>{ lsSet(KEY_STORE,null); $('#keyIn').value=''; $('#keyForget').hidden=true; disconnectGoogle(); };

/* ---- 施工範囲の切り抜き（Google 3D の該当範囲を非表示にして自社の地形を見せる） ---- */
function applyClip(){
  if(!G.tileset) return; const s=byId(state.sel);
  if(state.mode!=='site'||!s){ G.tileset.clippingPolygons=undefined; return; }
  const hw=s.area.w/2+.6, hd=s.area.d/2+.6;
  const pos=[[-hw,-hd],[hw,-hd],[hw,hd],[-hw,hd]].map(([x,z])=>L2W(s,x,0,z));
  G.tileset.clippingPolygons=new C3.ClippingPolygonCollection({polygons:[new C3.ClippingPolygon({positions:pos})]});
}

/* ---- 現場の地表高さを Google 地表に合わせる（ジオイド高の自動補正） ---- */
async function calibrateGeoid(s){
  if(!useG()||s.geoCal||s.calRunning||!G.scene.sampleHeightSupported) return;
  s.calRunning=true;
  try{
    const pts=[], ref=[];
    for(const k of [1.2,1.5,1.9]) for(let a=0;a<16;a++){ const ang=(a+k*3)/16*2*Math.PI, x=Math.cos(ang)*(s.area.w/2*k+12), z=Math.sin(ang)*(s.area.d/2*k+12);
      if(Math.abs(x)>470||Math.abs(z)>470) continue; pts.push(C3.Cartographic.fromCartesian(L2W(s,x,0,z))); ref.push(sampleCtx(s,x,z)); }
    const res=await G.scene.sampleHeightMostDetailed(pts, siteObjects());
    const diffs=res.map((c,i)=>c&&isFinite(c.height)?c.height-ref[i]:NaN).filter(isFinite).sort((a,b)=>a-b);
    if(diffs.length>=8){
      const g=diffs[Math.floor(diffs.length*.2)];   // 建物・樹木の上に当たった点を避けて下位20%を採用
      if(g>15&&g<60){ const changed=Math.abs(g-s.geo)>.25; s.geo=Math.round(g*10)/10; s.geoCal=true;
        if(changed&&state.sel===s.id){ const keep=currentHPR(); clearSite(); ensureSite(s); applyClip(); setSiteLight(s); terrainDirty=true; sceneDirty=true;
          if(G.locked&&keep) lockSite(s,G.locked.ty,keep); }
        if(state.sel===s.id) renderSummary(); }
    }
  }catch(e){ console.warn('geoid calibration',e); }
  s.calRunning=false;
}

/* ---- カメラ ---- */
const HOME={lon:136.6,lat:35.2,heading:0,pitch:-1.12,range:3.3e6};
function siteView(s,over={}){ const R=Math.max(s.area.w,s.area.d), H=Math.max(10,siteTop(s)); return {ty:(s.FH-s.yRef)+H*.25,yaw:.75,pitch:.55,dist:(R*1.15+H*1.1+40)*1.25,...over}; }
function unlock(){ if(G.camera){ G.camera.lookAtTransform(C3.Matrix4.IDENTITY); } G.locked=null; }
function flyAround(center,heading,pitch,range,dur,done){
  if(!G.camera) { if(done) done(); return; }
  unlock(); G.flying=true;
  G.camera.flyToBoundingSphere(new C3.BoundingSphere(center,1),{offset:new C3.HeadingPitchRange(heading,pitch,range),duration:dur,
    complete:()=>{ G.flying=false; if(done) done(); }, cancel:()=>{ G.flying=false; }});
}
function flyHome(dur=2){ if(!G.camera) return; flyAround(C3.Cartesian3.fromDegrees(HOME.lon,HOME.lat,0),HOME.heading,HOME.pitch,HOME.range,dur); }
function flyPref(p,dur=1.8){ if(!G.camera) return; const b=p.main, lat=(b[1]+b[3])/2, dx=(b[2]-b[0])*Math.cos(lat*Math.PI/180)*111e3, dy=(b[3]-b[1])*111e3;
  flyAround(C3.Cartesian3.fromDegrees((b[0]+b[2])/2,lat,0),0,-1.0,clamp(Math.max(dx,dy)*1.7,1.2e5,2.4e6),dur); }
function flyPoint(lon,lat){ if(!G.camera) return; flyAround(C3.Cartesian3.fromDegrees(lon,lat,0),0,-.95,5000,2); }
function lockSite(s,ty,hpr){ if(!G.camera) return; G.camera.lookAtTransform(enuAt(s,ty),hpr); G.locked={id:s.id,ty}; }
function flySite(s,v,dur=1.4){ if(!G.camera) return; const c=L2W(s,0,v.ty,0), hpr=new C3.HeadingPitchRange(-v.yaw,-v.pitch,v.dist);
  flyAround(c,hpr.heading,hpr.pitch,hpr.range,dur,()=>{ if(state.sel===s.id&&state.mode==='site'){ lockSite(s,v.ty,hpr); calibrateGeoid(s); } }); }
function currentHPR(){ if(!G.camera||!G.locked) return null; const p=G.camera.position, r=C3.Cartesian3.magnitude(p); if(!(r>0)) return null;
  return new C3.HeadingPitchRange(Math.atan2(-p.x,-p.y), -Math.asin(clamp(p.z/r,-1,1)), r); }
function currentYaw(){ return G.camera ? -G.camera.heading : 0; }
function enterSite(s,viaNation){
  state.mode='site'; ensureSite(s); applyClip(); setSiteLight(s); sceneDirty=true; terrainDirty=true;
  flySite(s,siteView(s),viaNation?2.8:2.0); renderTools(); renderLegend();
}
function enterNation(s){
  state.mode='nation'; clearSite(); applyClip(); renderTools(); renderLegend(); sceneDirty=true; if(!G.camera) return;
  if(state.pref){ const p=PREFS.find(x=>x.name===state.pref); if(p){ flyPref(p,2.2); return; } }
  if(s) flyAround(pinPos(s),0,-1.1,1.6e6,2.4); else flyHome();
}
function renderTools(){
  const g3=G.google?`<button data-layer="g3d" class="${state.layers.g3d?'on':''}" title="Google 実写3D の表示／非表示">Google 3D</button>`:'';
  $('#tools').innerHTML = state.mode==='site'
    ? `<button class="back" data-view="nation">◀ 全国へ</button><button data-view="site">現場正面</button><button data-view="bird">俯瞰</button><button data-view="top">真上</button><button data-view="eye">水平</button><button data-view="spin" class="${state.autoRotate?'on':''}">自動回転</button>`
    : `<button data-view="all">日本全体</button><button data-view="top">真上</button><button data-view="bird">斜め</button>`;
  $('#layers').innerHTML = g3 + (state.mode==='site'
    ? [['heat','切盛ヒートマップ'],['design','計画面'],['equip','重機'],['route','搬出ルート'],['labels','ラベル'],['photo','航空写真']].map(([k,n])=>`<button data-layer="${k}" class="${state.layers[k]?'on':''}">${n}</button>`).join('')
    : [['photo','航空写真'],['roads','県境・高速道路'],['labels','ラベル']].map(([k,n])=>`<button data-layer="${k}" class="${state.layers[k]?'on':''}">${n}</button>`).join(''));
  $('#help').innerHTML = state.mode==='site'
    ? `<b>左ドラッグ</b> 現場の周りを回る　<b>右ドラッグ/ホイール</b> ズーム<br><b>中ドラッグ/Ctrl+ドラッグ</b> 傾き　<b>Esc</b> 全国へ　<b>Space</b> 再生`
    : `<b>ピン/ラベル</b> 現場へ　<b>都道府県クリック</b> 絞り込み<br><b>左ドラッグ</b> 移動　<b>右ドラッグ/ホイール</b> ズーム　<b>Ctrl+ドラッグ</b> 傾き`;
  const fe=$('#fiction'); fe.hidden = !(state.mode==='site'); fe.textContent = useG() ? '工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）／周辺は Google の実写3D（実在）' : '工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）';
}
$('#tools').addEventListener('click',e=>{ const b=e.target.closest('[data-view]'); if(b) applyView(b.dataset.view); });
function applyView(v){
  const s=byId(state.sel);
  if(v==='nation'){ select(null); return; }
  if(v==='all'){ if(state.pref) setPref('',false); flyHome(); return; }
  if(v==='spin'){ state.autoRotate=!state.autoRotate; renderTools(); return; }
  if(state.mode==='site' && s){ const t=siteView(s,{yaw:currentYaw()});
    if(v==='site') flySite(s,siteView(s)); if(v==='bird') flySite(s,{...t,pitch:.62},1); if(v==='top') flySite(s,{...t,pitch:1.53,dist:t.dist*1.05},1); if(v==='eye') flySite(s,{...t,pitch:.1,dist:t.dist*.85},1); }
  else if(G.camera){ const c=G.camera, pc=C3.Cartographic.fromCartesian(c.positionWC);
    const ray=c.getPickRay(new C3.Cartesian2(G.scene.canvas.clientWidth/2,G.scene.canvas.clientHeight/2)), hit=ray&&G.scene.globe.ellipsoid?C3.IntersectionTests.rayEllipsoid(ray,C3.Ellipsoid.WGS84):null;
    const tgt=hit?C3.Ray.getPoint(ray,hit.start):C3.Cartesian3.fromRadians(pc.longitude,pc.latitude,0), range=C3.Cartesian3.distance(c.positionWC,tgt);
    flyAround(tgt,c.heading,v==='top'?-1.5:-.8,range,1); }
}
$('#compass').addEventListener('click',()=>{ if(!G.camera) return;
  if(G.locked){ const s=byId(G.locked.id), ty=G.locked.ty, h=currentHPR();
    if(s&&h) flyAround(L2W(s,0,ty,0),0,h.pitch,h.range,.7,()=>{ if(state.sel===s.id&&state.mode==='site') lockSite(s,ty,new C3.HeadingPitchRange(0,h.pitch,h.range)); }); }
  else G.camera.flyTo({destination:G.camera.positionWC,orientation:{heading:0,pitch:G.camera.pitch,roll:0},duration:.7}); });
function setLayer(k,on){ state.layers[k]=on; document.querySelectorAll(`[data-layer="${k}"]`).forEach(b=>b.classList.toggle('on',on)); sceneDirty=true; terrainDirty=true;
  if(k==='roads'||k==='g3d') mapDirty=true; if(k==='photo') setBaseMap(); if(k==='g3d'){ renderTools(); renderLedger(); renderSummary(); const s=byId(state.sel); if(s&&on) calibrateGeoid(s); } renderLegend(); }
$('#layers').addEventListener('click',e=>{ const b=e.target.closest('[data-layer]'); if(b) setLayer(b.dataset.layer,!state.layers[b.dataset.layer]); });
function renderLegend(){
  const L=state.layers;
  if(state.mode==='nation'){ $('#legend').innerHTML=`<div><span class="sw" style="background:#22c55e"></span>計画内</div><div><span class="sw" style="background:#f59e0b"></span>遅延予測 1〜14日</div><div><span class="sw" style="background:#ef4444"></span>遅延予測 15日超</div><div><span class="sw" style="background:#f8fafc;border:1px solid #64748b"></span>県境（広域表示時）</div><div><span class="sw" style="background:#e07b39"></span>高速道路（広域表示時）</div>`; return; }
  const bg=useG()?`<div><span class="sw" style="background:linear-gradient(90deg,#7d8a6a,#a9a39a,#6f7f94)"></span>周辺：Google 実写3D（実在）</div>`:`<div><span class="sw" style="background:#b9c99a"></span>周辺：標高データの地形（1km）</div><div><span class="sw" style="background:#7fa7c9"></span>水域（標高データなし）</div>`;
  $('#legend').innerHTML = bg + (L.heat
    ? `<div><span class="sw" style="background:#dc2626"></span>切土（現況が計画面より高い）</div><div><span class="sw" style="background:#2563eb"></span>盛土（現況が計画面より低い）</div><div><span class="sw" style="background:#f8fafc"></span>切盛なし</div>`
    : `<div><span class="sw" style="background:#a3b77f"></span>現況地盤（標高データ）</div><div><span class="sw" style="background:#b98d55"></span>土工中（施工フロント）</div><div><span class="sw" style="background:#d6c8a8"></span>計画地盤高で仕上がり</div>
       <div><span class="sw" style="background:#b8bcc2"></span>躯体完了</div><div><span class="sw" style="background:linear-gradient(90deg,#9cc0fb,#c7b8f9)"></span>外装完了（現場色）</div><div><span class="sw" style="background:#f59e0b"></span>施工中</div>
       <div><span class="sw" style="background:rgba(120,160,230,.35);border:1px solid #93b4ef"></span>未施工（計画ボリューム）</div><div><span class="sw" style="background:repeating-linear-gradient(0deg,#a3b77f 0 3px,#6b7a52 3px 4px)"></span>等高線（実標高）</div>`);
}

/* =====================================================================
   11. 3D描画（Cesium のプリミティブで自社の地形・構造物・重機を描く）
   ===================================================================== */
const TERR_VS=`in vec3 position3DHigh;in vec3 position3DLow;in vec3 normal;in vec4 color;in float hgt;in float batchId;
out vec3 v_positionEC;out vec3 v_normalEC;out vec4 v_color;out float v_h;
void main(){vec4 p=czm_computePosition();v_positionEC=(czm_modelViewRelativeToEye*p).xyz;v_normalEC=czm_normal*normal;v_color=color;v_h=hgt;gl_Position=czm_modelViewProjectionRelativeToEye*p;}`;
const terrFS=(cont,ci)=>`${cont?`#define CONT\n#define CI ${ci.toFixed(1)}\n`:''}in vec3 v_positionEC;in vec3 v_normalEC;in vec4 v_color;in float v_h;
void main(){vec3 n=normalize(v_normalEC);vec3 c=v_color.rgb;
#ifdef CONT
float q=v_h/CI;float w=fwidth(q);float f=abs(fract(q)-0.5);if(w>1e-5&&w<0.45&&f>0.5-w*1.15)c*=0.78;
#endif
float d1=max(dot(n,czm_lightDirectionEC),0.0);float d2=max(dot(n,-czm_lightDirectionEC),0.0);c*=0.56+0.46*d1+0.12*d2;out_FragColor=vec4(c,1.0);}`;
const BOX_FS=`in vec3 v_positionEC;in vec3 v_normalEC;in vec4 v_color;
void main(){vec3 n=normalize(v_normalEC);if(!gl_FrontFacing)n=-n;float d1=max(dot(n,czm_lightDirectionEC),0.0);float d2=max(dot(n,-czm_lightDirectionEC),0.0);
out_FragColor=vec4(v_color.rgb*(0.52+0.46*d1+0.16*d2),v_color.a);}`;
let BOX=null, BOX_OUT=null;
const APP={};
function boxApp(kind){ if(!APP[kind]) APP[kind] = kind==='edge'
    ? new C3.PerInstanceColorAppearance({flat:true,translucent:true})
    : new C3.PerInstanceColorAppearance({translucent:kind==='trans',closed:kind!=='trans',fragmentShaderSource:BOX_FS});
  return APP[kind]; }
const terrApp={}; function terrainApp(cont,ci){ const k=cont+'|'+ci; return terrApp[k]||(terrApp[k]=new C3.Appearance({translucent:false,closed:false,renderState:C3.Appearance.getDefaultRenderState(false,false),vertexShaderSource:TERR_VS,fragmentShaderSource:terrFS(cont,ci)})); }

// グリッド地形のジオメトリ（x,z は y-up ローカル。位置は ENU で格納し、modelMatrix に ENU→ECEF を渡す）
function gridGeometry(nx,nz,X,Z,Hh,COL,yRef,skirtBase,skirtCol){
  const W=nx+1, nv=W*(nz+1), ring=[];
  for(let i=0;i<nx;i++) ring.push([i,0,i+1,0,0,1]); for(let j=0;j<nz;j++) ring.push([nx,j,nx,j+1,1,0]);
  for(let i=nx;i>0;i--) ring.push([i,nz,i-1,nz,0,-1]); for(let j=nz;j>0;j--) ring.push([0,j,0,j-1,-1,0]);
  const tot=nv+ring.length*4, P=new Float64Array(tot*3), N=new Float32Array(tot*3), Cc=new Uint8Array(tot*4), Hg=new Float32Array(tot), I=[];
  const dX=(X[1]-X[0])||1, dZ=(Z[W]-Z[0])||1;
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++){ const k=j*W+i, i0=Math.max(0,i-1), i1=Math.min(nx,i+1), j0=Math.max(0,j-1), j1=Math.min(nz,j+1);
    const hx=(Hh[j*W+i1]-Hh[j*W+i0])/((i1-i0)*dX), hz=(Hh[j1*W+i]-Hh[j0*W+i])/((j1-j0)*dZ), l=Math.hypot(hx,hz,1);
    P[k*3]=X[k]; P[k*3+1]=-Z[k]; P[k*3+2]=Hh[k]; N[k*3]=-hx/l; N[k*3+1]=hz/l; N[k*3+2]=1/l;
    Cc[k*4]=COL[k*3]*255; Cc[k*4+1]=COL[k*3+1]*255; Cc[k*4+2]=COL[k*3+2]*255; Cc[k*4+3]=255; Hg[k]=Hh[k]+yRef; }
  for(let j=0;j<nz;j++) for(let i=0;i<nx;i++){ const a=j*W+i; I.push(a,a+1,a+W,a+1,a+W+1,a+W); }
  let v=nv;
  for(const [ia,ja,ib,jb,ox,on] of ring){ const a=ja*W+ia, b=jb*W+ib, base=v;
    for(const [src,bottom] of [[a,0],[b,0],[b,1],[a,1]]){ P[v*3]=P[src*3]; P[v*3+1]=P[src*3+1]; P[v*3+2]=bottom?skirtBase:P[src*3+2];
      N[v*3]=ox; N[v*3+1]=on; N[v*3+2]=0; Cc[v*4]=skirtCol[0]*255; Cc[v*4+1]=skirtCol[1]*255; Cc[v*4+2]=skirtCol[2]*255; Cc[v*4+3]=255; Hg[v]=(bottom?skirtBase:P[src*3+2])+yRef; v++; }
    I.push(base,base+1,base+2,base,base+2,base+3); }
  return new C3.Geometry({ attributes:{
      position:new C3.GeometryAttribute({componentDatatype:C3.ComponentDatatype.DOUBLE,componentsPerAttribute:3,values:P}),
      normal:new C3.GeometryAttribute({componentDatatype:C3.ComponentDatatype.FLOAT,componentsPerAttribute:3,values:N}),
      color:new C3.GeometryAttribute({componentDatatype:C3.ComponentDatatype.UNSIGNED_BYTE,componentsPerAttribute:4,normalize:true,values:Cc}),
      hgt:new C3.GeometryAttribute({componentDatatype:C3.ComponentDatatype.FLOAT,componentsPerAttribute:1,values:Hg}) },
    indices: tot<65536?new Uint16Array(I):new Uint32Array(I), primitiveType:C3.PrimitiveType.TRIANGLES, boundingSphere:C3.BoundingSphere.fromVertices(P) });
}
function meshPrimitive(s,geom,cont,ci){
  return new C3.Primitive({geometryInstances:new C3.GeometryInstance({geometry:geom}), appearance:terrainApp(cont,ci),
    modelMatrix:C3.Matrix4.clone(s.enu), asynchronous:false, allowPicking:false, compressVertices:false, vertexCacheOptimize:false, interleave:false});
}

/* ---- 現場オブジェクトの管理 ---- */
const SP={s:null, coll:null, terrain:null, ctx:null, design:null, solids:null, trans:null, edges:null, dyn:null, dynT:null};
function siteObjects(){ const a=[]; if(SP.coll) for(let i=0;i<SP.coll.length;i++) a.push(SP.coll.get(i)); return a; }
function clearSite(){ if(SP.coll&&G.scene){ G.scene.primitives.remove(SP.coll); } Object.assign(SP,{s:null,coll:null,terrain:null,ctx:null,design:null,solids:null,trans:null,edges:null,dyn:null,dynT:null}); }
function ensureSite(s){
  if(!G.scene) return; if(SP.s===s && SP.coll) return; clearSite(); siteFrame(s);
  SP.s=s; SP.coll=G.scene.primitives.add(new C3.PrimitiveCollection());
  SP.dyn=new Pool(false); SP.dynT=new Pool(true);
  buildCtx(s); buildDesignLines(s);
}
const SEA=hex('#7fa7c9');  // 標高データのない水域（海・河川）はデータ作成時に T.P.-1.0m ちょうどで埋めてあり、その値の点だけを水色で描く
function buildCtx(s){ // 簡易地形モード用：周辺1kmの実標高（施工範囲の内側は沈めて重ならないようにする）
  const c=s.ctx, cn=c.cn, W=cn+1, st=c.cw/cn, nv=W*W, X=new Float32Array(nv), Z=new Float32Array(nv), H=new Float32Array(nv), COL=new Float32Array(nv*3), rng=Math.max(1,c.cmax-c.cmin);
  const hw=s.area.w/2-1, hd=s.area.d/2-1, low=s.g.minH-3;
  for(let j=0;j<=cn;j++) for(let i=0;i<=cn;i++){ const k=j*W+i, x=-c.cw/2+i*st, z=-c.cw/2+j*st; X[k]=x; Z[k]=z;
    H[k]=(Math.abs(x)<hw&&Math.abs(z)<hd)?low:c.C[k]-s.yRef; const col=c.C[k]===-1?SEA:mix(hex('#b9c99a'),hex('#c9b48a'),(c.C[k]-c.cmin)/rng*.85); COL.set(col,k*3); }
  s.contI = rng<12?1:rng<50?2:5;
  SP.ctx=SP.coll.add(meshPrimitive(s,gridGeometry(cn,cn,X,Z,H,COL,s.yRef,c.cmin-s.yRef-12,hex('#8a7356')),true,s.contI));
}
function buildDesignLines(s){
  if(SP.design){ SP.coll.remove(SP.design); SP.design=null; }
  const g=s.g, W=g.nx+1, step=Math.max(1,Math.round(6/g.dx)), pc=new C3.PolylineCollection({modelMatrix:C3.Matrix4.clone(siteFrame(s))}), mat=C3.Material.fromType('Color',{color:new C3.Color(.1,.45,.95,.7)});
  for(let j=0;j<=g.nz;j+=step){ const pts=[]; for(let i=0;i<=g.nx;i++){ const k=j*W+i; pts.push(new C3.Cartesian3(g.LX[k],g.D[k]+.15,g.LZ[k])); } pc.add({positions:pts,width:1.5,material:mat}); }
  for(let i=0;i<=g.nx;i+=step){ const pts=[]; for(let j=0;j<=g.nz;j++){ const k=j*W+i; pts.push(new C3.Cartesian3(g.LX[k],g.D[k]+.15,g.LZ[k])); } pc.add({positions:pts,width:1.5,material:mat}); }
  pc.show=state.layers.design; SP.design=SP.coll.add(pc);
}
designDirty = s => { if(SP.s===s) buildDesignLines(s); sceneDirty=true; };
siteGL = ensureSite;
function setSiteLight(s){ if(!G.scene) return; const d=C3.Matrix4.multiplyByPointAsVector(siteFrame(s),new C3.Cartesian3(-.45,-1,-.3),new C3.Cartesian3());
  G.scene.light=new C3.DirectionalLight({direction:C3.Cartesian3.normalize(d,d),intensity:2}); }

/* ---- 現況→計画面の地形（状態 S(t)） ---- */
const GRASS1=hex('#a3b77f'), GRASS2=hex('#93a86f'), SOIL=hex('#b98d55'), FIN=hex('#d6c8a8'), GREEN=hex('#7fa65a'), WHITE=[.97,.98,.99], RED=hex('#dc2626'), BLUE=hex('#2563eb');
function updateTerrain(s){
  const g=s.g, st=s.st, e=st.e, band=.12, heat=state.layers.heat, green=st.roles.green||0; if(!g.col) g.col=new Float32Array(g.nv*3);
  for(let k=0;k<g.nv;k++){ const vp=clamp((e*(1+band)-g.R[k])/band,0,1), diff=g.E[k]-g.D[k]; g.H[k]=g.E[k]+(g.D[k]-g.E[k])*vp; let c;
    if(heat){ const t=clamp(diff/4,-1,1); c=t>0?mix(WHITE,RED,t):mix(WHITE,BLUE,-t); }
    else if(Math.abs(diff)<.15||vp<=0) c=mix(GRASS1,GRASS2,g.VAR[k]); else if(vp<1) c=mix(SOIL,FIN,vp*.3); else c=g.SL[k]>.22?mix(FIN,GREEN,green):FIN;
    g.col[k*3]=c[0]; g.col[k*3+1]=c[1]; g.col[k*3+2]=c[2]; }
  const geom=gridGeometry(g.nx,g.nz,g.LX,g.LZ,g.H,g.col,s.yRef,g.minH-14,hex('#8a7356'));
  const prim=meshPrimitive(s,geom,!heat,s.contI||2); SP.coll.add(prim); if(SP.terrain) SP.coll.remove(SP.terrain); SP.terrain=prim;
}

/* ---- 構造物（状態 S(t) から生成） ---- */
const ORANGE=hex('#f59e0b'), CONC=hex('#b8bcc2');
let S={solids:[],edges:[],ghosts:[],gedges:[],trans:[]};
function buildSiteScene(s){
  S={solids:[],edges:[],ghosts:[],gedges:[],trans:[]}; const st=s.st, acc=hex(s.color);
  const box=(lx,y,lz,w,h,d)=>trs(lx,y,lz,0,w,h,d), ec=(c,a)=>[c[0]*.42,c[1]*.42,c[2]*.42,a];
  const solid=(m,c,a=.5)=>{S.solids.push({m,c:rgba(c)});S.edges.push({m,c:ec(c,a)});};
  // 施工範囲の枠（地形に沿った仮囲い）
  const fence=(x0,z0,x1,z1)=>{ const n=Math.max(2,Math.round(Math.hypot(x1-x0,z1-z0)/10)); for(let i=0;i<n;i++){ const xa=lerp(x0,x1,i/n), za=lerp(z0,z1,i/n), xb=lerp(x0,x1,(i+1)/n), zb=lerp(z0,z1,(i+1)/n), y=(sampleH(s,xa,za)+sampleH(s,xb,zb))/2;
    S.solids.push({m:trs((xa+xb)/2,y,(za+zb)/2,Math.atan2(-(zb-za),xb-xa),Math.hypot(xb-xa,zb-za),2.2,.25),c:[.96,.62,.04,1]}); } };
  const hw=s.area.w/2, hd=s.area.d/2; fence(-hw,-hd,hw,-hd); fence(hw,-hd,hw,hd); fence(hw,hd,-hw,hd); fence(-hw,hd,-hw,-hd);
  const gt=s.gate, gy=sampleH(s,gt.x,gt.z), ax=gt.ox?0:1, az=gt.ox?1:0; for(const k of [-1,1]) solid(box(gt.x+5*k*ax,gy,gt.z+5*k*az,.6,4,.6),hex('#475569')); solid(box(gt.x,gy+3.6,gt.z,ax?10.6:.6,.5,az?10.6:.6),ORANGE);
  for(const b of s.blocks){
    if(b.kind==='bldg'){ const fr=st.roles.frame||0, fi=st.roles.finish||0, fo=st.roles.found||0, y0=b.y0f();
      const done=fr*b.n, full=Math.floor(done+1e-6), frac=done-full, fin=Math.min(full,Math.floor(fi*b.n+1e-6)), light=mix(acc,[1,1,1],.5);
      if(fo>0) solid(box(b.x,y0-.8,b.z,b.w+2,.8*clamp(fo,.15,1),b.d+2),hex('#9ca3af'),.3);
      for(let i=0;i<full;i++) solid(box(b.x,y0+i*b.uh,b.z,b.w,b.uh*.94,b.d),i<fin?light:CONC,.55);
      if(full<b.n&&frac>.001) solid(box(b.x,y0+full*b.uh,b.z,b.w*1.01,b.uh*.94*Math.max(.25,frac),b.d*1.01),ORANGE,.6);
      if(full<b.n){ S.ghosts.push({m:box(b.x,y0+full*b.uh,b.z,b.w,(b.n-full)*b.uh,b.d),c:rgba(acc,.13)}); for(let i=full;i<b.n;i++) S.gedges.push({m:box(b.x,y0+i*b.uh,b.z,b.w,b.uh,b.d),c:rgba(acc,.5)}); } }
    else if(b.kind==='seg'){ const p=st.roles[b.role]||0, done=p*b.n, full=Math.floor(done+1e-6), frac=done-full, col=hex(b.col||'#b7bcc4'), along=b.axis==='z'?b.d:b.w, sw=along/b.n, y0=b.y0f();
      for(let i=0;i<b.n;i++){ const off=-along/2+(i+.5)*sw, lx=b.axis==='x'?b.x+off:b.x, lz=b.axis==='z'?b.z+off:b.z, w=b.axis==='x'?sw*.98:b.w, d=b.axis==='z'?sw*.98:b.d;
        if(i<full) solid(box(lx,y0,lz,w,b.h,d),col); else if(i===full&&frac>.001) solid(box(lx,y0,lz,w,b.h*Math.max(.25,frac),d),ORANGE,.6);
        else { S.ghosts.push({m:box(lx,y0,lz,w,b.h,d),c:rgba(acc,.14)}); S.gedges.push({m:box(lx,y0,lz,w,b.h,d),c:rgba(acc,.45)}); } } }
    else if(b.kind==='road'){ const p=st.roles[b.role]||0, done=p*b.n, full=Math.floor(done+1e-6), frac=done-full, sw=(b.x1-b.x0)/b.n, y=s.grade()+.04;
      for(let i=0;i<b.n&&i<=full;i++){ const cx=b.x0+(i+.5)*sw;
        if(i<full){ solid(box(cx,y,b.z,sw*.995,.16,b.w),hex('#3f4650'),.25); for(const k of [-.25,.25]) S.solids.push({m:box(cx+sw*k,y+.16,b.z,sw*.3,.02,.18),c:[1,1,1,1]}); }
        else if(frac>.001) solid(box(b.x0+i*sw+sw*frac/2,y,b.z,sw*frac,.17,b.w),ORANGE,.5); } }
    else if(b.kind==='water'){ if((st.roles[b.role]||0)>=.95) S.trans.push({m:box(b.x,b.y0f(),b.z,b.w*.7,s.pit-.8,b.d*.7),c:[.35,.6,.85,.6]}); }
  }
  // Cesium プリミティブへ（種類ごとに1つにまとめて描画）
  const mk=(items,kind)=>{ if(!items.length) return null;
    const inst=items.map(it=>new C3.GeometryInstance({geometry:kind==='edge'?BOX_OUT:BOX, modelMatrix:itemMatrix(s,it.m),
      attributes:{color:C3.ColorGeometryInstanceAttribute.fromColor(new C3.Color(it.c[0],it.c[1],it.c[2],it.c[3]))}}));
    return SP.coll.add(new C3.Primitive({geometryInstances:inst, appearance:boxApp(kind), asynchronous:false, allowPicking:false, compressVertices:false})); };
  const old=[SP.solids,SP.trans,SP.edges];
  SP.solids=mk(S.solids,'solid'); SP.trans=mk([...S.ghosts,...S.trans],'trans'); SP.edges=mk([...S.edges,...S.gedges],'edge');
  for(const p of old) if(p) SP.coll.remove(p);
  sceneDirty=false;
}

/* ---- 重機（毎フレーム位置を更新するのでプールで使い回す） ---- */
class Pool{
  constructor(tr){ this.tr=tr; this.items=[]; this.n=0; }
  begin(){ this.n=0; }
  add(s,m,c){ let it=this.items[this.n];
    if(!it){ const p=new C3.Primitive({geometryInstances:new C3.GeometryInstance({geometry:BOX,id:'b',attributes:{color:C3.ColorGeometryInstanceAttribute.fromColor(new C3.Color(c[0],c[1],c[2],c[3]))}}),
        appearance:boxApp(this.tr?'trans':'solid'), asynchronous:false, allowPicking:false, compressVertices:false});
      it={prim:SP.coll.add(p), c:c.slice(), dirty:false}; this.items.push(it); }
    this.n++; const p=it.prim; p.show=true; itemMatrix(s,m,p.modelMatrix);
    if(it.c[0]!==c[0]||it.c[1]!==c[1]||it.c[2]!==c[2]||it.c[3]!==c[3]){ it.c=c.slice(); it.dirty=true; }
    if(it.dirty&&p.ready){ try{ p.getGeometryInstanceAttributes('b').color=C3.ColorGeometryInstanceAttribute.toValue(new C3.Color(c[0],c[1],c[2],c[3])); it.dirty=false; }catch(e){} } }
  end(){ for(let i=this.n;i<this.items.length;i++) this.items[i].prim.show=false; }
}
function computeEquip(s){
  s.eq=null; const e=s.st.e; if(!(e>.002&&e<.998)) return;
  const g=s.g, band=.12, w=s.area.w, fx=-w/2+clamp(e*(1+band)-band*.5,0,1)*w;
  const pick=(sign,count)=>{ let cand=[]; for(let R=6;R<=120;R*=1.6){ cand=[]; for(let k=0;k<g.nv;k++){ if(Math.abs(g.LX[k]-fx)<R){ const v=(g.E[k]-g.D[k])*sign; if(v>.4) cand.push([v,k]); } } if(cand.length>=count*4) break; }
    cand.sort((a,b)=>b[0]-a[0]); const out=[]; for(const [,k] of cand){ if(out.every(o=>Math.hypot(g.LX[o]-g.LX[k],g.LZ[o]-g.LZ[k])>14)) out.push(k); if(out.length>=count) break; } return out.map(k=>[g.LX[k],g.LZ[k]]); };
  let ex=pick(1,clamp(s.p.ex,1,3)); const ro=pick(-1,clamp(s.p.rollers,0,2)); if(!ex.length) ex=ro.length?[ro[0]]:[[fx,0]];
  const gt=s.gate, gin=[gt.x-gt.ox*4,gt.z-gt.oz*4], pts=[]; const [x0,z0]=ex[0];
  for(let k=0;k<=10;k++){ const lx=lerp(x0,gin[0],k/10), lz=lerp(z0,gin[1],k/10); pts.push([lx,sampleH(s,lx,lz)+.1,lz]); }
  for(let k=0;k<=12;k++){ const lx=gt.x+gt.ox*k*12, lz=gt.z+gt.oz*k*12; pts.push([lx,sampleH(s,lx,lz)+.15,lz]); }
  const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1],pts[i][2]-pts[i-1][2]));
  s.eq={ex,ro,route:pts,cum,trucks:clamp(s.p.trucks,0,5)};
}
const YEL=hex('#eab308'), DARK=hex('#3f3f46'), SOILC=hex('#8a6a42');
function dynItems(s,t){
  const sol=[], tr=[], L=state.layers, st=s.st, fr=st.roles.frame||0, fo=st.roles.found||0;
  if(s.crane && (fo>.3||fr>0) && fr<1){ const cc=s.crane, mx=cc.x, mz=cc.z, yb=sampleH(s,mx,mz), h=cc.h, col=rgba(YEL);
    sol.push({m:trs(mx,yb,mz,0,2.4,h,2.4),c:col},{m:trs(mx,yb+h,mz,0,3.4,3,3.4),c:[.95,.96,.97,1]});
    const a=t*.12, dx=Math.cos(a), dz=-Math.sin(a), off=(cc.jib-12)/2;
    sol.push({m:trs(mx+dx*off,yb+h+3,mz+dz*off,a,cc.jib+12,1.4,1.4),c:col},{m:trs(mx-dx*9,yb+h+.6,mz-dz*9,a,4,2.6,3),c:rgba(hex('#6b7280'))});
    const r=cc.jib*(.55+.3*Math.sin(t*.35)), hy=yb+h*.5+h*.15*Math.sin(t*.5);
    sol.push({m:trs(mx+dx*r,hy,mz+dz*r,a,.25,yb+h+3-hy,.25),c:[.2,.2,.2,1]},{m:trs(mx+dx*r,hy-1.6,mz+dz*r,a,3,1.6,1.4),c:rgba(hex('#64748b'))});
    if(L.crane) for(const [R,al] of [[cc.jib,.55],[cc.jib+5,.35]]) for(let k=0;k<48;k++){ const a0=k/48*Math.PI*2, a1=(k+1)/48*Math.PI*2, ax=(Math.cos(a0)+Math.cos(a1))/2*R, az=(Math.sin(a0)+Math.sin(a1))/2*R;
      tr.push({m:trs(mx+ax,sampleH(s,mx+ax,mz+az)+.4,mz+az,-(a0+a1)/2+Math.PI/2,2*R*Math.sin(Math.PI/48),.3,R===cc.jib?.8:.5),c:[.96,.6,.1,al]}); } }
  const q=s.eq; if(!q) return {sol,tr};
  if(L.equip){
    q.ex.forEach(([lx,lz],k)=>{ const y=sampleH(s,lx,lz), a0=k*1.7+.6, a2=a0+.7*Math.sin(t*1.2+k*2), fx=Math.cos(a2), fz=-Math.sin(a2), qx=Math.sin(a2), qz=Math.cos(a2);
      sol.push({m:trs(lx,y,lz,a0,4.6,1,3.6),c:rgba(DARK)},{m:trs(lx,y+1,lz,a2,3.2,1.6,2.8),c:rgba(YEL)},{m:trs(lx-fx*.4+qx*.7,y+2.6,lz-fz*.4+qz*.7,a2,1.3,1.4,1.2),c:[.85,.9,.95,1]},
        {m:trs(lx+fx*3.2,y+3.2,lz+fz*3.2,a2,4.6,.55,.6),c:rgba(YEL)},{m:trs(lx+fx*5.4,y-.2,lz+fz*5.4,a2,.5,3.6,.5),c:rgba(YEL)},{m:trs(lx+fx*5.7,y-.6,lz+fz*5.7,a2,1.2,.9,1.1),c:rgba(DARK)}); });
    q.ro.forEach(([lx,lz],k)=>{ const x=lx+4*Math.sin(t*.6+k), y=sampleH(s,x,lz); sol.push({m:trs(x,y+.4,lz,0,3.2,1.8,2),c:rgba(YEL)},{m:trs(x+2.2,y,lz,0,1.4,1.4,2.2),c:rgba(hex('#71717a'))}); });
    const R=q.route, cum=q.cum, Lt=Math.max(1,cum[cum.length-1]);
    for(let k=0;k<q.trucks;k++){ const u=((t*12/Lt)+k/q.trucks)%1, sd=u*2*Lt, fwd=sd<Lt, d=fwd?sd:2*Lt-sd; let i=1; while(i<cum.length-1&&cum[i]<d) i++;
      const f=(d-cum[i-1])/Math.max(1e-6,cum[i]-cum[i-1]), p0=R[i-1], p1=R[i], x=lerp(p0[0],p1[0],f), y=lerp(p0[1],p1[1],f), z=lerp(p0[2],p1[2],f);
      let dx=p1[0]-p0[0], dz=p1[2]-p0[2]; if(!fwd){dx=-dx;dz=-dz;} const a=Math.atan2(-dz,dx), hx=Math.cos(a), hz=-Math.sin(a);
      sol.push({m:trs(x,y+.3,z,a,6.6,.6,2.2),c:rgba(DARK)},{m:trs(x+hx*2.3,y+.8,z+hz*2.3,a,1.9,2.1,2.3),c:[.95,.96,.97,1]},{m:trs(x-hx*.9,y+.9,z-hz*.9,a,4.4,1.5,2.4),c:rgba(hex('#d97706'))});
      if(fwd) sol.push({m:trs(x-hx*.9,y+2.4,z-hz*.9,a,3.8,.6,2),c:rgba(SOILC)}); } }
  if(L.route){ const R=q.route; for(let i=1;i<R.length;i++){ const p0=R[i-1], p1=R[i], dx=p1[0]-p0[0], dz=p1[2]-p0[2]; if(Math.hypot(dx,dz)<.05) continue;
    tr.push({m:trs((p0[0]+p1[0])/2,(p0[1]+p1[1])/2+.15,(p0[2]+p1[2])/2,Math.atan2(-dz,dx),Math.hypot(dx,dz),.12,1.4),c:[.96,.62,.04,.8]}); } }
  return {sol,tr};
}

/* ---- 全国表示：県境・高速道路・現場ピン ---- */
const NAT={lines:null, pins:null, pinMap:{}, mark:null};
function lineH(){ return useG()?4500:400; }
function buildNation(){
  if(!G.scene) return;
  if(NAT.lines) G.scene.primitives.remove(NAT.lines);
  const pc=new C3.PolylineCollection(), h=lineH(), white=C3.Material.fromType('Color',{color:new C3.Color(1,1,1,.8)}), amber=C3.Material.fromType('Color',{color:C3.Color.fromCssColorString('#fbbf24')}), road=C3.Material.fromType('Color',{color:C3.Color.fromCssColorString('#e07b39').withAlpha(.9)});
  const arr=r=>{ const a=[]; for(const [lo,la] of r) a.push(lo,la,h); return C3.Cartesian3.fromDegreesArrayHeights(a); };
  if(state.layers.roads){
    for(const p of PREFS){ if(p.name===state.pref) continue; for(const r of p.rings) pc.add({positions:arr([...r,r[0]]),width:1.2,material:white}); }
    for(const r of ROADS) pc.add({positions:arr(r),width:1.6,material:road});
  }
  const sp=PREFS.find(p=>p.name===state.pref); if(sp) for(const r of sp.rings) pc.add({positions:arr([...r,r[0]]),width:3.5,material:amber});
  NAT.lines=G.scene.primitives.add(pc); mapDirty=false;
}
function buildPins(){
  NAT.pins=G.scene.primitives.add(new C3.PointPrimitiveCollection());
  for(const s of SITES) NAT.pinMap[s.id]=NAT.pins.add({position:pinPos(s),pixelSize:11,outlineWidth:3,outlineColor:C3.Color.fromCssColorString(s.color),color:C3.Color.WHITE,disableDepthTestDistance:Number.POSITIVE_INFINITY,id:s.id});
  NAT.mark=NAT.pins.add({position:C3.Cartesian3.ZERO,pixelSize:12,color:C3.Color.WHITE,outlineColor:C3.Color.fromCssColorString('#0f172a'),outlineWidth:3,disableDepthTestDistance:Number.POSITIVE_INFINITY,show:false});
}
const STC={ok:C3?C3.Color.fromCssColorString('#22c55e'):null,warn:C3?C3.Color.fromCssColorString('#f59e0b'):null,late:C3?C3.Color.fromCssColorString('#ef4444'):null};
function updatePins(now){
  const nation=state.mode==='nation', height=G.camera.positionCartographic.height;
  for(const s of SITES){ const p=NAT.pinMap[s.id], d=delayOf(s), sel=state.sel===s.id; p.show=nation&&matches(s);
    p.position=pinPos(s); p.color=d>14?STC.late:d>0?STC.warn:STC.ok; p.pixelSize=sel?15+3*Math.sin(now/200):11; }
  NAT.mark.show=nation&&!!state.mark&&!useG(); if(state.mark) NAT.mark.position=C3.Cartesian3.fromDegrees(state.mark.lon,state.mark.lat,lineH()*.2);
  if(NAT.lines) NAT.lines.show=nation&&(!useG()||height>9e4);
}

/* ---- ラベル（HTML） ---- */
const labelEls={}; SITES.forEach(s=>{ const d=document.createElement('div'); d.className='lbl'; d.addEventListener('click',()=>select(s.id)); $('#labels').appendChild(d); labelEls[s.id]=d; });
const markEl=document.createElement('div'); markEl.className='lbl mark'; $('#labels').appendChild(markEl);
function project(pos){
  if(!pos) return null; const cam=G.camera, v=C3.Cartesian3.subtract(pos,cam.positionWC,new C3.Cartesian3()), dist=C3.Cartesian3.magnitude(v);
  if(C3.Cartesian3.dot(v,cam.directionWC)<=0) return null;
  const occ=new C3.EllipsoidalOccluder(C3.Ellipsoid.WGS84,cam.positionWC); if(state.mode==='nation'&&!occ.isPointVisible(pos)) return null;
  const w=C3.SceneTransforms.worldToWindowCoordinates(G.scene,pos); return w?{x:w.x,y:w.y,w:dist}:null; }
const lblCache={};
function updateLabels(){
  const cv=G.scene.canvas, W=cv.clientWidth, H=cv.clientHeight, rects=[], nation=state.mode==='nation', camH=G.camera.positionCartographic.height;
  const order=[...SITES].sort((a,b)=>(b.id===state.sel)-(a.id===state.sel));
  for(const s of order){
    const el=labelEls[s.id]; let pr=null;
    if(nation) pr=project(pinPos(s)); else if(s.id===state.sel) pr=project(L2W(s,0,siteTop(s)+6,0));
    if(!state.layers.labels||!matches(s)||!pr||pr.x<-120||pr.x>W+120||pr.y<-60||pr.y>H+60){ el.style.display='none'; continue; }
    const p=Math.round(s.st.overall*100), pred=state.T>B, compact=nation&&camH>6e5, key=`${p}|${state.sel===s.id}|${pred}|${compact}|${s.st.e>0&&s.st.e<1}`;
    if(lblCache[s.id]!==key){ lblCache[s.id]=key; el.className='lbl'+(state.sel===s.id?' sel':'')+(compact?' mini2':'');
      el.innerHTML = compact ? `<div class="t"><span class="dot" style="background:${s.color}"></span>${esc(s.pref.replace(/(都|府|県)$/,''))} ${p}%</div>`
        : `<div class="t"><span class="dot" style="background:${s.color}"></span>${esc(s.id)}${pred?' <span class="pr">予測</span>':''}</div><div class="s">${esc(s.name.length>14?s.name.slice(0,14)+'…':s.name)}</div><div class="s"><span class="mini"><i style="width:${p}%;background:${s.color}"></i></span>${p}%${s.st.e>0&&s.st.e<1?'・土工中':''}</div>`; }
    el.style.display=''; const bw=el.offsetWidth||80, bh=el.offsetHeight||24, oy=nation?10:0, r=[pr.x-bw/2,pr.y-bh-8-oy,pr.x+bw/2,pr.y-8-oy];
    if(nation && rects.some(q=>!(r[2]<q[0]||r[0]>q[2]||r[3]<q[1]||r[1]>q[3]))){ el.style.display='none'; continue; }
    rects.push(r); el.style.transform=`translate(${pr.x}px,${pr.y-oy}px) translate(-50%,-100%) translateY(-6px)`; el.style.zIndex=state.sel===s.id?100000:Math.round(50000-pr.w/1000);
  }
  if(nation && state.mark && !useG()){ const pr=project(C3.Cartesian3.fromDegrees(state.mark.lon,state.mark.lat,lineH()*.2));
    if(pr){ markEl.style.display=''; markEl.textContent='📍 '+state.mark.label; markEl.style.transform=`translate(${pr.x}px,${pr.y-10}px) translate(-50%,-100%) translateY(-6px)`; } else markEl.style.display='none'; }
  else markEl.style.display='none';
}
function updateScale(){
  const cv=G.scene.canvas, Hc=cv.clientHeight; if(!Hc) return; const cam=G.camera; let dist;
  const s=byId(state.sel); if(state.mode==='site'&&s) dist=C3.Cartesian3.distance(cam.positionWC,L2W(s,0,0,0));
  else { const ray=cam.getPickRay(new C3.Cartesian2(cv.clientWidth/2,Hc/2)), hit=ray?C3.IntersectionTests.rayEllipsoid(ray,C3.Ellipsoid.WGS84):null; dist=hit?hit.start:cam.positionCartographic.height; }
  const mPerPx=2*dist*Math.tan((cam.frustum.fovy||.8)/2)/Hc, target=mPerPx*90, pow=Math.pow(10,Math.floor(Math.log10(target))), nice=[1,2,5,10].map(k=>k*pow).filter(v=>v<=target*1.4).pop()||pow, px=nice/mPerPx;
  $('#scalebar').innerHTML=`${nice>=1000?(nice/1000).toLocaleString('ja-JP')+' km':nice+' m'}<i style="width:${px}px;margin-left:auto"></i>`;
}

/* ---- 背景地図：国土地理院 地理院タイル（淡色地図／航空写真）。Google 実写3D の表示中は地球ごと隠れる ---- */
function setBaseMap(){ if(!G.viewer) return; const L=G.viewer.imageryLayers; if(G.base) L.remove(G.base,true);
  const photo=state.layers.photo, url=photo?'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg':'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  G.base=L.addImageryProvider(new C3.UrlTemplateImageryProvider({url, minimumLevel:2, maximumLevel:18, rectangle:C3.Rectangle.fromDegrees(122,20,154,46.5),
    credit:new C3.Credit('<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'+(photo?'（全国最新写真）':'（淡色地図）'),true)})); }

/* ---- 初期化・毎フレーム処理 ---- */
function initViewer(){
  if(!C3){ $('#nogl').hidden=false; $('#nogl').innerHTML='3Dライブラリ（CesiumJS）を読み込めませんでした。インターネット接続を確認してください。<br>台帳・土量・工程などの管理機能は利用できます。'; return false; }
  try{
    P_YUP=new C3.Matrix4(1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1); P_INV=new C3.Matrix4(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
    const globe=new C3.Globe(C3.Ellipsoid.WGS84); globe.baseColor=C3.Color.fromCssColorString('#9fb58a'); globe.showGroundAtmosphere=false; globe.enableLighting=false;
    const v=new C3.Viewer('cz',{baseLayer:false, globe, animation:false, timeline:false, baseLayerPicker:false, geocoder:false, homeButton:false, sceneModePicker:false,
      navigationHelpButton:false, fullscreenButton:false, infoBox:false, selectionIndicator:false, scene3DOnly:true, msaaSamples:4, requestRenderMode:false, shouldAnimate:false});
    G.viewer=v; G.scene=v.scene; G.camera=v.camera;
    v.clock.currentTime=C3.JulianDate.fromIso8601('2026-10-06T03:00:00Z'); v.clock.shouldAnimate=false;  // 日本の正午（空の明るさを固定）
    v.scene.highDynamicRange=false; v.scene.postProcessStages.fxaa.enabled=true; v.scene.fog.enabled=true; setBaseMap();
    const ssc=v.scene.screenSpaceCameraController; ssc.minimumZoomDistance=6; ssc.maximumZoomDistance=2.6e7;
    BOX=new C3.BoxGeometry({minimum:new C3.Cartesian3(-.5,-.5,0),maximum:new C3.Cartesian3(.5,.5,1),vertexFormat:C3.PerInstanceColorAppearance.VERTEX_FORMAT});
    BOX_OUT=new C3.BoxOutlineGeometry({minimum:new C3.Cartesian3(-.5,-.5,0),maximum:new C3.Cartesian3(.5,.5,1)});
    buildPins(); buildNation();
    G.camera.setView({destination:C3.Cartesian3.fromDegrees(HOME.lon,HOME.lat-18,1.6e7),orientation:{heading:0,pitch:-1.5,roll:0}});
    flyHome(2.2);
    // クリック：ピン → 現場へ／地面 → 都道府県で絞り込み
    const hd=new C3.ScreenSpaceEventHandler(v.scene.canvas);
    hd.setInputAction(e=>{ if(state.mode!=='nation') return;
      const pk=v.scene.pick(e.position); if(pk&&typeof pk.id==='string'&&byId(pk.id)){ select(pk.id); return; }
      const c=G.camera.pickEllipsoid(e.position,C3.Ellipsoid.WGS84); if(!c) return;
      const cg=C3.Cartographic.fromCartesian(c), p=pointInPref(C3.Math.toDegrees(cg.longitude),C3.Math.toDegrees(cg.latitude));
      setPref(p&&p.name!==state.pref?p.name:'',!!p); },C3.ScreenSpaceEventType.LEFT_CLICK);
    let lastPick=0; hd.setInputAction(e=>{ if(state.mode!=='nation'){ v.scene.canvas.style.cursor=''; return; } const tn=performance.now(); if(tn-lastPick<120) return; lastPick=tn; const pk=v.scene.pick(e.endPosition); v.scene.canvas.style.cursor=pk&&typeof pk.id==='string'?'pointer':''; },C3.ScreenSpaceEventType.MOUSE_MOVE);
    v.scene.canvas.addEventListener('pointerdown',()=>{ G.ptrDown=true; });
    window.addEventListener('pointerup',()=>{ G.ptrDown=false; });
    let lastTerr=0, lastScene=0, lastT=performance.now();
    v.scene.preUpdate.addEventListener(()=>{
      const now=performance.now(), dt=Math.min(.05,(now-lastT)/1000); lastT=now;
      if(mapDirty) buildNation();
      if(G.tileset) G.tileset.show=useG(); v.scene.globe.show=!useG(); if(G.base) G.base.show=!useG();  // Google 表示中は地理院タイル（とその帰属表示）を出さない
      updatePins(now);
      const s=byId(state.sel);
      if(state.mode==='site'&&s&&SP.s===s){
        if(SP.ctx) SP.ctx.show=!useG(); if(SP.design) SP.design.show=state.layers.design;
        if(terrainDirty&&now-lastTerr>110){ lastTerr=now; updateTerrain(s); computeEquip(s); terrainDirty=false; }
        if(sceneDirty&&now-lastScene>110){ lastScene=now; buildSiteScene(s); }
        const dyn=dynItems(s,now/1000); SP.dyn.begin(); SP.dynT.begin();
        for(const it of dyn.sol) SP.dyn.add(s,it.m,it.c); for(const it of dyn.tr) SP.dynT.add(s,it.m,it.c);
        SP.dyn.end(); SP.dynT.end();
        if(state.autoRotate&&G.locked&&!G.flying&&!G.ptrDown) G.camera.rotateRight(dt*.12);
      }
    });
    v.scene.postRender.addEventListener(()=>{ updateLabels(); updateScale(); $('#needle').style.transform=`rotate(${-G.camera.heading}rad)`; });
    return true;
  }catch(e){ console.error(e); $('#nogl').hidden=false; $('#nogl').innerHTML='このブラウザでは 3D 表示（WebGL2）を開始できませんでした。<br>台帳・土量・工程などの管理機能は利用できます。'; G.viewer=null; return false; }
}

/* ---- キーボード ---- */
const typing=()=>/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'');
window.addEventListener('keydown',e=>{ if(!$('#keyDlg').hidden) return; if(e.key==='/'&&!typing()){ e.preventDefault(); $('#q').focus(); return; } if(typing()) return; const k=e.key.toLowerCase();
  if(k===' '){ e.preventDefault(); togglePlay(); return; } if(k==='home'){ applyView('all'); return; } if(k==='escape'){ if(state.sel) select(null); return; } });

/* =====================================================================
   12. 起動
   ===================================================================== */
renderTools(); renderLegend();
renderLedger(); renderSummary(); renderDock(); updateTimelineUI();
(function loop(){ let last=performance.now(), lastUI=0;
  const tick=now=>{ requestAnimationFrame(tick); const dt=Math.min(.05,(now-last)/1000); last=now;
    if(state.playing){ setT(state.T+state.speed*dt); if(state.T>=T_MAX){ state.playing=false; updPlayBtn(); } }
    if(worldDirty) worldUpdate();
    if(uiDirty && now-lastUI>140){ uiDirty=false; lastUI=now; updateTimelineUI(); renderLedger(); refreshDockTime(); } };
  requestAnimationFrame(tick); })();
if(location.protocol==='file:') setTimeout(()=>toast('ファイルを直接開いているため、3D表示の一部（地形・Google 3D の読み込み）が動きません。<br>Webサーバ（社内サーバ・GitHub Pages など）に置いて https:// で開いてください。',15000),800);
if(GEO.fetched&&GEO.fetched.failed.length) setTimeout(()=>toast(`データを取得できなかった現場があります（${GEO.fetched.failed.length}件）。その現場を除いて表示しています。<br>${GEO.fetched.failed.map(esc).join('<br>')}`,15000),2500);
if(initViewer()){
  const key=EMBED_GOOGLE_KEY||lsGet(KEY_STORE);
  if(key) connectGoogle(key); else { setStatus('simple'); openKeyDialog(); }
} else setStatus('nolib');

