import * as THREE from "three";
import {modelMotion} from "./model-motion.js";
import {AlignmentRun} from "./alignment-run.js";
import {openPanel} from "./capture-panel.js";
import {drawAlignmentCard} from "./alignment-card.js";
import {placedMarks} from "./alignment-marks.js";
import {alignmentLines} from "./alignment-lines.js";
import {pointCamera} from "./point-camera.js";
import {openQuestion} from "./live-question.js";

const tipDepth = .08;
function dot(radius,color) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius,14,10),
    new THREE.MeshBasicMaterial({color,depthTest:false}));
  mesh.renderOrder = 4;
  return mesh;
}
export async function openAlignment(session,plan,gltf,steps,initialStep,save,onHandContact,manual) {
  const run = new AlignmentRun(plan,steps,initialStep), motion = modelMotion(gltf);
  const scene = new THREE.Group();
  const camera = pointCamera();
  let shutterImage, realOnly = false, marksEnabled = true;
  let question, questionView, lastSpoken;
  const marks = placedMarks(scene);
  let board, placement, reference, paint;
  const root = new THREE.Group(), marker = dot(.006,0x50ff95);
  root.name = "Aligned device";
  root.matrixAutoUpdate = false;
  root.add(gltf.scene); scene.add(root,marker);
  const targets = new Map();
  gltf.scene.updateMatrixWorld(true);
  const outlines = new Map();
  for (const g of plan.groups) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.visible = false;
    scene.add(group);
    for (const name of g.surfaces) {
      const node = motion.nodes.get(name);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(node.geometry,35),
        new THREE.LineBasicMaterial({color:0xffc974}));
      edges.matrixAutoUpdate = false;
      edges.matrix.copy(node.matrixWorld);
      group.add(edges);
    }
    outlines.set(g.id,group);
  }
  for (const [id,target] of Object.entries(plan.targets)) {
    const node = motion.nodes.get(target.node);
    targets.set(id,node.worldToLocal(new THREE.Vector3(...target.position)));
  }
  // An independent miniature always shows the unmeasured model in its reference pose.
  const mini = gltf.scene.clone(true), miniStand = new THREE.Group(), miniPin = dot(.014,0xffa927);
  const overlay = alignmentLines(gltf,motion,plan,mini);
  const bounds = new THREE.Box3().setFromObject(mini), size = bounds.getSize(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.position.copy(bounds.getCenter(new THREE.Vector3())).negate();
  pivot.add(mini,miniPin); miniStand.add(pivot);
  miniStand.scale.setScalar(.32/Math.max(size.x,size.y,size.z));
  miniStand.name = "Registration reference model";
  scene.add(miniStand);
  let placed = false, grab = null;
  const grabRay = new THREE.Raycaster();
  function placeModel(pose) {
    const front = new THREE.Vector3(0,0,-1).applyQuaternion(pose.orientation);
    front.y = 0;
    if (front.lengthSq()<.001) front.set(0,0,-1);
    front.normalize();
    miniStand.position.copy(pose.position).addScaledVector(front,1.05)
      .addScaledVector(new THREE.Vector3(-front.z,0,front.x),.35);
    miniStand.position.y -= .45;
    miniStand.rotation.set(0,Math.atan2(-front.x,-front.z),0);
    placed = true;
  }
  const probes = new Map(), ray = new THREE.Raycaster();
  function input(source,frame,space) {
    const aimPose = frame.getPose(source.targetRaySpace,space);
    const pose = !source.hand && (!aimPose || aimPose.emulatedPosition) && source.gripSpace ?
      frame.getPose(source.gripSpace,space) : aimPose;
    if (!pose || (!source.hand && pose.emulatedPosition)) return null;
    const {position,orientation} = pose.transform;
    const origin = new THREE.Vector3().copy(position);
    const direction = new THREE.Vector3(0,0,-1).applyQuaternion(orientation);
    ray.set(origin,direction);
    let tip = origin.clone().addScaledVector(direction,tipDepth);
    if (source.hand) {
      const joint = frame.getJointPose(source.hand.get("index-finger-tip"),space);
      if (!joint || joint.emulatedPosition) return null;
      tip = new THREE.Vector3().copy(joint.transform.position);
    } else if (source.targetRayMode !== "tracked-pointer") return null;
    if (aimPose && pose !== aimPose) ray.set(new THREE.Vector3().copy(aimPose.transform.position),
      new THREE.Vector3(0,0,-1).applyQuaternion(aimPose.transform.orientation));
    board.updateWorldMatrix(true,false);
    const hit = ray.intersectObject(board,false)[0];
    const local = board.worldToLocal(tip.clone());
    const scale = board.scale.x;
    const nearPanel = source.hand && local.z*scale >= -.065 && local.z*scale < .10 &&
      (Math.abs(local.x)-.5)*scale < .025 && (Math.abs(local.y)-.3)*scale < .025;
    return {tip,hit,nearPanel};
  }
  let mode = "intro", page = 0, partPage = 0, menuPage = null, actions = [], busy = false;
  let figureIndex = 0, figureKey = "", expanded = false, zoom = 1, tile = 0, trackingLost = false, missingSeconds = 0;
  let pickerPage = 0, pickerTask;
  let landmarkPage = 0;
  const bPressed = new Set();
  let previewNode = null;
  let lastPlacement;
  // Insert neutral parents so animation tracks still address the original nodes and local transforms.
  const adjustments = [];
  const partsByNode = new Map(Object.entries(plan.targets).map(([id,t]) => [motion.nodes.get(t.node),id]));
  const groupsByNode = new Map(plan.groups.slice(1).map(g => [motion.nodes.get(g.node),g.id]));
  gltf.scene.traverse(node => {
    if (partsByNode.has(node) || groupsByNode.has(node)) adjustments.push({node,parentRest:node.parent.matrixWorld.clone()});
  });
  for (const a of adjustments) {
    a.frame = new THREE.Group(); a.frame.matrixAutoUpdate = false;
    a.node.parent.add(a.frame); a.frame.add(a.node);
  }
  function showModel() {
    motion.play([]);
    for (const [id,outline] of outlines) {
      const verified = run.record.groups[id];
      outline.visible = !!verified?.matrix && (mode === "overlay" || (mode === "work" && !!run.group));
      if (outline.visible) {
        outline.matrix.fromArray(verified.matrix);
        outline.matrixWorldNeedsUpdate = true;
      }
    }
    root.visible = !!run.bodyResult?.matrix && mode !== "intro" && mode !== "saving";
    if (realOnly || run.phase === "point" || mode === "correction" || mode === "question") root.visible = false;
    marker.visible = root.visible && mode === "work" && !run.group && !!run.target;
    marker.material.color.setHex(run.phase === "assist" && run.record.parts[run.part]?.verified ? 0x50ff95 : 0xffb637);
    previewNode = null;
    if (!root.visible) { if (!run.bodyResult?.matrix) lastPlacement = null; return; }
    root.matrix.fromArray(run.bodyResult.matrix);
    root.matrixWorldNeedsUpdate = true;
    const selected = marker.visible ? motion.nodes.get(run.target.node) : null;
    const correcting = ["point","inspect"].includes(run.phase);
    overlay.select(selected,!!selected && correcting,lastPlacement !== run.bodyResult);
    lastPlacement = run.bodyResult;
    for (const {node,frame,parentRest} of adjustments) {
      const id = partsByNode.get(node), group = run.record.groups[groupsByNode.get(node)];
      const part = (id === run.part && run.candidate) || run.record.parts[id];
      frame.matrix.identity();
      if (part?.offset || group?.matrix) {
        const basis = run.record.groups[plan.targets[id]?.group]?.matrix || group?.matrix || run.bodyResult.matrix;
        frame.parent.updateWorldMatrix(true,false);
        frame.matrix.copy(frame.parent.matrixWorld).invert().multiply(new THREE.Matrix4().fromArray(basis));
        if (part?.offset) frame.matrix.multiply(new THREE.Matrix4().makeTranslation(...part.offset));
        frame.matrix.multiply(parentRest);
      }
      frame.matrixWorldNeedsUpdate = true;
    }
    previewNode = selected;
    if (mode === "work" && !run.group && !run.override && ["assist","unavailable"].includes(run.phase))
      motion.play(run.step.clips);
  }
  function change(fn) {
    return () => { if (busy) return; fn?.(); page = 0; menuPage = null; expanded = false; showModel(); draw(); };
  }
  function add(label,fn,secondary = false) { actions.push({label,fn,secondary}); }
  function previous() { run.moveStep(-1); }
  function next() { run.moveStep(1); }
  function draw() {
    if (run.phase !== "point" && mode !== "camera" && camera.active) camera.stop();
    marks.update(run);
    actions = [];
    let title,body,point,progress = "", list = [];
    if (mode === "question" && questionView) {
      title=questionView.title; body=questionView.body;
      for (const [name,fn] of questionView.buttons) add(name,fn);
    } else if (mode === "intro") {
      title = plan.model+"　位置合わせ";
      body = "本体の3点を指すと、実機にモデルを重ねて選んだSTEPを表示します。\n"+plan.reference;
      add("本体から始める",change(() => { mode = "work"; }));
      add("音声で相談",ask);
    } else if (mode === "correction" || mode === "camera") {
      title = "部品の位置を直す";
      body = mode === "camera" ? "外向きカメラを準備しています。" : "青い球を1回置きます。「写真と点」なら、その瞬間の実写も配信PCに保存します。";
      if (run.message) body += "\n"+run.message;
      if (mode === "correction") add("写真と点",async () => {
        mode = "camera"; draw();
        try { if (await camera.open() && mode === "camera") { run.retryPart(); mode="work"; showModel(); draw(); } }
        catch { if (mode==="camera") { camera.stop(); mode="correction"; run.message="カメラを開けません。点だけでも続けられます。"; draw(); } }
      });
      add("点だけ",change(() => {camera.stop(); run.retryPart(); mode="work";}));
      add("戻る",change(() => {camera.stop(); mode="work";}));
    } else if (mode === "overlay") {
      title = "実機とモデルの重なり";
      body = "橙の輪郭を実機の外形と見比べてください。ずれがあれば該当範囲を取り直せます。";
      add("位置合わせに戻る",change(() => { mode = "recalibrate"; }));
      add("部品の案内に戻る",change(() => { mode = "work"; }));
    } else if (mode === "recalibrate") {
      title = "位置を合わせ直す";
      body = "動かした範囲を選んでください。その範囲の部品も改めて確認します。";
      add("本体を3点で合わせる",change(() => { run.recalibrate(0); run.quick = true; mode = "work"; }));
      for (const [i,g] of plan.groups.entries()) if (!i || run.bodyResult?.matrix)
        add(g.label+"を詳しく",change(() => { run.recalibrate(i); mode = "work"; }));
      add("案内に戻る",change(() => { mode = "work"; }));
    } else if (mode === "landmarks") {
      title = "取り直す点を選ぶ";
      const points = [...run.group.fit,...run.group.check];
      progress = (landmarkPage+1)+" / "+Math.ceil(points.length/4);
      points.slice(landmarkPage*4,landmarkPage*4+4).forEach((p,n) => {
        const i = landmarkPage*4+n;
        list.push({label:(i+1)+". "+p.label,fn:change(() => {run.retryPoint(i); mode = "work";})});
      });
      if (landmarkPage) add("前の一覧",change(() => landmarkPage--));
      if ((landmarkPage+1)*4<points.length) add("次の一覧",change(() => landmarkPage++));
      add("案内に戻る",change(() => {mode = "work";}));
    } else if (mode === "tasks" || mode === "steps") {
      const tasks = mode === "tasks", choices = tasks ? steps.filter((s,i) => steps.findIndex(t => t.task === s.task) === i) :
        steps.filter(s => s.task === pickerTask);
      title = tasks ? "手順を選ぶ" : choices[0].taskTitle;
      progress = (pickerPage+1)+" / "+Math.ceil(choices.length/4);
      choices.slice(pickerPage*4,pickerPage*4+4).forEach(s => list.push({
        label:tasks ? s.taskTitle : "STEP "+s.number+"　"+Array.from(s.text).slice(0,18).join(""),
        fn:change(() => {
          if (tasks) { pickerTask = s.task; pickerPage = 0; mode = "steps"; }
          else { run.moveStep(steps.indexOf(s)-run.index); mode = "work"; }
        })
      }));
      if (pickerPage) add("前の一覧",change(() => pickerPage--));
      if ((pickerPage+1)*4 < choices.length) add("次の一覧",change(() => pickerPage++));
      add("案内に戻る",change(() => { mode = "work"; }));
    } else if (mode === "parts") {
      title = "確認する部品を選ぶ";
      const parts = Object.keys(plan.targets);
      const count = Object.values(run.record.parts).filter(p => p.verified).length;
      progress = (partPage+1)+" / "+Math.ceil(parts.length/4);
      body = "確認済み "+count+" / "+parts.length+" 部品";
      for (const id of parts.slice(partPage*4,partPage*4+4)) {
        const result = run.record.parts[id];
        list.push({label:(result?.verified ? "✓ " : result?.provisional ? "仮 " : "")+plan.targets[id].label,fn:change(() => { run.choosePart(id); mode = "work"; })});
      }
      if (partPage) add("前の一覧",change(() => partPage--));
      if ((partPage+1)*4 < parts.length) add("次の一覧",change(() => partPage++));
      add("STEPに戻る",change(() => { mode = "work"; run.moveStep(0); }));
    } else if (mode === "saving") {
      title = "測定記録"; body = "配信PCに保存しています。";
    } else if (mode === "details") {
      title = "説明書　"+run.step.id+"　p."+run.step.pages.join(", ");
      body = [...run.step.precautions,run.step.text].join("\n");
      add("案内に戻る",change(() => { mode = "work"; }));
    } else if (run.group) {
      title = run.group.label+"の位置合わせ";
      point = run.groupPoint;
      const checking = run.phase === "check";
      if (point) {
        title += checking ? "　別の点で確認" : "　基準点";
        progress = (run.cursor+1)+" / "+(run.group.fit.length+run.group.check.length);
        body = point.label+"に青い球を合わせて決定してください。";
      } else {
        point = [...run.group.fit,...run.group.check][run.worst];
        body = point.label+"。この点だけ指し直すか、未確認のまま先へ進めます。";
        add("この点を取り直す",change(() => run.retryPoint()));
        add(run.fit ? "仮合わせで続ける" : "範囲を保留して次へ",change(() => run.skipGroup()));
        add("別の点を取り直す",change(() => {landmarkPage = 0; mode = "landmarks";}),true);
      }
      if (run.groupPoint) {
        if (run.samples.length || run.groupIndex && run.record.groups[plan.groups[run.groupIndex-1].id]?.locations?.length)
          add("1点戻す",change(() => run.undo()));
        add("この点を飛ばす",change(() => run.recordLandmark(null)));
      }
      add("この範囲をやり直す",change(() => run.restartGroup()),true);
      if (run.quick) add("本体を詳しく合わせる",change(() => run.recalibrate(0)),true);
      if (run.groupPoint) add("この範囲を保留",change(() => run.skipGroup()),true);
    } else {
      title = {point:"部品を指す",inspect:"実機と見比べる",assist:"AR支援",deferred:"保留中の部品",unavailable:"手順の案内"}[run.phase];
      if (run.groupResult?.matrix && (!run.groupResult.verified || run.candidate?.provisional || run.record.parts[run.part]?.provisional)) title += "（仮位置）";
      progress = run.override ? "部品確認" : "STEP "+run.step.number+" / "+steps.filter(s => s.task === run.step.task).length;
      point = run.target;
      if (run.phase === "unavailable") body = point ? "この部品の範囲は未確認です。" : "このSTEPは説明書で案内します。";
      if (run.phase === "point") {
        body = point.label+"に青い球を合わせて1回決定してください。"+(camera.active ? "同時に写真を撮ります。" : "");
        if (camera.active) add("点だけに切替",change(() => camera.stop()),true);
      }
      if (run.phase === "inspect") {
        body = (shutterImage ? "写真を撮りました。" : "")+"置いた点が「"+point.label+"」でよければ採用してください。迷ったら音声で相談できます。";
        add("重なりを確認",change(() => run.confirmPart()));
        add("音声で相談",ask);
        add("位置を取り直す",change(startCorrection));
      }
      if (["point","inspect"].includes(run.phase)) add("修正をやめる",change(() => { run.enterPart(); run.message = ""; }),run.phase==="inspect");
      if (run.phase === "point") add("見えない・保留",change(() => run.defer()),true);
      if (run.phase === "deferred") {
        body = "この位置は保留中です。確認できる状態で取り直せます。";
        add("位置を取り直す",change(startCorrection));
      }
      if (run.phase === "assist") {
        const measured = run.record.parts[run.part];
        body = (measured?.verified ? "確認済み　" : measured?.offset ? "補正した仮位置　" : "モデルの予測位置　")+point.label+"\n"+
          (run.override ? "実機と見比べてください。" : run.step.text+(plan.stepHints[run.step.id] ? "\n"+plan.stepHints[run.step.id] : ""));
        add("位置を直す",change(startCorrection));
      }
      if (!run.group && !run.override && run.step.clips.length && ["assist","unavailable"].includes(run.phase) && root.visible)
        add("動作を再生",change(),true);
      else if (run.phase === "assist") add("対象を再表示",change(),true);
      if (run.index || run.override) add("前のSTEP",change(previous),true);
      if (run.index+1 < steps.length || run.override) {
        const action = {label:"次のSTEP",fn:change(next),secondary:["point","inspect"].includes(run.phase)};
        actions.unshift(action);
      }
      add("部品を選ぶ",change(() => { mode = "parts"; }),true);
      add("STEPを選ぶ",change(() => { pickerPage = 0; mode = "tasks"; }),!["assist","unavailable"].includes(run.phase));
      add("手順・注意",change(() => { mode = "details"; }),true);
      add("位置合わせに戻る",change(() => { mode = "recalibrate"; }),true);
      add("範囲の重なり",change(() => { mode = "overlay"; }),true);
    }
    if (mode === "work" && !run.group && plan.targets.Socket && run.part !== "Socket") add("差込口を確認",change(() => {
      if (plan.targets.Socket) {
        const step = steps.findIndex(s => plan.stepTargets[s.id] === "Socket");
        if (step >= 0) run.moveStep(step-run.index); else run.choosePart("Socket");
      }
    }),true);
    if (mode === "work" && !run.group) add(realOnly ? "モデルを表示" : "実物だけ見る",change(() => { realOnly = !realOnly; }),true);
    if (mode === "work") add(marksEnabled ? "記録点を隠す" : "記録点を表示",change(() => {marksEnabled = !marksEnabled;}),true);
    const main = actions.filter(a => !a.secondary), more = actions.filter(a => a.secondary);
    if (mode === "work") {
      more.unshift({label:"記録して終了",fn:finish});
      if (run.phase!=="inspect") more.unshift({label:"音声で相談",fn:ask});
    }
    marks.group.visible = !realOnly && run.phase !== "point" && marksEnabled;
    const menu = mode === "work" && menuPage !== null;
    function controlsPage(n) { menuPage = n; page = 0; draw(); }
    if (menu) {
      const total = Math.ceil(more.length/4);
      title = "その他の操作"; body = ""; progress = (menuPage+1)+" / "+total;
      list = more.slice(menuPage*4,(menuPage+1)*4);
      main.length = 0;
      if (menuPage) main.push({label:"前の一覧",fn:() => controlsPage(menuPage-1)});
      if (menuPage+1 < total) main.push({label:"次の一覧",fn:() => controlsPage(menuPage+1)});
      main.push({label:"案内に戻る",fn:() => controlsPage(null)});
    } else if (more.length) main.push({label:"その他の操作",fn:() => controlsPage(0)});
    miniStand.visible = placed && !!run.group && mode === "work";
    miniPin.visible = !!point && mode === "work";
    if (point) miniPin.position.fromArray(point.position);
    const maps = [];
    if ((mode === "work" || mode === "details") && !menu) {
      const groupMap = run.group?.diagram;
      if (groupMap) {
        const i = run.phase === "failed" ? run.worst : run.cursor;
        maps.push({file:groupMap.file,point:groupMap.points[run.group.indices?.[i] ?? i]});
      }
      else if (run.group) maps.push(...manual.overview.map(file => ({file})));
      else {
        if (mode === "details") maps.push(...run.step.figures.map(file => ({file})));
        maps.push(...(manual.parts[run.part]?.figures || []));
        if (!run.override) maps.push(...run.step.figures.map(file => ({file})));
      }
    }
    const figures = maps.filter((m,i) => maps.findIndex(x => x.file === m.file) === i);
    const key = [mode,run.group?.id,run.cursor,run.step.id,run.part].join("/");
    if (key !== figureKey) { figureKey = key; figureIndex = 0; }
    if (mode === "work" && run.phase === "inspect" && shutterImage && !menu) figures.unshift({file:"shutter",url:shutterImage});
    const diagram = figures[figureIndex];
    function openFigure() {expanded = true; zoom = 1; tile = 0; draw();}
    const tiles = zoom*zoom;
    if (expanded && diagram) {
      title = diagram.url ? "指した瞬間の写真" : "説明書の図"; progress = (diagram.url ? "" : "p."+Number(diagram.file.slice(1,4))+"　")+zoom+"倍";
      main.length = 0;
      main.push({label:zoom === 1 ? "2倍に拡大" : zoom === 2 ? "4倍に拡大" : "図全体",fn:() => {
        zoom = zoom === 4 ? 1 : zoom*2;
        const [x,y] = diagram.point || [0,0];
        tile = Math.min(zoom-1,Math.floor(y*zoom))*zoom+Math.min(zoom-1,Math.floor(x*zoom)); draw();
      }});
      if (zoom > 1) main.push({label:"次の範囲 "+(tile+1)+"/"+tiles,fn:() => { tile = (tile+1)%tiles; draw(); }});
      if (figures.length>1) main.push({label:"次の図",fn:() => {figureIndex = (figureIndex+1)%figures.length; zoom = 1; tile = 0; draw();}});
      main.push({label:"案内に戻る",fn:() => {expanded = false; draw();}});
    }
    const pointing = mode === "work" && !expanded && !menu && ["fit","check","point"].includes(run.phase);
    if (["intro","work","correction"].includes(mode) && !menu && !expanded) {
      const key=[mode,run.step.id,run.part,run.phase,run.group?.id,run.cursor,camera.active].join("/");
      if (key!==lastSpoken) {
        lastSpoken=key;
        if (!document.hidden) manual.speak((mode==="work" && run.phase==="assist" ? "実機とモデルを見比べます。" : "")+
          body+(mode==="intro" ? " 困ったら音声で相談できます。" : ""));
      }
    }
    paint?.({alignmentSize:expanded ? "reading" : "work",figure:diagram && {url:diagram.url || manual.base+encodeURIComponent(diagram.file)},drawContent:surface => drawAlignmentCard(surface,{
      title,body,progress,list,main,diagram,expanded,zoom:expanded ? zoom : 1,tile,openFigure,page,
      readTile:i => { zoom = 4; tile = i; draw(); },
      pointing,
      message:pointing && trackingLost ? "手またはコントローラーを視野に戻してください。" : mode === "work" && !menu ? run.message : "",
      advance:pages => {page = (page+1)%pages; draw();}
    })});
  }
  function startCorrection() { shutterImage=null; run.message=""; mode="correction"; }
  function ask() {
    const previousMode=mode;
    const photo=run.phase==="inspect" && run.candidate?.photo && shutterImage;
    const context=JSON.stringify({model:plan.model,step:run.step.id,text:run.step.text,precautions:run.step.precautions,
      target:run.groupPoint?.label || run.target?.label,state:run.phase,group:run.group?.label,
      instruction:"本体の3点を合わせ、部品修正は実物を1回指して目視採用。"});
    camera.stop();manual.speak("");mode="question"; menuPage=null; page=0; showModel();
    question=openQuestion(context,photo ? async()=>photo : null,(title,body,buttons)=>{
      if (mode!=="question") return;
      questionView={title,body,buttons};page=0;draw();
    },()=>{mode=previousMode;questionView=null;showModel();draw();});
  }
  async function finish() {
    if (busy) return;
    busy = true; mode = "saving"; showModel(); draw();
    try { await save(run.record,camera.images); await session.end(); }
    catch (e) { busy = false; menuPage = null; mode = "work"; run.message = e.message; showModel(); draw(); }
  }
  async function select(e) {
    if (busy || !reference || placement.drag || grab || expanded || session.visibilityState !== "visible" ||
        mode !== "work" || menuPage !== null || !["fit","check","point"].includes(run.phase)) return;
    const pose = input(e.inputSource,e.frame,reference);
    if (!pose || pose.hit || pose.nearPanel) return;
    if (run.phase === "point" && camera.active) {
      try { shutterImage = camera.snap(); onHandContact(); }
      catch (err) { run.message=err.message; draw(); return; }
    }
    run.point(pose.tip.toArray());
    if (run.phase === "inspect" && shutterImage) {
      const candidate = run.candidate;
      const viewer = e.frame.getViewerPose(reference);
      if (viewer) candidate.viewerMatrix = Array.from(viewer.transform.matrix);
      camera.stop(); busy = true;
      try { candidate.photo = await camera.keep(shutterImage); }
      catch { shutterImage=null; run.message="写真を保持できませんでした。点の採用か撮り直しを選んでください。"; }
      finally { busy=false; }
    }
    page = 0; showModel(); draw();
  }
  function resetSpace() {
    question?.close();
    camera.stop(); shutterImage=null;
    if (mode === "saving") return;
    run.record.events.push({type:"tracking-origin-reset"});
    run.recalibrate(0);
    run.quick = true;
    mode = "intro"; placed = false; grab = null; expanded = false; menuPage = null; page = 0; showModel(); draw();
  }
  function close() {
    question?.close();
    camera.stop();
    session.removeEventListener("selectstart",select);
    reference?.removeEventListener("reset",resetSpace);
    marks.close();
    const geometries = new Set(), materials = new Set(overlay.materials);
    scene.traverse(n => {
      if (n.geometry) geometries.add(n.geometry);
      for (const m of [].concat(n.material || [])) materials.add(m);
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }
  root.visible = marker.visible = false;
  paint = await openPanel(session,onHandContact,{
    placementKey:"mr-alignment-panel-offset",
    mount(world,screen,layout) { world.add(scene); board = screen; placement = layout; },
    grab(controller,ray) {
      if (!miniStand.visible || grab) return false;
      grabRay.ray.copy(ray);
      const hit = grabRay.intersectObject(mini,true)[0];
      if (!hit) return false;
      grab = {controller,distance:hit.distance,offset:miniStand.position.clone().sub(hit.point)};
      return true;
    },
    release(controller) { if (grab?.controller === controller) grab = null; },
    ready(space) {
      reference = space;
      reference.addEventListener("reset",resetSpace);
      session.addEventListener("selectstart",select);
    },
    close,
    frame(frame,space,seconds) {
      if (!frame) { grab = null; bPressed.clear(); }
      if (frame && !placed && mode === "work") {
        const viewer = frame.getViewerPose(space);
        if (viewer) { placeModel(viewer.transform); draw(); }
      }
      if (grab && !grab.controller.visible) grab = null;
      if (grab) {
        grab.controller.updateWorldMatrix(true,false);
        grabRay.ray.origin.setFromMatrixPosition(grab.controller.matrixWorld);
        grabRay.ray.direction.set(0,0,-1).transformDirection(grab.controller.matrixWorld);
        grabRay.ray.at(grab.distance,miniStand.position).add(grab.offset);
      }
      let tracked = false;
      for (const [source,d] of probes) {
        d.visible = false;
        if (Array.prototype.indexOf.call(session.inputSources,source)<0) {
          d.removeFromParent(); d.material.dispose(); d.geometry.dispose();
          probes.delete(source); bPressed.delete(source);
        }
      }
      for (const source of frame ? session.inputSources : []) {
        const pose = input(source,frame,space);
        if (!pose) continue;
        tracked = true;
        const b = source.handedness === "right" && source.gamepad?.mapping === "xr-standard" && source.gamepad.buttons[5]?.pressed;
        if (b && !bPressed.has(source) && run.group && mode === "work" && !expanded && menuPage === null && !grab) { run.undo(); draw(); }
        if (b) bPressed.add(source); else bPressed.delete(source);
        if (!probes.has(source)) { const d = dot(.005,0x52dcff); d.name="Live measurement tip"; d.renderOrder=10; probes.set(source,d); scene.add(d); }
        const d = probes.get(source); d.visible = true;
        d.position.copy(pose.tip);
      }
      missingSeconds = tracked ? 0 : missingSeconds+seconds;
      if (trackingLost !== (missingSeconds>.4)) { trackingLost = missingSeconds>.4; draw(); }
      if (root.visible) {
        motion.mixer.update(seconds);
        marker.visible = overlay.tick(seconds) && !!previewNode;
      }
      if (previewNode) {
        marker.position.copy(targets.get(run.part)); previewNode.localToWorld(marker.position);
      }
    }
  });
  draw();
}
