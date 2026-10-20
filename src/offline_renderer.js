/* =====================================================================
   10. 3Dビュー（オフライン版：three.js で描く。外部への通信はしない）
   - 全国表示：都道府県・高速道路・現場ピンを、平面の日本地図（全国の座標系 km）で描く
   - 現場表示：施工範囲の地形・構造物・重機・周辺1kmの地形を、現場ローカル座標（m：x=東, y=上, z=南）で描く
   - 0〜9章（データ・ワールドモデル・台帳・タイムライン・管理パネル）はオンライン版と共通。この章（10〜12）だけを差し替える
   - オンライン版（CesiumJS＋Google 実写3D）へ戻すときは、同じ共通部分にオンライン版の 10〜12 章を組み合わせる
   ===================================================================== */
const T3 = window.THREE || null;
const useG = () => false;   // オフライン版は Google 実写3D を使わない
const GV = { r:null, cam:null, ctl:null, nat:null, site:null, scene:null, fly:null, ptrDown:false };
const LV = (()=>{ const v=[.45,1,.3], l=Math.hypot(...v); return v.map(x=>x/l); })();   // 光の来る向き（現場ローカル）

function trs(x,y,z,ry,sx,sy,sz){ const c=Math.cos(ry),s=Math.sin(ry), f=v=>Math.abs(v)<1e-3?(v<0?-1e-3:1e-3):v; sx=f(sx); sy=f(sy); sz=f(sz);
  return new Float32Array([c*sx,0,-s*sx,0,0,sy,0,0,s*sz,0,c*sz,0,x,y,z,1]); }
function sampleH(s,lx,lz){ const g=s.g, fx=(lx+s.area.w/2)/g.dx, fz=(lz+s.area.d/2)/g.dz;
  if(fx<0||fz<0||fx>g.nx||fz>g.nz) return sampleCtx(s,lx,lz)-s.yRef;
  const i=Math.min(Math.floor(fx),g.nx-1), j=Math.min(Math.floor(fz),g.nz-1), u=fx-i, v=fz-j, W=g.nx+1, H=g.H;
  return lerp(lerp(H[j*W+i],H[j*W+i+1],u), lerp(H[(j+1)*W+i],H[(j+1)*W+i+1],u), v); }

/* ---- 状態表示・お知らせ ---- */
function setStatus(kind){
  const el=$('#netStatus'); el.className='net '+(kind==='nolib'?'nolib':'simple');
  el.textContent=kind==='nolib'?'3D 表示不可':'オフライン版（通信なし）';
  el.title=kind==='nolib'?'このブラウザでは 3D（WebGL）を使えません。管理機能は使えます。':'外部と通信しません。地形・住所・行政区域・描画部品はすべてこのファイルに入っています。';
}
let toastTimer=null;
function toast(html,ms=7000){ const t=$('#toast'); t.innerHTML=html; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.hidden=true,ms); }

/* ---- カメラ（注視点・方位 yaw・仰角 pitch・距離）。全国表示は km、現場表示は m ---- */
const HOME={lon:136.6,lat:35.2,pitch:1.12,dist:3300};
const natPos=(lon,lat,y=0)=>{ const [X,Z]=toNat(lon,lat); return new T3.Vector3(X,y,Z); };
const pinPos=s=>natPos(s.lon,s.lat,.05);
function camState(){ const t=GV.ctl.target, d=new T3.Vector3().subVectors(GV.cam.position,t), dist=d.length()||1;
  return {t:t.clone(), yaw:Math.atan2(d.x,d.z), pitch:Math.asin(clamp(d.y/dist,-1,1)), dist}; }
function placeCam(t,yaw,pitch,dist){ GV.ctl.target.copy(t);
  GV.cam.position.set(t.x+dist*Math.sin(yaw)*Math.cos(pitch), t.y+dist*Math.sin(pitch), t.z+dist*Math.cos(yaw)*Math.cos(pitch)); GV.cam.lookAt(t); }
function flyTo(t,yaw,pitch,dist,dur=1.2,done){
  if(!GV.cam){ if(done) done(); return; }
  const a=camState(); let dy=yaw-a.yaw; dy=Math.atan2(Math.sin(dy),Math.cos(dy));
  GV.fly={a, t:t.clone(), yaw:a.yaw+dy, pitch, dist, t0:performance.now(), dur:Math.max(.05,dur)*1000, done}; GV.ctl.enabled=false;
}
function stepFly(now){ const f=GV.fly; if(!f) return; const u=clamp((now-f.t0)/f.dur,0,1), e=ease(u);
  placeCam(new T3.Vector3().lerpVectors(f.a.t,f.t,e), lerp(f.a.yaw,f.yaw,e), lerp(f.a.pitch,f.pitch,e), Math.exp(lerp(Math.log(f.a.dist),Math.log(f.dist),e)));
  if(u>=1){ GV.fly=null; GV.ctl.enabled=true; GV.ctl.update(); if(f.done) f.done(); } }
function siteView(s,over={}){ const R=Math.max(s.area.w,s.area.d), H=Math.max(10,siteTop(s)); return {ty:(s.FH-s.yRef)+H*.25,yaw:.75,pitch:.55,dist:(R*1.15+H*1.1+40)*1.25,...over}; }
function flyHome(dur=2){ if(GV.cam&&state.mode==='nation') flyTo(natPos(HOME.lon,HOME.lat),0,HOME.pitch,HOME.dist,dur); }
function flyPref(p,dur=1.8){ if(!GV.cam||state.mode!=='nation') return; const b=p.main, lat=(b[1]+b[3])/2, dx=(b[2]-b[0])*Math.cos(lat*Math.PI/180)*111, dy=(b[3]-b[1])*111;
  flyTo(natPos((b[0]+b[2])/2,lat),0,1.0,clamp(Math.max(dx,dy)*1.7,120,2400),dur); }
function flyPoint(lon,lat){ if(GV.cam&&state.mode==='nation') flyTo(natPos(lon,lat),0,.95,5,2); }
function flySite(s,v,dur=1.4){ if(GV.cam&&state.mode==='site') flyTo(new T3.Vector3(0,v.ty,0),v.yaw,v.pitch,v.dist,dur); }
const currentYaw=()=>GV.cam?camState().yaw:0;

// 操作の割り当て：全国＝左ドラッグで移動・右ドラッグで回転と傾き、現場＝左ドラッグで回る・右ドラッグで平行移動。ホイールはズーム
function useScene(mode){
  if(!GV.r) return; const c=GV.ctl, M=T3.MOUSE, TO=T3.TOUCH;
  GV.scene = mode==='site' ? GV.site : GV.nat;
  if(mode==='site'){ c.mouseButtons={LEFT:M.ROTATE,MIDDLE:M.DOLLY,RIGHT:M.PAN}; c.touches={ONE:TO.ROTATE,TWO:TO.DOLLY_PAN};
    c.minDistance=4; c.maxDistance=4000; c.maxPolarAngle=1.52; c.screenSpacePanning=false; c.zoomToCursor=false; }
  else { c.mouseButtons={LEFT:M.PAN,MIDDLE:M.DOLLY,RIGHT:M.ROTATE}; c.touches={ONE:TO.PAN,TWO:TO.DOLLY_ROTATE};
    c.minDistance=1; c.maxDistance=7000; c.maxPolarAngle=1.25; c.screenSpacePanning=false; c.zoomToCursor=true; }
}
function enterSite(s,viaNation){
  state.mode='site'; ensureSite(s); useScene('site'); sceneDirty=true; terrainDirty=true;
  if(GV.cam){ const v=siteView(s); placeCam(new T3.Vector3(0,v.ty,0),v.yaw+.9,1.3,v.dist*3.2); flySite(s,v,viaNation?1.8:1.4); }
  renderTools(); renderLegend();
}
function enterNation(s){
  state.mode='nation'; clearSite(); useScene('nation'); renderTools(); renderLegend(); sceneDirty=true; if(!GV.cam) return;
  if(s) placeCam(pinPos(s),0,1.1,30);
  if(state.pref){ const p=PREFS.find(x=>x.name===state.pref); if(p){ flyPref(p,1.8); return; } }
  if(s) flyTo(pinPos(s),0,1.1,1600,2); else flyHome();
}
function renderTools(){
  $('#tools').innerHTML = state.mode==='site'
    ? `<button class="back" data-view="nation">◀ 全国へ</button><button data-view="site">現場正面</button><button data-view="bird">俯瞰</button><button data-view="top">真上</button><button data-view="eye">水平</button><button data-view="spin" class="${state.autoRotate?'on':''}">自動回転</button>`
    : `<button data-view="all">日本全体</button><button data-view="top">真上</button><button data-view="bird">斜め</button>`;
  $('#layers').innerHTML = (state.mode==='site'
    ? [['heat','切盛ヒートマップ'],['design','計画面'],['route','搬出ルート'],['labels','ラベル']]
    : [['roads','県境・高速道路'],['labels','ラベル']]).map(([k,n])=>`<button data-layer="${k}" class="${state.layers[k]?'on':''}">${n}</button>`).join('');
  $('#help').innerHTML = state.mode==='site'
    ? `<b>左ドラッグ</b> 現場の周りを回る　<b>右ドラッグ</b> 平行移動<br><b>ホイール</b> ズーム　<b>Esc</b> 全国へ　<b>Space</b> 再生`
    : `<b>ピン/ラベル</b> 現場へ　<b>都道府県クリック</b> 絞り込み<br><b>左ドラッグ</b> 移動　<b>右ドラッグ</b> 回転・傾き　<b>ホイール</b> ズーム`;
  const fe=$('#fiction'); fe.hidden = !(state.mode==='site'); fe.textContent = '工事・発注者・計画はすべて架空のサンプルです（当社の実工事ではありません）／周辺は国土地理院の標高データ';
}
$('#tools').addEventListener('click',e=>{ const b=e.target.closest('[data-view]'); if(b) applyView(b.dataset.view); });
function applyView(v){
  const s=byId(state.sel);
  if(v==='nation'){ select(null); return; }
  if(v==='all'){ if(state.pref) setPref('',false); flyHome(); return; }
  if(v==='spin'){ state.autoRotate=!state.autoRotate; renderTools(); return; }
  if(state.mode==='site' && s){ const t=siteView(s,{yaw:currentYaw()});
    if(v==='site') flySite(s,siteView(s)); if(v==='bird') flySite(s,{...t,pitch:.62},1); if(v==='top') flySite(s,{...t,pitch:1.5,dist:t.dist*1.05},1); if(v==='eye') flySite(s,{...t,pitch:.1,dist:t.dist*.85},1); }
  else if(GV.cam){ const a=camState(); flyTo(a.t,a.yaw,v==='top'?1.24:.8,a.dist,1); }
}
$('#compass').addEventListener('click',()=>{ if(!GV.cam) return; const a=camState(); flyTo(a.t,0,a.pitch,a.dist,.7); });
function setLayer(k,on){ state.layers[k]=on; document.querySelectorAll(`[data-layer="${k}"]`).forEach(b=>b.classList.toggle('on',on)); sceneDirty=true; terrainDirty=true;
  if(k==='roads') mapDirty=true; renderLegend(); }
$('#layers').addEventListener('click',e=>{ const b=e.target.closest('[data-layer]'); if(b) setLayer(b.dataset.layer,!state.layers[b.dataset.layer]); });
function renderLegend(){
  const L=state.layers;
  if(state.mode==='nation'){ $('#legend').innerHTML=`<div><span class="sw" style="background:#22c55e"></span>計画内</div><div><span class="sw" style="background:#f59e0b"></span>遅延予測 1〜14日</div><div><span class="sw" style="background:#ef4444"></span>遅延予測 15日超</div><div><span class="sw" style="background:#cddbb6"></span>現場のある都道府県</div><div><span class="sw" style="background:#f8fafc;border:1px solid #64748b"></span>県境</div><div><span class="sw" style="background:#e07b39"></span>高速道路</div>`; return; }
  const bg=`<div><span class="sw" style="background:#b9c99a"></span>周辺：標高データの地形（1km）</div><div><span class="sw" style="background:#7fa7c9"></span>水域（標高データなし）</div>`;
  $('#legend').innerHTML = bg + (L.heat
    ? `<div><span class="sw" style="background:#dc2626"></span>切土（現況が計画面より高い）</div><div><span class="sw" style="background:#2563eb"></span>盛土（現況が計画面より低い）</div><div><span class="sw" style="background:#f8fafc"></span>切盛なし</div>`
    : `<div><span class="sw" style="background:#a3b77f"></span>現況地盤（標高データ）</div><div><span class="sw" style="background:#b98d55"></span>土工中（施工フロント）</div><div><span class="sw" style="background:#d6c8a8"></span>計画地盤高で仕上がり</div>
       <div><span class="sw" style="background:#b8bcc2"></span>躯体・護岸・堤体の完了</div><div><span class="sw" style="background:linear-gradient(90deg,#9cc0fb,#c7b8f9)"></span>外装完了（現場色）</div><div><span class="sw" style="background:#f59e0b"></span>施工中</div>
       <div><span class="sw" style="background:rgba(120,160,230,.35);border:1px solid #93b4ef"></span>未施工（計画ボリューム）</div><div><span class="sw" style="background:repeating-linear-gradient(0deg,#a3b77f 0 3px,#6b7a52 3px 4px)"></span>等高線（実標高）</div>`);
}

/* =====================================================================
   11. 3D描画（three.js：自社の地形・構造物・重機・全国地図）
   ===================================================================== */
// 地形：頂点色＋陰影＋等高線（オンライン版と同じ式）
const TERR_VS=`attribute vec3 col;attribute float hgt;varying vec3 vC;varying vec3 vN;varying float vH;
void main(){vC=col;vN=normal;vH=hgt;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const TERR_FS=`uniform vec3 uL;uniform float uCI;varying vec3 vC;varying vec3 vN;varying float vH;
void main(){vec3 n=normalize(vN);vec3 c=vC;
#ifdef CONT
float q=vH/uCI;float w=fwidth(q);float f=abs(fract(q)-0.5);if(w>1e-5&&w<0.45&&f>0.5-w*1.15)c*=0.78;
#endif
float d1=max(dot(n,uL),0.0);float d2=max(dot(n,-uL),0.0);c*=0.56+0.46*d1+0.12*d2;gl_FragColor=vec4(c,1.0);}`;
// 箱（構造物・重機）と、その輪郭線
const BOX_VS=`attribute vec4 rgba;varying vec4 vC;varying vec3 vN;void main(){vC=rgba;vN=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const BOX_FS=`uniform vec3 uL;varying vec4 vC;varying vec3 vN;void main(){vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;
float d1=max(dot(n,uL),0.0);float d2=max(dot(n,-uL),0.0);gl_FragColor=vec4(vC.rgb*(0.52+0.46*d1+0.16*d2),vC.a);}`;
const LINE_VS=`attribute vec4 rgba;varying vec4 vC;void main(){vC=rgba;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const LINE_FS=`varying vec4 vC;void main(){gl_FragColor=vC;}`;
const MAT={};
function terrainMat(cont,ci){ const k=cont+'|'+ci; return MAT[k]||(MAT[k]=new T3.ShaderMaterial({vertexShader:TERR_VS,fragmentShader:TERR_FS,defines:cont?{CONT:''}:{},
  uniforms:{uL:{value:new T3.Vector3(...LV)},uCI:{value:ci}},side:T3.DoubleSide})); }
function boxMat(kind){ return MAT[kind]||(MAT[kind]= kind==='edge'
  ? new T3.ShaderMaterial({vertexShader:LINE_VS,fragmentShader:LINE_FS,transparent:true,depthWrite:false})
  : new T3.ShaderMaterial({vertexShader:BOX_VS,fragmentShader:BOX_FS,uniforms:{uL:{value:new T3.Vector3(...LV)}},side:T3.DoubleSide,transparent:kind==='trans',depthWrite:kind!=='trans'})); }

// 単位の箱：x,z は ±0.5、y は 0〜1（底面が原点）。面は外から見て反時計回りに並べる
const UNIT=(()=>{ const P=[],N=[],I=[], E=[];
  const faces=[[[1,0,0],[[.5,0,-.5],[.5,0,.5],[.5,1,.5],[.5,1,-.5]]],[[-1,0,0],[[-.5,0,.5],[-.5,0,-.5],[-.5,1,-.5],[-.5,1,.5]]],
    [[0,1,0],[[-.5,1,-.5],[.5,1,-.5],[.5,1,.5],[-.5,1,.5]]],[[0,-1,0],[[-.5,0,.5],[.5,0,.5],[.5,0,-.5],[-.5,0,-.5]]],
    [[0,0,1],[[.5,0,.5],[-.5,0,.5],[-.5,1,.5],[.5,1,.5]]],[[0,0,-1],[[-.5,0,-.5],[.5,0,-.5],[.5,1,-.5],[-.5,1,-.5]]]];
  for(const [n,q] of faces){ const a=q[0],b=q[1],c=q[2], u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    const cr=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], qq=(cr[0]*n[0]+cr[1]*n[1]+cr[2]*n[2])>0?q:[...q].reverse(), base=P.length/3;
    for(const p of qq){ P.push(...p); N.push(...n); } I.push(base,base+1,base+2,base,base+2,base+3); }
  const C=[]; for(const x of [-.5,.5]) for(const y of [0,1]) for(const z of [-.5,.5]) C.push([x,y,z]);
  for(let i=0;i<8;i++) for(let j=i+1;j<8;j++){ const d=[0,1,2].filter(k=>C[i][k]!==C[j][k]).length; if(d===1) E.push(...C[i],...C[j]); }
  return {P:new Float32Array(P),N:new Float32Array(N),I,E:new Float32Array(E)}; })();

// 箱の束：毎回まとめて1つの形にして描く（重機は毎フレーム、構造物は状態が変わったとき）
class BoxBatch{
  constructor(kind){ this.kind=kind; this.cap=0; this.obj=null; }
  ensure(n){ if(n<=this.cap&&this.obj) return; const old=this.obj; this.cap=Math.max(16,n,this.cap*2); const g=new T3.BufferGeometry(), edge=this.kind==='edge', vpb=edge?24:24;
    g.setAttribute('position',new T3.BufferAttribute(new Float32Array(this.cap*vpb*3),3).setUsage(T3.DynamicDrawUsage));
    g.setAttribute('rgba',new T3.BufferAttribute(new Float32Array(this.cap*vpb*4),4).setUsage(T3.DynamicDrawUsage));
    if(!edge){ g.setAttribute('normal',new T3.BufferAttribute(new Float32Array(this.cap*vpb*3),3).setUsage(T3.DynamicDrawUsage));
      const I=new Uint32Array(this.cap*36); for(let b=0;b<this.cap;b++) for(let k=0;k<36;k++) I[b*36+k]=UNIT.I[k]+b*24; g.setIndex(new T3.BufferAttribute(I,1)); }
    this.obj = edge ? new T3.LineSegments(g,boxMat('edge')) : new T3.Mesh(g,boxMat(this.kind));
    this.obj.frustumCulled=false; this.obj.renderOrder={solid:1,edge:2,trans:3}[this.kind];
    if(old){ const p=old.parent; if(p){ p.remove(old); p.add(this.obj); } old.geometry.dispose(); }
    else if(this.parent) this.parent.add(this.obj); }
  attach(parent){ this.parent=parent; this.ensure(16); if(this.obj.parent!==parent) parent.add(this.obj); return this; }
  set(items){ const n=items.length; this.ensure(n); const g=this.obj.geometry, P=g.attributes.position.array, C=g.attributes.rgba.array, Nn=g.attributes.normal?g.attributes.normal.array:null, edge=this.kind==='edge';
    const src=edge?UNIT.E:UNIT.P;
    for(let b=0;b<n;b++){ const m=items[b].m, c=items[b].c, o=b*24;
      const a0=m[0],a1=m[1],a2=m[2],a4=m[4],a5=m[5],a6=m[6],a8=m[8],a9=m[9],a10=m[10];
      for(let v=0;v<24;v++){ const x=src[v*3],y=src[v*3+1],z=src[v*3+2], k=(o+v)*3;
        P[k]=a0*x+a4*y+a8*z+m[12]; P[k+1]=a1*x+a5*y+a9*z+m[13]; P[k+2]=a2*x+a6*y+a10*z+m[14];
        const q=(o+v)*4; C[q]=c[0]; C[q+1]=c[1]; C[q+2]=c[2]; C[q+3]=c[3]; }
      if(Nn){ // 法線は 3x3 の余因子行列で変換（拡大縮小が軸ごとに違っても正しい向きになる）
        const c00=a5*a10-a6*a9, c01=a6*a8-a4*a10, c02=a4*a9-a5*a8, c10=a2*a9-a1*a10, c11=a0*a10-a2*a8, c12=a1*a8-a0*a9, c20=a1*a6-a2*a5, c21=a2*a4-a0*a6, c22=a0*a5-a1*a4;
        const det=a0*c00+a1*c01+a2*c02, sg=det<0?-1:1;
        for(let v=0;v<24;v++){ const x=UNIT.N[v*3],y=UNIT.N[v*3+1],z=UNIT.N[v*3+2], k=(o+v)*3;
          let nx=(c00*x+c10*y+c20*z)*sg, ny=(c01*x+c11*y+c21*z)*sg, nz=(c02*x+c12*y+c22*z)*sg; const l=Math.hypot(nx,ny,nz)||1; Nn[k]=nx/l; Nn[k+1]=ny/l; Nn[k+2]=nz/l; } } }
    g.attributes.position.needsUpdate=true; g.attributes.rgba.needsUpdate=true; if(Nn) g.attributes.normal.needsUpdate=true;
    if(edge) g.setDrawRange(0,n*24); else g.setDrawRange(0,n*36); this.obj.visible=n>0; }
}

// グリッド地形（x,z は現場ローカル m、高さは yRef 基準）。周囲に側面（スカート）を付ける
function gridMesh(nx,nz,X,Z,Hh,COL,yRef,skirtBase,skirtCol,cont,ci){
  const W=nx+1, nv=W*(nz+1), ring=[];
  for(let i=0;i<nx;i++) ring.push([i,0,i+1,0,0,-1]); for(let j=0;j<nz;j++) ring.push([nx,j,nx,j+1,1,0]);
  for(let i=nx;i>0;i--) ring.push([i,nz,i-1,nz,0,1]); for(let j=nz;j>0;j--) ring.push([0,j,0,j-1,-1,0]);
  const tot=nv+ring.length*4, P=new Float32Array(tot*3), N=new Float32Array(tot*3), Cc=new Float32Array(tot*3), Hg=new Float32Array(tot), I=[];
  const dX=(X[1]-X[0])||1, dZ=(Z[W]-Z[0])||1;
  for(let j=0;j<=nz;j++) for(let i=0;i<=nx;i++){ const k=j*W+i, i0=Math.max(0,i-1), i1=Math.min(nx,i+1), j0=Math.max(0,j-1), j1=Math.min(nz,j+1);
    const hx=(Hh[j*W+i1]-Hh[j*W+i0])/((i1-i0)*dX), hz=(Hh[j1*W+i]-Hh[j0*W+i])/((j1-j0)*dZ), l=Math.hypot(hx,hz,1);
    P[k*3]=X[k]; P[k*3+1]=Hh[k]; P[k*3+2]=Z[k]; N[k*3]=-hx/l; N[k*3+1]=1/l; N[k*3+2]=-hz/l;
    Cc[k*3]=COL[k*3]; Cc[k*3+1]=COL[k*3+1]; Cc[k*3+2]=COL[k*3+2]; Hg[k]=Hh[k]+yRef; }
  for(let j=0;j<nz;j++) for(let i=0;i<nx;i++){ const a=j*W+i; I.push(a,a+W,a+1,a+1,a+W,a+W+1); }
  let v=nv;
  for(const [ia,ja,ib,jb,ox,oz] of ring){ const a=ja*W+ia, b=jb*W+ib, base=v;
    for(const [src,bottom] of [[a,0],[b,0],[b,1],[a,1]]){ P[v*3]=P[src*3]; P[v*3+1]=bottom?skirtBase:P[src*3+1]; P[v*3+2]=P[src*3+2];
      N[v*3]=ox; N[v*3+1]=0; N[v*3+2]=oz; Cc[v*3]=skirtCol[0]; Cc[v*3+1]=skirtCol[1]; Cc[v*3+2]=skirtCol[2]; Hg[v]=P[v*3+1]+yRef; v++; }
    I.push(base,base+1,base+2,base,base+2,base+3); }
  const g=new T3.BufferGeometry();
  g.setAttribute('position',new T3.BufferAttribute(P,3)); g.setAttribute('normal',new T3.BufferAttribute(N,3));
  g.setAttribute('col',new T3.BufferAttribute(Cc,3)); g.setAttribute('hgt',new T3.BufferAttribute(Hg,1)); g.setIndex(I);
  const m=new T3.Mesh(g,terrainMat(cont,ci)); m.frustumCulled=false; return m;
}

/* ---- 現場オブジェクトの管理 ---- */
const SP={s:null, grp:null, terrain:null, ctx:null, design:null, solids:null, trans:null, edges:null, dyn:null, dynT:null};
function clearSite(){ if(SP.grp&&GV.site){ GV.site.remove(SP.grp); SP.grp.traverse(o=>{ if(o.geometry) o.geometry.dispose(); }); }
  Object.assign(SP,{s:null,grp:null,terrain:null,ctx:null,design:null,solids:null,trans:null,edges:null,dyn:null,dynT:null}); }
function ensureSite(s){
  if(!GV.site) return; if(SP.s===s && SP.grp) return; clearSite();
  SP.s=s; SP.grp=new T3.Group(); GV.site.add(SP.grp);
  SP.solids=new BoxBatch('solid').attach(SP.grp); SP.trans=new BoxBatch('trans').attach(SP.grp); SP.edges=new BoxBatch('edge').attach(SP.grp);
  SP.dyn=new BoxBatch('solid').attach(SP.grp); SP.dynT=new BoxBatch('trans').attach(SP.grp);
  buildCtx(s); buildDesignLines(s);
}
const SEA=hex('#7fa7c9');  // 標高データのない水域（海・河川）はデータ作成時に T.P.-1.0m ちょうどで埋めてあり、その値の点だけを水色で描く
function buildCtx(s){ // 周辺1kmの実標高（施工範囲の内側は沈めて重ならないようにする）
  const c=s.ctx, cn=c.cn, W=cn+1, st=c.cw/cn, nv=W*W, X=new Float32Array(nv), Z=new Float32Array(nv), H=new Float32Array(nv), COL=new Float32Array(nv*3), rng=Math.max(1,c.cmax-c.cmin);
  const hw=s.area.w/2-1, hd=s.area.d/2-1, low=s.g.minH-3;
  for(let j=0;j<=cn;j++) for(let i=0;i<=cn;i++){ const k=j*W+i, x=-c.cw/2+i*st, z=-c.cw/2+j*st; X[k]=x; Z[k]=z;
    H[k]=(Math.abs(x)<hw&&Math.abs(z)<hd)?low:c.C[k]-s.yRef; const col=c.C[k]===-1?SEA:mix(hex('#b9c99a'),hex('#c9b48a'),(c.C[k]-c.cmin)/rng*.85); COL.set(col,k*3); }
  s.contI = rng<12?1:rng<50?2:5;
  SP.ctx=gridMesh(cn,cn,X,Z,H,COL,s.yRef,c.cmin-s.yRef-12,hex('#8a7356'),true,s.contI); SP.grp.add(SP.ctx);
}
function buildDesignLines(s){
  if(SP.design){ SP.grp.remove(SP.design); SP.design.geometry.dispose(); SP.design=null; }
  const g=s.g, W=g.nx+1, step=Math.max(1,Math.round(6/g.dx)), a=[], pt=k=>a.push(g.LX[k],g.D[k]+.15,g.LZ[k]);
  for(let j=0;j<=g.nz;j+=step) for(let i=0;i<g.nx;i++){ pt(j*W+i); pt(j*W+i+1); }
  for(let i=0;i<=g.nx;i+=step) for(let j=0;j<g.nz;j++){ pt(j*W+i); pt((j+1)*W+i); }
  const geo=new T3.BufferGeometry(); geo.setAttribute('position',new T3.Float32BufferAttribute(a,3));
  SP.design=new T3.LineSegments(geo,MAT.design||(MAT.design=new T3.LineBasicMaterial({color:new T3.Color().setRGB(.1,.45,.95,T3.SRGBColorSpace),transparent:true,opacity:.7})));
  SP.design.renderOrder=2; SP.design.visible=state.layers.design; SP.grp.add(SP.design);
}
designDirty = s => { if(SP.s===s) buildDesignLines(s); sceneDirty=true; };
siteGL = ensureSite;

/* ---- 現況→計画面の地形（状態 S(t)） ---- */
const GRASS1=hex('#a3b77f'), GRASS2=hex('#93a86f'), SOIL=hex('#b98d55'), FIN=hex('#d6c8a8'), GREEN=hex('#7fa65a'), WHITE=[.97,.98,.99], RED=hex('#dc2626'), BLUE=hex('#2563eb');
function updateTerrain(s){
  const g=s.g, st=s.st, e=st.e, band=.12, heat=state.layers.heat, green=st.roles.green||0; if(!g.col) g.col=new Float32Array(g.nv*3);
  for(let k=0;k<g.nv;k++){ const vp=clamp((e*(1+band)-g.R[k])/band,0,1), diff=g.E[k]-g.D[k]; g.H[k]=g.E[k]+(g.D[k]-g.E[k])*vp; let c;
    if(heat){ const t=clamp(diff/4,-1,1); c=t>0?mix(WHITE,RED,t):mix(WHITE,BLUE,-t); }
    else if(Math.abs(diff)<.15||vp<=0) c=s.k.marine&&g.H[k]<-s.yRef?mix(SEAB1,SEAB2,g.VAR[k]):mix(GRASS1,GRASS2,g.VAR[k]); else if(vp<1) c=mix(SOIL,FIN,vp*.3); else c=g.SL[k]>.22?mix(FIN,GREEN,green):FIN;
    g.col[k*3]=c[0]; g.col[k*3+1]=c[1]; g.col[k*3+2]=c[2]; }
  const m=gridMesh(g.nx,g.nz,g.LX,g.LZ,g.H,g.col,s.yRef,g.minH-14,hex('#8a7356'),!heat,s.contI||2);
  SP.grp.add(m); if(SP.terrain){ SP.grp.remove(SP.terrain); SP.terrain.geometry.dispose(); } SP.terrain=m;
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
  SP.solids.set(S.solids); SP.trans.set([...S.ghosts,...S.trans]); SP.edges.set([...S.edges,...S.gedges]);
  sceneDirty=false;
}

/* ---- 重機（毎フレーム位置を更新） ---- */
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
  const sol=[], tr=[], L=state.layers, q=s.eq; if(!q) return {sol,tr};
  // 重機のアニメーション（バックホウ・ローラ・ダンプ・浚渫船・土運船）は表示しない
  if(L.route){ const R=q.route; for(let i=1;i<R.length;i++){ const p0=R[i-1], p1=R[i], dx=p1[0]-p0[0], dz=p1[2]-p0[2]; if(Math.hypot(dx,dz)<.05) continue;
    tr.push({m:trs((p0[0]+p1[0])/2,(p0[1]+p1[1])/2+.15,(p0[2]+p1[2])/2,Math.atan2(-dz,dx),Math.hypot(dx,dz),.12,1.4),c:[.96,.62,.04,.8]}); } }
  return {sol,tr};
}

/* ---- 全国表示：平面の日本地図（都道府県・県境・高速道路）と現場ピン ---- */
const NAT={fills:null, lines:null, pins:null, mark:null};
function buildNation(){
  if(!GV.nat) return;
  if(!NAT.fills){ const grp=new T3.Group();
    for(const p of PREFS){ const shapes=p.rings.filter(r=>r.length>=3).map(r=>new T3.Shape(r.map(([lo,la])=>{ const [X,Z]=toNat(lo,la); return new T3.Vector2(X,Z); })));
      const geo=new T3.ShapeGeometry(shapes); geo.rotateX(Math.PI/2);
      const m=new T3.Mesh(geo,new T3.MeshBasicMaterial({color:'#dfe6d3',side:T3.DoubleSide})); m.userData.pref=p.name; grp.add(m); }
    GV.nat.add(grp); NAT.fills=grp; }
  for(const m of NAT.fills.children){ const n=m.userData.pref; m.material.color.set(n===state.pref?'#f3e3ad':SITES.some(s=>s.pref===n)?'#cddbb6':'#dfe6d3'); }
  if(NAT.lines){ GV.nat.remove(NAT.lines); NAT.lines.traverse(o=>{ if(o.geometry) o.geometry.dispose(); }); }
  const grp=new T3.Group(), seg=(rings,closed)=>{ const a=[]; for(const r of rings){ const n=r.length; for(let i=0;i<(closed?n:n-1);i++){ const [x0,z0]=toNat(...r[i]), [x1,z1]=toNat(...r[(i+1)%n]); a.push(x0,.02,z0,x1,.02,z1); } }
    const g=new T3.BufferGeometry(); g.setAttribute('position',new T3.Float32BufferAttribute(a,3)); return g; };
  const line=(g,color,op=1)=>{ const l=new T3.LineSegments(g,new T3.LineBasicMaterial({color,transparent:op<1,opacity:op,depthTest:false})); l.renderOrder=2; return l; };
  if(state.layers.roads){ grp.add(line(seg(PREFS.filter(p=>p.name!==state.pref).flatMap(p=>p.rings),true),'#ffffff',.9)); grp.add(line(seg(ROADS,false),'#e07b39')); }
  else grp.add(line(seg(PREFS.filter(p=>p.name!==state.pref).flatMap(p=>p.rings),true),'#94a3b8',.35));
  const sp=PREFS.find(p=>p.name===state.pref); if(sp) grp.add(line(seg(sp.rings,true),'#d97706'));
  GV.nat.add(grp); NAT.lines=grp; mapDirty=false;
}
const PIN_VS=`uniform float uPR;attribute vec3 fc;attribute vec3 lc;attribute float sz;varying vec3 vF;varying vec3 vL;
void main(){vF=fc;vL=lc;gl_PointSize=sz*uPR;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const PIN_FS=`varying vec3 vF;varying vec3 vL;void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=length(p);if(r>1.0)discard;
vec3 c=r>0.86?vec3(0.06,0.09,0.16):r>0.55?vL:vF;gl_FragColor=vec4(c,1.0);}`;
function buildPins(){
  const n=SITES.length+1, g=new T3.BufferGeometry(), P=new Float32Array(n*3);
  SITES.forEach((s,i)=>{ const v=pinPos(s); P.set([v.x,v.y,v.z],i*3); });
  g.setAttribute('position',new T3.BufferAttribute(P,3)); g.setAttribute('fc',new T3.BufferAttribute(new Float32Array(n*3),3));
  g.setAttribute('lc',new T3.BufferAttribute(new Float32Array(n*3),3)); g.setAttribute('sz',new T3.BufferAttribute(new Float32Array(n),1));
  NAT.pins=new T3.Points(g,new T3.ShaderMaterial({vertexShader:PIN_VS,fragmentShader:PIN_FS,uniforms:{uPR:{value:GV.r.getPixelRatio()}},depthTest:false,transparent:true}));
  NAT.pins.frustumCulled=false; NAT.pins.renderOrder=10; GV.nat.add(NAT.pins);
}
const STC={ok:hex('#22c55e'),warn:hex('#f59e0b'),late:hex('#ef4444')};
function updatePins(now){
  if(!NAT.pins) return; const g=NAT.pins.geometry, F=g.attributes.fc.array, Lc=g.attributes.lc.array, Z=g.attributes.sz.array, P=g.attributes.position.array, nation=state.mode==='nation';
  SITES.forEach((s,i)=>{ const d=delayOf(s), sel=state.sel===s.id; F.set(d>14?STC.late:d>0?STC.warn:STC.ok,i*3); Lc.set(hex(s.color),i*3); Z[i]=nation&&matches(s)?(sel?17+3*Math.sin(now/200):13):0; });
  const k=SITES.length; if(nation&&state.mark){ const v=natPos(state.mark.lon,state.mark.lat,.05); P.set([v.x,v.y,v.z],k*3); F.set([1,1,1],k*3); Lc.set([.06,.09,.16],k*3); Z[k]=14; } else Z[k]=0;
  g.attributes.fc.needsUpdate=g.attributes.lc.needsUpdate=g.attributes.sz.needsUpdate=g.attributes.position.needsUpdate=true;
  NAT.pins.material.uniforms.uPR.value=GV.r.getPixelRatio();
}

/* ---- ラベル（HTML） ---- */
const labelEls={}; SITES.forEach(s=>{ const d=document.createElement('div'); d.className='lbl'; d.addEventListener('click',()=>select(s.id)); $('#labels').appendChild(d); labelEls[s.id]=d; });
const markEl=document.createElement('div'); markEl.className='lbl mark'; $('#labels').appendChild(markEl);
const unitM=()=>state.mode==='nation'?1000:1;   // 全国表示は km、現場表示は m
function project(pos){
  if(!pos||!GV.cam) return null; const cam=GV.cam, dir=new T3.Vector3(); cam.getWorldDirection(dir);
  if(new T3.Vector3().subVectors(pos,cam.position).dot(dir)<=0) return null;
  const v=pos.clone().project(cam), cv=GV.r.domElement; if(v.z>1) return null;
  return {x:(v.x+1)/2*cv.clientWidth, y:(1-v.y)/2*cv.clientHeight, w:cam.position.distanceTo(pos)*unitM()}; }
const lblCache={};
function updateLabels(){
  const cv=GV.r.domElement, W=cv.clientWidth, H=cv.clientHeight, rects=[], nation=state.mode==='nation', camH=GV.cam.position.y*unitM();
  const order=[...SITES].sort((a,b)=>(b.id===state.sel)-(a.id===state.sel));
  for(const s of order){
    const el=labelEls[s.id]; let pr=null;
    if(nation) pr=project(pinPos(s)); else if(s.id===state.sel) pr=project(new T3.Vector3(0,siteTop(s)+6,0));
    if(!state.layers.labels||!matches(s)||!pr||pr.x<-120||pr.x>W+120||pr.y<-60||pr.y>H+60){ el.style.display='none'; continue; }
    const p=Math.round(s.st.overall*100), pred=state.T>B, compact=nation&&camH>6e5, key=`${p}|${state.sel===s.id}|${pred}|${compact}|${s.st.e>0&&s.st.e<1}`;
    if(lblCache[s.id]!==key){ lblCache[s.id]=key; el.className='lbl'+(state.sel===s.id?' sel':'')+(compact?' mini2':'');
      el.innerHTML = compact ? `<div class="t"><span class="dot" style="background:${s.color}"></span>${esc(s.port)} ${p}%</div>`
        : `<div class="t"><span class="dot" style="background:${s.color}"></span>${esc(s.id)}${pred?' <span class="pr">予測</span>':''}</div><div class="s">${esc(s.name.length>14?s.name.slice(0,14)+'…':s.name)}</div><div class="s"><span class="mini"><i style="width:${p}%;background:${s.color}"></i></span>${p}%${s.st.e>0&&s.st.e<1?'・土工中':''}</div>`; }
    el.style.display=''; const bw=el.offsetWidth||80, bh=el.offsetHeight||24, oy=nation?10:0, r=[pr.x-bw/2,pr.y-bh-8-oy,pr.x+bw/2,pr.y-8-oy];
    if(nation && rects.some(q=>!(r[2]<q[0]||r[0]>q[2]||r[3]<q[1]||r[1]>q[3]))){ el.style.display='none'; continue; }
    rects.push(r); el.style.transform=`translate(${pr.x}px,${pr.y-oy}px) translate(-50%,-100%) translateY(-6px)`; el.style.zIndex=state.sel===s.id?100000:Math.round(50000-pr.w/1000);
  }
  if(nation && state.mark){ const pr=project(natPos(state.mark.lon,state.mark.lat,.05));
    if(pr){ markEl.style.display=''; markEl.textContent='📍 '+state.mark.label; markEl.style.transform=`translate(${pr.x}px,${pr.y-10}px) translate(-50%,-100%) translateY(-6px)`; } else markEl.style.display='none'; }
  else markEl.style.display='none';
}
function updateScale(){
  const Hc=GV.r.domElement.clientHeight; if(!Hc) return; const dist=GV.cam.position.distanceTo(GV.ctl.target)*unitM();
  const mPerPx=2*dist*Math.tan(GV.cam.fov*Math.PI/360)/Hc, target=mPerPx*90, pow=Math.pow(10,Math.floor(Math.log10(target))), nice=[1,2,5,10].map(k=>k*pow).filter(v=>v<=target*1.4).pop()||pow, px=nice/mPerPx;
  $('#scalebar').innerHTML=`${nice>=1000?(nice/1000).toLocaleString('ja-JP')+' km':nice+' m'}<i style="width:${px}px;margin-left:auto"></i>`;
}

/* ---- 初期化・クリック ---- */
function groundHit(x,y){ const cv=GV.r.domElement, rc=new T3.Raycaster(); rc.setFromCamera(new T3.Vector2(x/cv.clientWidth*2-1,-(y/cv.clientHeight)*2+1),GV.cam);
  const p=new T3.Vector3(); return rc.ray.intersectPlane(new T3.Plane(new T3.Vector3(0,1,0),0),p)?p:null; }
function pinAt(x,y){ let best=null, bd=14; for(const s of SITES){ if(!matches(s)) continue; const pr=project(pinPos(s)); if(!pr) continue; const d=Math.hypot(pr.x-x,pr.y-y); if(d<bd){ bd=d; best=s; } } return best; }
function initView(){
  const fail=msg=>{ $('#nogl').hidden=false; $('#nogl').innerHTML=msg+'<br>台帳・土量・工程などの管理機能は利用できます。'; GV.r=null; return false; };
  if(!T3) return fail('3D描画の部品を読み込めませんでした。');
  try{
    const el=$('#cz'), r=new T3.WebGLRenderer({antialias:true});
    r.setPixelRatio(Math.min(2,window.devicePixelRatio||1)); r.domElement.id='gl'; el.appendChild(r.domElement); GV.r=r;
    GV.cam=new T3.PerspectiveCamera(45,1,.01,1e5);
    GV.ctl=new T3.OrbitControls(GV.cam,r.domElement); GV.ctl.enableDamping=false; GV.ctl.rotateSpeed=.6;
    GV.nat=new T3.Scene(); GV.nat.background=new T3.Color('#c9dcee');
    GV.site=new T3.Scene(); GV.site.background=new T3.Color('#cfdff0');
    const resize=()=>{ const w=el.clientWidth||1, h=el.clientHeight||1; r.setSize(w,h,false); r.domElement.style.width='100%'; r.domElement.style.height='100%'; GV.cam.aspect=w/h; GV.cam.updateProjectionMatrix(); };
    resize(); new ResizeObserver(resize).observe(el);
    buildNation(); buildPins(); useScene('nation');
    placeCam(natPos(HOME.lon,HOME.lat),0,1.45,9000); flyHome(2.2);
    const cv=r.domElement; let down=null;
    cv.addEventListener('pointerdown',e=>{ down={x:e.clientX,y:e.clientY}; GV.ptrDown=true; if(GV.fly){ GV.fly=null; GV.ctl.enabled=true; } cv.classList.add('grabbing'); });
    window.addEventListener('pointerup',e=>{ GV.ptrDown=false; cv.classList.remove('grabbing');
      if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<5&&e.target===cv&&e.button===0&&state.mode==='nation'){
        const rc=cv.getBoundingClientRect(), x=e.clientX-rc.left, y=e.clientY-rc.top, s=pinAt(x,y);
        if(s) select(s.id); else { const h=groundHit(x,y); if(h){ const [lon,lat]=fromNat(h.x,h.z), p=pointInPref(lon,lat); setPref(p&&p.name!==state.pref?p.name:'',!!p); } } }
      down=null; });
    let lastPick=0; cv.addEventListener('pointermove',e=>{ if(state.mode!=='nation'||GV.ptrDown){ cv.classList.remove('hover'); return; } const tn=performance.now(); if(tn-lastPick<100) return; lastPick=tn;
      const rc=cv.getBoundingClientRect(); cv.classList.toggle('hover',!!pinAt(e.clientX-rc.left,e.clientY-rc.top)); });
    return true;
  }catch(e){ console.error(e); return fail('このブラウザでは 3D 表示（WebGL）を開始できませんでした。'); }
}
function render3D(now,dt){
  if(!GV.r) return; const s=byId(state.sel);
  stepFly(now);
  if(mapDirty) buildNation();
  updatePins(now);
  if(state.mode==='site'&&s&&SP.s===s){
    if(SP.design) SP.design.visible=state.layers.design;
    if(terrainDirty&&now-(GV.lastTerr||0)>110){ GV.lastTerr=now; updateTerrain(s); computeEquip(s); terrainDirty=false; }
    if(sceneDirty&&now-(GV.lastScene||0)>110){ GV.lastScene=now; buildSiteScene(s); }
    const dyn=dynItems(s,now/1000); SP.dyn.set(dyn.sol); SP.dynT.set(dyn.tr);
    if(state.autoRotate&&!GV.fly&&!GV.ptrDown){ const a=camState(); placeCam(a.t,a.yaw+dt*.12,a.pitch,a.dist); }
  }
  if(!GV.fly) GV.ctl.update();
  const d=GV.cam.position.distanceTo(GV.ctl.target), nat=state.mode==='nation';
  GV.cam.near=Math.max(nat?.0005:.05,d*.002); GV.cam.far=nat?d*20+4000:d*40+5000; GV.cam.updateProjectionMatrix();
  GV.r.render(GV.scene,GV.cam); updateLabels(); updateScale(); $('#needle').style.transform=`rotate(${camState().yaw}rad)`;
}

/* ---- キーボード ---- */
const typing=()=>/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'');
window.addEventListener('keydown',e=>{ if(e.key==='/'&&!typing()){ e.preventDefault(); $('#q').focus(); return; } if(typing()) return; const k=e.key.toLowerCase();
  if(k===' '){ e.preventDefault(); togglePlay(); return; } if(k==='home'){ applyView('all'); return; } if(k==='escape'){ if(state.sel) select(null); return; } });

/* =====================================================================
   12. 起動
   ===================================================================== */
const ok3d=initView(); setStatus(ok3d?'offline':'nolib');
renderTools(); renderLegend();
renderLedger(); renderSummary(); renderDock(); updateTimelineUI();
(function loop(){ let last=performance.now(), lastUI=0;
  const tick=now=>{ requestAnimationFrame(tick); const dt=Math.min(.05,(now-last)/1000); last=now;
    if(state.playing){ setT(state.T+state.speed*dt); if(state.T>=T_MAX){ state.playing=false; updPlayBtn(); } }
    if(worldDirty) worldUpdate();
    if(uiDirty && now-lastUI>140){ uiDirty=false; lastUI=now; updateTimelineUI(); renderLedger(); refreshDockTime(); }
    render3D(now,dt); };
  requestAnimationFrame(tick); })();
