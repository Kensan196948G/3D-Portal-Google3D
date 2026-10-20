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
  // ---- 海上工事（marine:true）：海底の高さは深浅測量（架空）。計画高は現場ごとに固定（fh:'fixed'、SITE_DEFS の design）----
  dredge:{type:'土木',cat:'港湾',label:'航路・泊地浚渫',scale:'浚渫 計画水深 T.P.−12.0m（グラブ浚渫船・土運船）',fh:'fixed',marine:true,pit:0,pitLabel:'—',crane:false,mD:6,color:'#0369a1',
    blocks:()=>[],
    tasks:[['準備工',0,30,.05,'','深浅測量・灯浮標の設置、漁協・港湾利用者との調整'],['浚渫（土工）',30,240,.70,'earth','グラブ浚渫船で浚渫し、土運船で処分場へ運搬'],
      ['出来形測量・余掘り整正',270,40,.15,'','ナローマルチビーム測深で出来形を確認'],['完成検査',310,20,.10,'','出来形・品質検査、灯浮標の撤去']]},
  landfill:{type:'土木',cat:'港湾',label:'海面埋立',scale:'海面埋立 計画天端 T.P.+4.0m・外周護岸（ケーソン）',fh:'fixed',marine:true,pit:0,pitLabel:'—',crane:false,mD:10,color:'#4338ca',
    blocks:(w,d)=>[{kind:'seg',axis:'x',x:0,z:-(d/2-3),w:w*.98,d:5,y0:-10.6,h:11.6,n:10,role:'wall',col:'#b7bcc4'},{kind:'seg',axis:'x',x:0,z:d/2-3,w:w*.98,d:5,y0:-10.6,h:11.6,n:10,role:'wall',col:'#b7bcc4'},
      {kind:'seg',axis:'z',x:-(w/2-3),z:0,w:5,d:d*.92,y0:-10.6,h:11.6,n:7,role:'wall',col:'#b7bcc4'},{kind:'seg',axis:'z',x:w/2-3,z:0,w:5,d:d*.92,y0:-10.6,h:11.6,n:7,role:'wall',col:'#b7bcc4'}],
    tasks:[['準備工',0,45,.03,'','深浅測量・汚濁防止膜の設置'],['外周護岸（基礎・ケーソン据付）',45,240,.30,'wall','捨石基礎・ケーソン据付・裏込め'],['埋立（土工）',200,330,.50,'earth','浚渫土・購入土を土運船で運び、揚土・敷均し',1],
      ['地盤改良',500,150,.12,'','サンドドレーン・プレロード（沈下対策）'],['完成検査',650,30,.05,'','出来形・沈下観測、引渡し']]},
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
  const M=!!(s.k&&s.k.marine);   // 海上工事：土運船（約 8 ノット＝15km/h、積込・揚土の待ちを含む）
  const cycExt=M?40+(2*p.dExt)/15*60+40:5+(2*p.dExt)/30*60+3, cycInt=M?cycExt:4+(2*dInt/1000)/15*60+2;
  const tpm=(eb.extFrac*cycExt+(1-eb.extFrac)*cycInt)/capNat, truck=p.trucks*p.hours*60*.85/tpm;
  const roller=eb.Vf>1?p.rollers*p.qR*hf*(eb.Q/eb.Vf):Infinity;
  const list=M?[['浚渫・積込（グラブ浚渫船）',ex],['運搬（土運船）',truck],['揚土・敷均し',roller]]:[['掘削・積込（バックホウ）',ex],['運搬（ダンプ）',truck],['敷均し・締固め（ローラ）',roller]];
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
  const s={ id:def.no||`${def.br}-${fy}-${String(sq).padStart(4,'0')}`, key:def.key, name:def.name, kind:g.kind, k, type:k.type, cat:k.cat,
    pref:g.pref, city:g.city, town:g.town, lgcode:g.lgcode, addr:`${g.pref}${g.city}${g.town}地先`, sea:g.sea||null,
    lon:g.lon, lat:g.lat, client:def.client, ccat:def.ccat, scale:k.scale, br:def.br, brName:BRANCHES[def.br], port:def.port,
    dept:`${BRANCHES[def.br]} 工事部 ${def.port}作業所`,
    color:SITE_COLORS[i%SITE_COLORS.length], area:{w:g.w,d:g.d}, rot:0, terr:GEO.terr[i], region:REGION[g.pref],
    gate:gateFor(g), perf:def.perf, soil:def.soil };
  const [X,Z]=toNat(s.lon,s.lat); s.nat=[X,Z];
  // 工程（ダミー実績は計画×施工効率から生成）
  const st=dn(def.start);
  s.tasks=k.tasks.map(([n,off,dur,w,role,m,pred],ti)=>({n,ts:st+off,te:st+off+dur,dur,w,role:role==='earth'?'':role,earth:role==='earth',m,pred:pred!==undefined?pred:ti-1}));
  if(def.sample===false) s.tasks.forEach(t=>{ t.a=0; }); else s.tasks.forEach(t=>{ const pp=planP(t,B); let a = pp>=1 ? (B-t.te>45 ? 1 : Math.min(1, def.perf+(B-t.te)/45*(1-def.perf))) : clamp(pp*def.perf,0,1); t.a=Math.round(a*100)/100; if(t.a>.995) t.a=1; });
  s.planStart=Math.min(...s.tasks.map(t=>t.ts)); s.planEnd=Math.max(...s.tasks.map(t=>t.te)); s.earthIdx=s.tasks.findIndex(t=>t.earth);
  s.blocks=k.blocks(g.w,g.d,g.sea||'S'); s.pit=k.pit;
  if(k.crane){ const mb=s.blocks[0]; s.crane={x:mb.x,z:mb.z-(mb.d/2+7),h:mb.n*mb.uh+18,jib:Math.round(Math.max(mb.w,mb.d)*1.1)}; }
  // 計画地盤高：balance＝切盛バランス高（二分法）、raise＝現況中央値＋嵩上げ高、bldg＝現況中央値+0.3m
  s.yRef=Math.round(s.terr.emed*10)/10; s.FH=s.yRef; buildTerrain(s);
  const base={soil:def.soil,usable:85};
  if(k.fh==='balance'){ let lo=s.yRef-15, hi=s.yRef+15;
    for(let it=0;it<32;it++){ s.FH=(lo+hi)/2; buildDesign(s); const so=SOILS[base.soil]; if(s.g.Vc*base.usable/100*so.C-s.g.Vf>0) lo=s.FH; else hi=s.FH; }
    s.FH=Math.round(s.FH*10)/10; }
  else if(k.fh==='fixed') s.FH=def.design;   // 海上工事：計画水深・計画天端（T.P.）を固定
  else if(k.fh==='raise') s.FH=Math.round((s.terr.emed+k.raise)*10)/10;
  else s.FH=Math.round((s.terr.emed+.3)*10)/10;
  buildDesign(s); s.FH0=s.FH;
  s.grade=()=>s.FH-s.yRef;
  for(const b of s.blocks){ if(b.kind==='bldg') b.y0f=()=>b.basement?(s.FH-s.yRef)-s.pit*(b.pitK??1)+.8:(s.FH-s.yRef);
    if(b.kind==='seg') b.y0f=()=>(s.FH-s.yRef)+b.y0; if(b.kind==='water') b.y0f=()=>(s.FH-s.yRef)-s.pit+.3; }
  // 施工計画（行動 a）：地域係数を初期値とし、計画工期で終わる編成を自動設定
  const r=s.region, p={soil:def.soil,usable:85,cap:6.0,ex:1,qEx:300,trucks:1,dExt:r.dExt,rollers:1,qR:600,hours:8,days:6,rain:r.rain,winterF:Math.round(r.wf*100)};
  // 海上工事：グラブ浚渫船（qEx m³/隻日）・土運船（cap m³/隻、ほぐし）・揚土と敷均し（qR）。荒天・波浪の休止を雨天に上乗せ（サンプル値）
  if(k.marine) Object.assign(p,{cap:800,qEx:1500,dExt:12,qR:4000,rain:Math.min(40,r.rain+10)});
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
const scopeName = () => [state.br?BRANCHES[state.br]:'', state.pref].filter(Boolean).join('・') || (window.PORTAL_SERVER&&Array.isArray(PORTAL_SERVER.user.branches)?(PORTAL_SERVER.user.branches.map(b=>BRANCHES[b]||b).join('・')||'閲覧範囲なし')+'（閲覧範囲）':'全社');
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
      <dt>${s.k.marine?'計画高':'計画地盤高'}</dt><dd>T.P. ${fmt1(s.FH)} m${s.pit?`／${esc(s.k.pitLabel)} ${fmt1(s.pit)} m`:''}</dd>
      <dt>${s.k.marine?'海底（現況）':'現況地盤'}</dt><dd>T.P. ${fmt1(s.g.minH+s.yRef)}〜${fmt1(Math.max(...s.g.E)+s.yRef)} m（${esc(s.terr.src)}）</dd>
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
const TABS=[['earth','土量算出'],['plan','土工計画'],['const','施工計画'],['sched','工程管理'],['wm','ワールドモデル'],['wx','気象・海象'],['tide','潮位'],['work','作業可能日'],['fleet','配船'],['survey','測量の比較'],['consult','協議・区域'],['ai','遅れの分析'],['cmp','類似工事'],['prog','実績入力']];
function renderDock(){
  const s=byId(state.sel), tabs=$('#dtabs');
  tabs.innerHTML=(s?`<span class="dtitle"><span class="dot" style="background:${s.color}"></span> ${esc(s.id)}</span>`:`<span class="dtitle">${esc(scopeName())}のポートフォリオ</span>`)
    +TABS.map(([k,n])=>`<button class="dtab${s&&state.tab===k?' on':''}" data-tab="${k}" ${s?'':'disabled'}>${n}</button>`).join('')
    +`<button class="dclose" id="dclose">${state.dockOpen?'▼ 閉じる':'▲ 開く'}</button>`;
  tabs.querySelectorAll('.dtab').forEach(b=>b.onclick=()=>{ if(!s) return; state.tab=b.dataset.tab; if(!state.dockOpen) toggleDock(); renderDock(); });
  $('#dclose').onclick=toggleDock;
  if(!s){ $('#dockBody').innerHTML=portfolioHTML(); bindPortfolio(); return; }
  ({earth:renderEarthTab,plan:renderPlanTab,const:renderConstTab,sched:renderSchedTab,wm:renderWMTab,wx:renderWxTab,tide:renderTideTab,work:renderWorkTab,fleet:renderFleetTab,survey:renderSurveyTab,consult:renderConsultTab,ai:renderAiTab,cmp:renderCmpTab,prog:renderProgTab})[state.tab](s);
}
function toggleDock(){ state.dockOpen=!state.dockOpen; $('#dock').classList.toggle('closed',!state.dockOpen); renderDock(); }
function refreshDockTime(){
  const s=byId(state.sel);
  if(!s){ const a=$('#pfBody'); if(a) a.innerHTML=portfolioTable(); const g=$('#pfGantt'); if(g) g.innerHTML=portfolioGantt(); return; }
  if(state.tab==='sched'){ $('#ganttBox').innerHTML=ganttSVG(s); $('#scurveBox').innerHTML=scurveSVG(s); bindGanttClick(s); }
  if(state.tab==='wm') $('#wmState').innerHTML=wmStateHTML(s);
  if(state.tab==='const') renderConstTab(s);
}
// 海上工事で名前・範囲が変わる入力項目
const MFIELDS={ FH:['計画高（T.P.）','m',-30,30,.1], cap:['土運船 積載（ほぐし）','m³/隻',200,3000,50], ex:['グラブ浚渫船','隻',0,6,1], qEx:['　日当り浚渫量','m³/隻日',300,5000,50],
  trucks:['土運船','隻',0,20,1], dExt:['処分場・土取場までの距離','km',1,60,1], rollers:['揚土・敷均し','組',0,8,1], qR:['　日当り揚土・敷均し','m³/組日',500,10000,100], rain:['荒天・波浪休止率','%',0,50,1] };
const FIELDS={ FH:['計画地盤高 FH','T.P. m',-50,3000,.1], pit:['根切り深さ','m',0,20,.1],
  soil:['土質',''], usable:['流用可能率','%',0,100,5], cap:['ダンプ積載（ほぐし）','m³/台',2,12,.5],
  ex:['バックホウ（0.7m³級）','台',0,12,1], qEx:['　日当り掘削積込','m³/台日',100,800,10], trucks:['ダンプトラック（10t）','台',0,60,1], dExt:['場外運搬距離','km',1,60,1],
  rollers:['ブルドーザ＋ローラ','組',0,8,1], qR:['　日当り締固め','m³/組日',200,1500,50], hours:['稼働時間','h/日',4,12,1], days:['稼働日','日/週',4,7,1],
  rain:['雨天・休止率','%',0,40,1], winterF:['冬期の土工稼働率','%',0,100,5] };
function fieldHTML(s,k,label){
  const [lab,unit,min,max,step]=(s.k.marine&&MFIELDS[k])||FIELDS[k];
  if(k==='soil') return `<label for="f_soil">${lab}</label><span class="in"><select id="f_soil" data-k="soil">${Object.entries(SOILS).map(([key,v])=>`<option value="${key}"${s.p.soil===key?' selected':''}>${v.name}（L=${v.L.toFixed(2)}／C=${v.C.toFixed(2)}）</option>`).join('')}</select></span>`;
  const val = k==='FH'?s.FH : k==='pit'?s.pit : s.p[k];
  return `<label for="f_${k}">${label||lab}</label><span class="in"><input id="f_${k}" type="number" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${Math.round(val*10)/10}">${unit}</span>`;
}
function bindFields(s,onChange){
  $('#dockBody').querySelectorAll('[data-k]').forEach(el=>el.addEventListener(el.dataset.k==='FH'||el.dataset.k==='pit'?'change':'input',()=>{
    const k=el.dataset.k; let v=el.value;
    if(k!=='soil'){ v=parseFloat(v); if(!isFinite(v)) return; const [, ,min,max]=(s.k.marine&&MFIELDS[k])||FIELDS[k]; v=clamp(v,min,max); }
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
      <tr><td>${s.k.marine?'処分場・土取場までの距離':'残土運搬距離'}</td><td>${p.dExt} km${s.k.marine?'（サンプル値）':`（地域標準 ${rg.dExt} km）`}</td></tr>
      <tr><td>${s.k.marine?'灯浮標で囲む延長':'仮囲い延長'}</td><td>約 ${fmtN(per)} m</td></tr>${s.k.marine?'':crane}
      <tr><td>${s.k.marine?'土運船の運航':'工事車両'}</td><td>${act?(s.k.marine?`土運船 ${fmt1(r.dailyExt)} 隻・回/日（航路・漁船との調整が必要）`:`場外ダンプ ${fmt1(r.dailyExt)} 台/日・往復 ${fmtN(r.dailyExt*2)} 台/日`):'土工完了・資材搬入のみ'}</td></tr>
      <tr><td>${s.k.marine?'警戒船':'交通誘導員'}</td><td>${s.k.marine?'1 隻以上（作業区域の警戒・目安）':`${act?guards:1} 名（ゲート配置の目安）`}</td></tr></table>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" data-ly="route">3Dで搬出ルート</button><button class="btn ghost" data-ly="design">3Dで計画面</button></div></div>
    <div class="card"><h3>主要機械編成（土工） ${whatIfNote(s)}</h3><table class="t">
      <tr><th>機械</th><th class="n">台数</th><th class="n">能力</th></tr>
      <tr><td>${s.k.marine?'グラブ浚渫船':'バックホウ 0.7m³級'}</td><td class="n">${p.ex}</td><td class="n">${fmtN(s.cur.cap.ex)} m³/日</td></tr>
      <tr><td>${s.k.marine?'土運船':'ダンプトラック 10t'}</td><td class="n">${p.trucks}</td><td class="n">${fmtN(s.cur.cap.truck)} m³/日</td></tr>
      <tr><td>${s.k.marine?'揚土・敷均し':'ブルドーザ＋ローラ'}</td><td class="n">${p.rollers}</td><td class="n">${isFinite(s.cur.cap.roller)?fmtN(s.cur.cap.roller)+' m³/日':'—'}</td></tr></table>
      <table class="t" style="margin-top:8px"><tr><td>土質</td><td>${eb.so.name}（L ${eb.so.L.toFixed(2)}／C ${eb.so.C.toFixed(2)}）</td></tr>
      <tr><td>運搬走行距離</td><td>約 ${fmtN(r.truckKm)} km</td></tr></table>
      </div></div>`;
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
  $('#dockBody').innerHTML=`<div class="g2">
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
  rows.push(['稼働重機',e>.001&&e<.999?`${s.k.marine?`浚渫船 ${s.p.ex}・土運船 ${s.p.trucks}・揚土 ${s.p.rollers}`:`BH ${s.p.ex}・DT ${s.p.trucks}・転圧 ${s.p.rollers}`}`:'（土工なし）']);
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
    ${row('実効施工量',a.res.rate,b.res.rate,fmtN,'','higher')}${row('場外ダンプ/日',a.res.dailyExt,b.res.dailyExt,fmt1,'','lower')}</table>
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

// 海上工事の目印：施工範囲の角と辺に灯浮標（黄色）、範囲の周りに海面（T.P.0m）
const SEAB1=hex('#58798f'), SEAB2=hex('#6a8ba0');
function marineMarks(s,S){ const hw=s.area.w/2, hd=s.area.d/2, y=-s.yRef;
  const pts=[]; for(const [x0,z0,x1,z1] of [[-hw,-hd,hw,-hd],[hw,-hd,hw,hd],[hw,hd,-hw,hd],[-hw,hd,-hw,-hd]]){ const n=Math.max(1,Math.round(Math.hypot(x1-x0,z1-z0)/40)); for(let i=0;i<n;i++) pts.push([lerp(x0,x1,i/n),lerp(z0,z1,i/n)]); }
  for(const [x,z] of pts){ S.solids.push({m:trs(x,y-.3,z,0,1.6,1.6,1.6),c:[.98,.8,.1,1]},{m:trs(x,y+1.3,z,0,.4,1.4,.4),c:[.2,.2,.2,1]}); }
  S.trans.push({m:trs(0,y-.03,0,0,s.area.w*1.5,.04,s.area.d*1.5),c:[.2,.5,.85,.3]}); }

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
renderDock=function(){ if(!PRESENT){ _F.renderDock(); const s=byId(state.sel); if(s&&s.k.marine&&state.tab==='earth') $('#dockBody').appendChild(surveyCard(s)); return; }
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

/* =================== 深浅測量の取り込み（海上工事） =================== */
// 1行に「経度,緯度,高さ」または「東へ m,北へ m,高さ」（現場の中心から）。高さは T.P. m（海底は負の値）。
// 取り込んだ点から格子の海底高さを作り（近い点の距離の重み付き平均）、土量・工程を計算し直す。このブラウザの中だけで、保存はしない
function importSurvey(s,text){
  const pts=[]; for(const line of text.split(/\r?\n/)){ const v=line.split(/[,\s\t]+/).map(Number).filter(x=>!Number.isNaN(x)); if(v.length>=3) pts.push(v.slice(0,3)); }
  if(pts.length<20) throw new Error('点が少なすぎます（20点以上が必要）');
  const geo=pts.every(([a,b])=>Math.abs(a)<=180&&Math.abs(b)<=90&&Math.abs(a-s.lon)<1&&Math.abs(b-s.lat)<1);
  const P=pts.map(([a,b,h])=>geo?[(a-s.lon)*111320*Math.cos(s.lat*Math.PI/180),-(b-s.lat)*110574,h]:[a,-b,h]);   // 現場ローカル（x=東, z=南）
  const g=s.g, W=g.nx+1, cell=Math.max(g.dx,g.dz); let used=0;
  for(let k=0;k<g.nv;k++){ const x=g.LX[k], z=g.LZ[k]; let sw=0, sh=0, near=0;
    for(const [px,pz,h] of P){ const d=Math.hypot(px-x,pz-z); if(d<cell*4){ const w=1/Math.max(.25,d*d); sw+=w; sh+=w*h; near++; } }
    if(near) { g.E[k]=sh/sw-s.yRef; used++; } }
  if(used<g.nv*.5) throw new Error(`施工範囲の ${Math.round(used/g.nv*100)}% にしか点がありません（座標の形式・位置を確認してください）`);
  s.terr.src='深浅測量（取り込み・このブラウザのみ）'; buildDesign(s); calibrate(s); s.base=simulate(s,s.p0); resim(s); designDirty(s); terrainDirty=true; renderLedger(); renderSummary(); renderDock();
  return {n:pts.length, used, total:g.nv, geo};
}
function surveyCard(s){
  const el=document.createElement('div'); el.className='card'; el.style.marginTop='12px';
  el.innerHTML=`<h3>深浅測量の取り込み <small>XYZ／CSV（経度,緯度,T.P.高さ ／ 東m,北m,T.P.高さ）</small></h3>
    <p class="hint">いまの海底は<b>架空の深浅測量</b>です。実際の測量結果のファイルを選ぶと、その海底で浚渫・埋立の土量と工程を計算し直します（このブラウザの中だけ。保存は DB 化の後）。高さは T.P. に換算した値にしてください（DL 基準の値は、潮位表基準面の標高を足して T.P. にします）。</p>
    <label class="btn ghost" style="cursor:pointer;display:inline-block">ファイルを選ぶ<input type="file" accept=".csv,.xyz,.txt,text/plain" hidden></label> <span class="hint" data-r></span>`;
  el.querySelector('input').onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const r=importSurvey(s,await f.text()); toast(`深浅測量を取り込みました：${r.n} 点、格子の ${Math.round(r.used/r.total*100)}% を更新（${r.geo?'経度・緯度':'現場からの m'}）。`,7000); }
    catch(err){ el.querySelector('[data-r]').textContent='取り込めませんでした：'+(err.message||err); } };
  return el;
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

/* =====================================================================
   9d. サーバ版の画面（ログイン中の利用者・ログアウト・設定・AI による文章化）
   - 静的な配信（開発用）では何もしない
   ===================================================================== */
(()=>{ if(!SRV) return;
  const u=SRV.user, isAdmin=u.role==='admin', roleName={admin:'管理者',editor:'編集者',viewer:'閲覧者'}[u.role]||u.role;
  const scope=Array.isArray(u.branches)?(u.branches.length?u.branches.map(b=>BRANCHES[b]||b).join('・'):'なし'):'全支店';
  // ヘッダー：利用者・設定・ログアウト
  $('#keyBtn').insertAdjacentHTML('afterend',`<span class="userchip" title="${esc(u.email)}（${roleName}・閲覧範囲 ${esc(scope)}${u.via==='access'?'・Cloudflare Access でサインイン':''}）">👤 ${esc(u.email.split('@')[0])}・${roleName}${Array.isArray(u.branches)?`・${esc(scope)}`:''}</span>
    <button class="btn ghost" id="setBtn" title="${isAdmin?'連携の設定・パスワード変更':'パスワード変更'}">⚙</button><button class="btn ghost" id="logoutBtn">ログアウト</button>`);
  $('#logoutBtn').onclick=async()=>{ let r=null; try{ r=await api('POST','api/auth/logout'); }catch(e){} if(r&&r.logoutUrl){ location.href=r.logoutUrl; return; } location.reload(); };   // Cloudflare Access でサインインした人は、Access からサインアウト
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
  let pw=`<h3 style="font-size:13px;margin:14px 0 6px">パスワードの変更</h3><div class="form" style="grid-template-columns:auto 1fr">
    <label>いまのパスワード</label><input type="password" id="pwCur" autocomplete="current-password" style="width:auto;text-align:left">
    <label>新しいパスワード（12文字以上）</label><input type="password" id="pwNew" autocomplete="new-password" style="width:auto;text-align:left"></div>
    <div class="btns" style="margin-top:6px"><button class="btn" id="pwSave">変更する</button><span class="hint" id="pwMsg"></span></div>`;
  const viaAccess=SRV&&SRV.user.via==='access';
  if(viaAccess) pw=`<h3 style="font-size:13px;margin:14px 0 6px">パスワード</h3><p class="hint">Cloudflare Access（メールに届くワンタイム PIN）でサインインしています。この入口ではパスワードを使いません（社内 LAN の入口のパスワードは、社内 LAN から開いて変更してください）。</p>`;
  if(!SRV||SRV.user.role!=='admin'){ $('#setBody').innerHTML=pw; if(!viaAccess) bindPw(); return; }
  let S; try{ S=await api('GET','api/settings'); }catch(e){ $('#setBody').innerHTML=`<p class="keyErr">${esc(e.message)}</p>`+pw; if(!viaAccess) bindPw(); return; }
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
  if(!viaAccess) bindPw();
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
    ? [['heat','切盛ヒートマップ'],['design','計画面'],['route','搬出ルート'],['labels','ラベル'],['photo','航空写真']].map(([k,n])=>`<button data-layer="${k}" class="${state.layers[k]?'on':''}">${n}</button>`).join('')
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
    else if(Math.abs(diff)<.15||vp<=0) c=s.k.marine&&g.H[k]<-s.yRef?mix(SEAB1,SEAB2,g.VAR[k]):mix(GRASS1,GRASS2,g.VAR[k]); else if(vp<1) c=mix(SOIL,FIN,vp*.3); else c=g.SL[k]>.22?mix(FIN,GREEN,green):FIN;
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
  const hw=s.area.w/2, hd=s.area.d/2; if(s.k.marine) marineMarks(s,S); else { fence(-hw,-hd,hw,-hd); fence(hw,-hd,hw,hd); fence(hw,hd,-hw,hd); fence(-hw,hd,-hw,-hd);
  const gt=s.gate, gy=sampleH(s,gt.x,gt.z), ax=gt.ox?0:1, az=gt.ox?1:0; for(const k of [-1,1]) solid(box(gt.x+5*k*ax,gy,gt.z+5*k*az,.6,4,.6),hex('#475569')); solid(box(gt.x,gy+3.6,gt.z,ax?10.6:.6,.5,az?10.6:.6),ORANGE); }
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
  for(let k=0;k<=10;k++){ const lx=lerp(x0,gin[0],k/10), lz=lerp(z0,gin[1],k/10); pts.push([lx,s.k.marine?-s.yRef+.1:sampleH(s,lx,lz)+.1,lz]); }
  for(let k=0;k<=12;k++){ const lx=gt.x+gt.ox*k*12, lz=gt.z+gt.oz*k*12; pts.push([lx,s.k.marine?-s.yRef+.15:sampleH(s,lx,lz)+.15,lz]); }
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
  // 重機のアニメーション（バックホウ・ローラ・ダンプ・浚渫船・土運船）は表示しない
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
    hd.setInputAction(e=>{ if(window.PICK_HOOK){ window.PICK_HOOK(e.position); return; } if(state.mode!=='nation') return;
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
  if(key) connectGoogle(key); else { setStatus('simple'); if(!window.PORTAL_SERVER) openKeyDialog(); }   // サーバ版のキーは管理者が server/.env に置く
} else setStatus('nolib');

