// A simulated XR device for the local browser test. The application is unmodified.
const screens = new Map(), seen = [], objects = new Map(), images = [];
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function(img,...args) {
  if (this.canvas.width===960 && img.src) images.push(img.src);
  return drawImage.call(this,img,...args);
};
const originalText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function(str,x,y,...args) {
  if (this.canvas.width===960 && this.canvas.height===576) {
    if(y===65 && x===32) {screens.clear(); seen.push(str);}
    if (y < 460) screens.set(str,[x,y]);
  }
  return originalText.call(this,str,x,y,...args);
};
function assert(v,m){if(!v)throw Error(m);}
const delay = ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let i=0;i<250;i++){if(fn())return;await delay(40);} throw Error("timeout "+[...screens.keys()].join("|")+" "+document.querySelector("#assist-status").textContent); }
WebGL2RenderingContext.prototype.makeXRCompatible = async function(){};
Object.defineProperty(window,"XRWebGLBinding",{value:undefined,configurable:true});
Object.defineProperty(window,"XRWebGLLayer",{value:class {
 constructor(){this.framebufferWidth=800;this.framebufferHeight=640;this.framebuffer=null;}
 getViewport(){return {x:0,y:0,width:800,height:640};}
},configurable:true});
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const identityQ={x:0,y:0,z:0,w:1};
let xyz=[.3,0,-1], session, ticks=0, T;
const source={targetRaySpace:{},gripSpace:{},targetRayMode:"tracked-pointer",handedness:"right",
 gamepad:{mapping:"xr-standard",buttons:Array.from({length:6},()=>({pressed:false}))}};
const finger = {}, thumb = {}, joints = new Map();
const hand = {handedness:"right",targetRaySpace:{},targetRayMode:"tracked-pointer",
 hand:new Map([["index-finger-tip",finger],["thumb-tip",thumb]])};
const frame={
 getViewerPose(){const transform={position:{x:0,y:0,z:0},orientation:identityQ,matrix:identity};return {transform,views:[{transform,projectionMatrix:[1,0,0,0,0,1.25,0,0,0,0,-1.002,-1,0,0,-.2002,0]}]};},
 getPose(space){const matrix = identity.slice(); matrix.splice(12,3,xyz[0],xyz[1],xyz[2]+.08);
 return {emulatedPosition:space===hand.targetRaySpace,transform:{position:{x:xyz[0],y:xyz[1],z:xyz[2]+.08},orientation:identityQ,matrix}};},
 getJointPose(joint){return joints.get(joint)||null;}
};
Object.defineProperty(navigator,"xr",{value:{isSessionSupported:async()=>true,requestSession:async()=>{
 session = new EventTarget();
 Object.assign(session,{requestReferenceSpace:async()=>new EventTarget(),renderState:{},updateRenderState(s){Object.assign(this.renderState,s)},
 inputSources:[source],visibilityState:"visible",environmentBlendMode:"alpha-blend",
 requestAnimationFrame(cb){return requestAnimationFrame(t=>{if(!session.ended){ticks++;cb(t,frame)}})},cancelAnimationFrame:id=>cancelAnimationFrame(id),
 end:async()=>{session.ended=true;session.dispatchEvent(new Event("end"));}});
 frame.session=session;
 return session;
}}});
function press(point,inputSource=source){
 xyz=point;
 for (const type of ["selectstart","select","selectend"]) session.dispatchEvent(Object.assign(new Event(type),{inputSource,frame}));
}
function boardPoint(x,y,z=0) {
 const board=objects.get("MR panel");
 return board.localToWorld(new T.Vector3(x/960-.5,(.5-y/576)*.6,z/board.scale.x));
}
function tapAt(x,y) {
 const p=boardPoint(x,y);
 press([p.x,p.y,p.z+.10]);
}
function button(name){
 let pos=screens.get(name);
 if(!pos) for(const [row,p] of screens) {
   if(name.startsWith(row) && p[1]>130 && p[1]<455) {
     const lines=[...screens].filter(([,q])=>q[0]===p[0]&&q[1]>=p[1]&&q[1]-p[1]<80);
     if(lines.map(([s])=>s).join("").startsWith(name)){pos=p;break;}
   }
 }
 assert(pos,name+" not shown: "+[...screens.keys()]);
 tapAt(pos[0]+12,pos[1]-6);
}
function more(name){
 button("その他の操作");
 for(let i=0;!screens.has(name)&&i<5;i++)button("次の一覧");
 button(name);
}
function switchInput(from,to){
 session.inputSources=[to];
 session.dispatchEvent(Object.assign(new Event("inputsourceschange"),{added:[to],removed:from?[from]:[]}));
}
async function fingerAt(x,y,z,gap=.045){
 const p=boardPoint(x,y,z);
 joints.set(finger,{transform:{position:p},radius:.007});
 joints.set(thumb,{transform:{position:p.clone().add(new T.Vector3(gap,0,0))},radius:.007});
 const start=ticks;
 await until(()=>ticks>=start+3);
}
const plus=(a,b)=>a.map((v,i)=>v+b[i]);
let exception, cameraTrack;
const nativeMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia=async options=>{
  if (!options.video) return nativeMedia(options);
  const canvas=document.createElement("canvas"); canvas.width=320;canvas.height=240;
  const ctx=canvas.getContext("2d"); ctx.fillStyle="blue";ctx.fillRect(100,60,90,90);
  const stream=canvas.captureStream(10);cameraTrack=stream.getVideoTracks()[0];
  requestAnimationFrame(()=>ctx.fillRect(100,60,90,90));
  return stream;
};
addEventListener("error",e=>{exception=e.error?.stack||e.message});
addEventListener("load",async()=>{
 try {
  T=await import("/node_modules/three/build/three.module.js");
  const played = [], play = T.AnimationAction.prototype.play;
  T.AnimationAction.prototype.play=function(){played.push(this.getClip().name);return play.call(this);};
  const update=T.Object3D.prototype.updateMatrixWorld;
  T.Object3D.prototype.updateMatrixWorld=function(force) {
    if (this.name) objects.set(this.name,this);
    return update.call(this,force);
  };
  const api="/api/users/P1/manuals/"+new URLSearchParams(location.search).get("id")+"/workflow";
  const plan=await (await fetch(api+"/S4/alignment.json")).json();
  await until(()=>!document.querySelector("#enter-assist").hidden && document.querySelector("#steps").options.length);
  document.querySelector("#steps").value="task-1-step-4";
  document.querySelector("#capture-live").checked=false;
  document.querySelector("#enter-assist").click();
  await until(()=>ticks>=2 && screens.has("本体から始める"));
  switchInput(null,source);
  await delay(80);
  tapAt(70,508); // Pin before switching to direct touch.
  const board=objects.get("MR panel");
  for(const [x,y] of [[18,18],[942,18],[942,558],[18,558]]) {
    const opposite=()=>boardPoint(x<480?960:0,y<288?576:0);
    const anchor=opposite(), width=board.scale.x;
    const from=boardPoint(x,y), to=boardPoint(x+(x<480?-45:45),y+(y<288?-27:27));
    xyz=[from.x,from.y,from.z+.10];
    session.dispatchEvent(Object.assign(new Event("selectstart"),{inputSource:source,frame}));
    xyz=[to.x,to.y,to.z+.10];await until(()=>board.scale.x>width+.01);
    session.dispatchEvent(Object.assign(new Event("selectend"),{inputSource:source,frame}));
    assert(anchor.distanceTo(opposite())<1e-5,"opposite corner moved");
  }
  const factor=Number(localStorage.getItem("mr-alignment-panel-offset-size"));
  assert(factor>1.1,"corner sizing not stored");
  switchInput(source,hand);
  await fingerAt(942,18,.011);await fingerAt(942,18,.011,.01);
  const handWidth=board.scale.x, fixed=boardPoint(0,576);
  await fingerAt(872,60,.011,.01);
  assert(board.scale.x<handWidth-.01 && fixed.distanceTo(boardPoint(0,576))<1e-5,"direct pinch resize");
  await fingerAt(872,60,.011,.045);
  const start=screens.get("本体から始める");
  await fingerAt(start[0]+16,start[1]-4,.046);
  await fingerAt(start[0]+16,start[1]-4,.004);
  assert(seen.at(-1).includes("基準点"),"direct touch did not start registration");
  // The pointing ray misses the panel but the finger is still at its surface.
  await fingerAt(480,380,.004);
  press([-.6,.1,-1],hand);
  assert(screens.has("1 / 3"),"UI touch recorded a physical point");
  switchInput(hand,source);
  const base=[-.44,-.25,-1], panel=plus(base,[.025,.016,0]);
  await until(()=>images.some(url=>url.endsWith("/p002-01.png")));
  button("図を拡大");await until(()=>seen.at(-1)==="説明書の図");
  button("2倍に拡大");button("4倍に拡大");button("図全体");button("案内に戻る");
  const firstPoint=plus(plan.groups[0].fit[0].position,base);
  press(firstPoint);
  await until(()=>objects.get("Recorded physical landmarks")?.children.length===1);
  const marks=objects.get("Recorded physical landmarks"), model=objects.get("Registration reference model");
  const savedPoint = marks.children[0].getWorldPosition(new T.Vector3());
  const direction = model.quaternion.clone(), origin = model.position.clone();
  xyz = [origin.x,origin.y,origin.z+.25];
  const squeeze=type=>session.dispatchEvent(Object.assign(new Event(type),{inputSource:source,frame}));
  squeeze("squeezestart"); xyz[0]+=.12; await delay(160); squeeze("squeezeend");
  assert(model.position.distanceTo(origin)>.08 && model.quaternion.angleTo(direction)<.00001,"model grip translation");
  assert(marks.children[0].getWorldPosition(new T.Vector3()).distanceTo(savedPoint)<1e-6,"marker moved with model");
  source.gamepad.buttons[5].pressed=true;await until(()=>marks.children.length===0);
  source.gamepad.buttons[5].pressed=false;
  button("その他の操作");await delay(150);
  assert(objects.get("Live measurement tip")?.visible,"controller tip disappeared at menu");
  button("案内に戻る");
  function group(g,offset,fail=false){
    for(const p of g.fit)press(plus(p.position,offset));
    assert(seen.at(-1).includes("別の点で確認"),"missing holdout");
    for(const p of g.check)press(plus(plus(p.position,offset),fail?[.09,0,0]:[0,0,0]));
  }
  for(const i of plan.groups[0].quickFit)press(plus(plan.groups[0].fit[i].position,base));
  assert(screens.has("次のSTEP") && marks.children.length===3,"three-point entry");
  await until(()=>objects.get("Aligned device")?.visible);
  const aligned=objects.get("Aligned device"), socketMesh=aligned.getObjectByName(plan.targets.Socket.node);
  assert(aligned.position.length()===0 && new T.Vector3().setFromMatrixPosition(aligned.matrix).distanceTo(new T.Vector3(...base))<1e-6,"body registration");
  const roof=aligned.getObjectByName("Roof"), originalRoof=roof.getWorldPosition(new T.Vector3());
  const edge=n=>n.children.find(child=>child.isLineSegments2);
  const cup=edge(aligned.getObjectByName("CupBody")), plug=edge(aligned.getObjectByName("Plug"));
  await until(()=>edge(roof).visible && plug.visible && edge(socketMesh).visible);
  assert(roof.layers.mask===0 && socketMesh.layers.mask===0 && !cup.visible && !model.getObjectByName("Cup") && !model.getObjectByName("Carafe"),"fixed reference and line-only overlay");
  assert(plug.material.color.getHex()===0xbcff46,"motion outline color");
  await until(()=>!edge(roof).visible && !plug.visible);
  assert(model.quaternion.angleTo(direction)<1e-6,"rear target rotated reference model");
  button("図を拡大");button("次の図");
  await until(()=>images.some(url=>url.endsWith("/p003-04.png")));
  tapAt(480,220);
  assert([...screens.keys()].some(s=>s.includes("4倍")),"unannotated figure tap to zoom");
  button([...screens.keys()].find(s=>s.startsWith("次の範囲")));
  button("案内に戻る");
  const socket=plus(plus(base,plan.targets.Socket.position),[.035,0,0]);
  const beforeSocket=socketMesh.getWorldPosition(new T.Vector3());
  button("位置を直す");button("写真と点");await until(()=>seen.at(-1).includes("部品を指す"));
  assert(!aligned.visible,"model covered the physical point");
  press(socket);await until(()=>seen.at(-1).includes("実機と見比べる"));
  assert(cameraTrack.readyState==="ended","camera left open after shutter");
  button("音声で相談");button("案内に戻る");
  button("重なりを確認");assert(seen.at(-1).includes("AR支援"),"socket");
  assert(Math.abs(socketMesh.getWorldPosition(new T.Vector3()).x-beforeSocket.x-.035)<1e-6 && roof.getWorldPosition(new T.Vector3()).distanceTo(originalRoof)<1e-6,"local correction moved body");
  const count=played.length;
  button("次のSTEP");assert(played.length>count && screens.has("次のSTEP"),"automatic STEP motion");
  const spout=edge(aligned.getObjectByName("Spout"));
  await until(()=>spout.visible && !cup.visible);
  const position=spout.getWorldPosition(new T.Vector3());
  await until(()=>spout.getWorldPosition(new T.Vector3()).distanceTo(position)>.001);
  await until(()=>cup.visible);
  await until(()=>!cup.visible);
  more("動作を再生");
  button("STEPを選ぶ");button("マシンの起動");button([...screens.keys()].find(s=>s.startsWith("STEP 1")));
  more("位置合わせに戻る");button("操作パネルを詳しく");
  await until(()=>images.some(url=>url.endsWith("/p004-01.png")));
  group(plan.groups[1],panel,true);button("仮合わせで続ける");
  more("部品を選ぶ");button(plan.targets.Display.label);
  const display=plus(plan.targets.Display.position,panel);
  button("位置を直す");button("点だけ");press(display);button("重なりを確認");await delay(150);more("記録して終了");
  await until(()=>document.querySelector("#assist-status").textContent.includes("保存しました"));
  document.querySelector("#alignment-record").open = true;
  await until(()=>document.querySelector("#alignment-record li")?.textContent.includes("35 mm"));
  const evidence=[...document.querySelectorAll("#alignment-record a")];
  const imageLink=evidence.find(a=>a.href.includes("/alignment-photos/"));
  const savedRecord=await (await fetch(evidence.find(a=>a.href.includes("/alignment-records/")).href)).json();
  assert(imageLink.href.endsWith(savedRecord.record.parts.Socket.photo),"different photo in reviewer record");
  const shutter=new Image();shutter.src=imageLink.href;await shutter.decode();assert(shutter.naturalWidth===320,"shutter JPEG");
  assert(document.querySelector("#alignment-record").textContent.includes("仮位置"),"provisional part status missing");
  if(exception)throw Error(exception);
  await fetch("/report",{method:"POST",body:JSON.stringify({ok:true,ticks})});
 }catch(e){await fetch("/report",{method:"POST",body:JSON.stringify({ok:false,error:e.stack,exception,screen:[...screens.keys()],seen:seen.slice(-10)})});}
});
