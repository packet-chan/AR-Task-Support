import * as THREE from "./node_modules/three/build/three.module.js";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {modelMotion} from "./model-motion.js";
import {t} from "./language.js";

// Monochrome 24-unit paths also work on headsets without a symbol font.
const paths = {
  question: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8",
  lock: "M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3",
  unlock: "M12 11V6a4.5 4.5 0 0 1 9 0 M3 11h14v10H3z M10 15v2",
  photo: "M2 7h5l2-3h6l2 3h5v13H2z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  video: "M2 6h13v12H2z M15 10l7-4v12l-7-4",
  record: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z",
  shutter: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  stop: "M5 5h14v14H5z",
  book: "M12 6Q7 3 2 5v14q5-2 10 1 5-3 10-1V5q-5-2-10 1z M12 6v14",
  skip: "M4 5l12 7-12 7z M20 5v14",
  next: "M9 4l8 8-8 8",
  prev: "M15 4l-8 8 8 8",
  back: "M10 4l-8 7 8 7 M3 11h10q8 0 8 9",
  exit: "M10 3H3v18h7 M8 12h14m-6-6 6 6-6 6",
  retry: "M20 10a8 8 0 1 0 0 6 M20 3v7h-7",
  check: "M3 12l6 6L21 5",
  warning: "M12 2L1 21h22z M12 9v5 M12 17v.5",
  more: "M4 6h16 M4 12h16 M4 18h16",
};
const icons = Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, new Path2D(path)]));
const ink = "#f4f7fb", panel = "#202b36", surface = "#354553", active = "#b4def5", red = "#ff7268";
const corners = [[-1,1],[1,1],[-1,-1],[1,-1]];

function captureSurface(canvas) {
  canvas.width = 960;
  canvas.height = 576;
  const ctx = canvas.getContext("2d");
  const buttons = [];
  function box(x, y, w, h, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  }
  function icon(id, x, y, size, color) {
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = 1.8;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = color;
    if (id === "stop") ctx.fill(icons[id]);
    else {
      ctx.stroke(icons[id]);
      if (id === "record") {
        ctx.beginPath(); ctx.arc(12, 12, 6.8, 0, 2 * Math.PI); ctx.fill();
      }
    }
    ctx.restore();
  }
  function label(str, x, y, size, color, width, weight = 500) {
    ctx.fillStyle = color;
    ctx.font = weight + " " + size + "px system-ui, sans-serif";
    ctx.fillText(str, x, y, width);
  }
  function wrap(text, width) {
    const lines = [];
    let line = "";
    for (const token of text.match(/\n|[^\S\n]+|[A-Za-z0-9'-]+|./gu) || []) {
      if (token === "\n") { lines.push(line.trimEnd()); line = ""; continue; }
      if (line && ctx.measureText(line + token).width > width) { lines.push(line.trimEnd()); line = ""; }
      if (line || token.trim()) line += token;
    }
    if (line) lines.push(line.trimEnd());
    return lines;
  }
  function image(media, x, y, w, h, point) {
    const iw = media?.videoWidth || media?.naturalWidth, ih = media?.videoHeight || media?.naturalHeight;
    if (!iw || !ih || (media.readyState != null && media.readyState < 2)) return;
    const scale = Math.min(w / iw, h / ih);
    const left = x + (w - iw * scale) / 2, top = y + (h - ih * scale) / 2;
    ctx.drawImage(media, left, top, iw * scale, ih * scale);
    if (point) {
      ctx.beginPath();
      ctx.arc(left + point[0] * iw * scale, top + point[1] * ih * scale, 11, 0, Math.PI * 2);
      ctx.lineWidth = 5; ctx.strokeStyle = "#ff693f"; ctx.stroke();
    }
  }
  function draw(view, figure, locked, focus, dragging, usingHands) {
    buttons.length = 0;
    ctx.clearRect(0, 0, 960, 576);
    box(0, 0, 960, 576, 32, panel);
    function control(action, x, y, w, h, primary = false) {
      const [name, run, id] = action;
      buttons.push({id, name, run, x, y, w, h});
      const hot = id === focus;
      box(x, y, w, h, Math.min(26, h / 2), hot ? ink : primary ? active : surface);
      const color = hot || primary ? panel : ink;
      icon(id, x + w / 2, y + h / 2, Math.min(64, h * .51), id === "record" ? "#ba302d" : color);
      if (id === "book" && view.guide?.precautions.length)
        icon("warning", x + w / 2 + 38, y + 20, 26, hot ? panel : "#ffce79");
    }
    if (view.drawContent) {
      view.drawContent({ctx,buttons,box,icon,label,wrap,focus,usingHands,image,figure});
    } else if (view.preview) {
      box(18, 18, 666, 438, 19, "#0d141b");
      image(view.preview, 24, 24, 654, 426);
      if (view.recording) {
        icon("record", 760, 52, 28, red);
        label(view.timer, 790, 65, 37, ink, 120, 650);
      }
      const [primary, ...secondary] = view.actions;
      control(primary, 710, 95, 224, 175, true);
      secondary.forEach((action, i) => control(action, 710 + i * 116, 302, 108, 102));
    } else {
      label(t(view.title), 32, 65, 43, ink, view.progress ? 690 : 895, 650);
      if (view.progress) {
        ctx.textAlign = "right";
        label(view.progress, 926, 63, 34, active, 182);
        ctx.textAlign = "left";
      }
      const width = figure ? 565 : 892;
      let size = 38, lines;
      do {
        ctx.font = "500 " + size + "px system-ui, sans-serif";
        lines = wrap(t(view.message), width);
        if (lines.length * (size + 7) <= 205 || size <= 20) break;
        size -= 2;
      } while (true);
      lines.forEach((line, i) => label(line, 32, 122 + i * (size + 7), size, ink, width));
      if (figure) image(figure, 622, 90, 304, 198, view.figure?.point);
      if (view.caption) label(view.caption, 32, 328, 25, "#c6d6e2", 895);
      const n = view.actions.length, widthPerAction = (896 - (n - 1) * 16) / Math.max(n, 1);
      view.actions.forEach((action, i) => control(action, 32 + i * (widthPerAction + 16), 353, widthPerAction, 101, i === 0));
    }
    // The grip is a separate target from the shutter, even when the panel is compact.
    const lock = locked ? "lock" : "unlock";
    control([locked ? "追従を再開" : "この場所に固定", null, lock], 18, 470, 108, 90);
    const grip = {id: "grip", name: usingHands ? "つまんで移動" : "押したまま移動", x: 308, y: 470, w: 344, h: 90};
    buttons.push(grip);
    box(377, 536, 206, 13, 7, dragging || focus === "grip" ? ink : "#9aaab8");
    corners.forEach((corner,i) => {
      const [sx,sy] = corner;
      const id = "size-"+i, x = sx<0 ? 11 : 949, y = sy>0 ? 11 : 565;
      buttons.unshift({id,corner,name:"角をつかんでサイズ変更",x:sx<0 ? 0 : 914,
        y:sy>0 ? 0 : 530,w:46,h:46});
      ctx.beginPath(); ctx.moveTo(x-sx*24,y); ctx.lineTo(x,y); ctx.lineTo(x,y+sy*24);
      ctx.lineWidth = focus === id ? 7 : 4; ctx.strokeStyle = focus === id ? ink : active; ctx.stroke();
    });
    const hint = buttons.find(b => b.id === focus)?.name;
    if (hint) {
      ctx.textAlign = "center";
      label(t(hint), 480, 513, 31, ink, 655);
      ctx.textAlign = "left";
    } else label(t("四隅でサイズ変更"),665,515,23,active,246);
  }
  return {buttons, draw};
}

const home = new THREE.Vector3(.36, -.18, -.78);
const handHome = new THREE.Vector3(.21, -.14, -.43);
const up = new THREE.Vector3(0, 1, 0);
const preference = "mr-capture-panel-offset";

// All offsets are metres in the viewer's horizontal frame. Looking down at the
// workpiece must not pull the panel between the eyes and the workpiece.
function panelPlacement(board, screen, key = preference) {
  const eye = new THREE.Vector3(), forward = new THREE.Vector3(), yaw = new THREE.Quaternion();
  const heading = new THREE.Quaternion();
  const offset = home.clone(), target = new THREE.Vector3(), delta = new THREE.Vector3();
  const localGrab = new THREE.Vector3(), arm = new THREE.Vector3();
  let placed = false, locked = false, custom = false, drag = null, distance = 0;
  let baseWidth = .52, factor = 1;
  const sizeKey = key+"-size", limit = n => THREE.MathUtils.clamp(n,.65,2);
  try {
    const value = Number(localStorage.getItem(sizeKey));
    if (value>0 && Number.isFinite(value)) factor = limit(value);
  } catch {}
  function setBase(width) {
    baseWidth = width;
    if (!drag?.corner) screen.scale.setScalar(baseWidth*factor);
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite) &&
        Math.hypot(...saved) >= .37 && Math.hypot(...saved) <= 4) {
      offset.fromArray(saved);
      custom = true;
    }
  } catch { /* A session can run with storage disabled. */ }

  function step(pose, seconds, hands = false, touching = false) {
    eye.copy(pose.position);
    forward.set(0, 0, -1).applyQuaternion(pose.orientation);
    if (Math.hypot(forward.x, forward.z) > .1)
      yaw.setFromAxisAngle(up, Math.atan2(-forward.x, -forward.z));
    if (locked || drag || (placed && touching)) return;
    // A glance at the side panel should not push it farther out of sight.
    if (!placed || heading.angleTo(yaw) > THREE.MathUtils.degToRad(36)) heading.copy(yaw);
    target.copy(custom ? offset : hands ? handHome : home).applyQuaternion(heading).add(eye);
    delta.subVectors(target, board.position);
    const length = delta.length();
    if (!placed) board.position.copy(target);
    else if (length > .035) {
      const blend = 1 - Math.pow(.5, seconds / .20);
      board.position.addScaledVector(delta, blend * (length - .035) / length);
    }
    board.lookAt(eye);
    placed = true;
  }
  function toggle() {
    if (drag || !placed) return;
    if (locked) {
      custom = true;
      heading.copy(yaw);
      offset.subVectors(board.position, eye).applyQuaternion(yaw.clone().invert());
    }
    locked = !locked;
  }
  function recall() {
    if (drag) return;
    offset.copy(home);
    placed = locked = custom = false;
    factor = 1; setBase(baseWidth);
    try { localStorage.removeItem(key); localStorage.removeItem(sizeKey); } catch {}
  }
  function begin(controller, gesture, hit, corner) {
    if (drag || !placed || !hit) return;
    drag = {controller, gesture, corner, wasLocked:locked};
    if (corner) {
      const axis = new THREE.Vector3(corner[0],corner[1]*.6,0).applyQuaternion(board.quaternion);
      Object.assign(drag,{axis,start:hit.point.clone(),center:board.position.clone(),width:screen.scale.x,
        plane:new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0,0,1).applyQuaternion(board.quaternion),hit.point)});
    }
    distance = hit.distance;
    localGrab.copy(hit.point).sub(board.position).applyQuaternion(board.quaternion.clone().invert());
    locked = true;
  }
  function move(ray) {
    if (!drag) return;
    if (drag.corner) {
      if (ray.intersectPlane(drag.plane,target)) moveTo(target);
      return;
    }
    moveTo(ray.at(distance, target));
  }
  function moveTo(point) {
    if (drag?.corner) {
      const {axis,start,center,width} = drag;
      const increase = delta.subVectors(point,start).dot(axis)/axis.lengthSq();
      const next = baseWidth*limit((width+increase)/baseWidth);
      screen.scale.setScalar(next);
      board.position.copy(center).addScaledVector(axis,(next-width)/2);
      return;
    }
    arm.copy(localGrab).applyQuaternion(board.quaternion);
    board.position.copy(point).sub(arm);
    delta.subVectors(board.position, eye);
    if (delta.length() < .38) board.position.copy(eye).addScaledVector(delta.normalize(), .38);
    board.lookAt(eye);
  }
  function end(controller, gesture) {
    if (drag?.controller !== controller || (gesture && drag.gesture !== gesture)) return;
    if (drag.corner) {
      locked = drag.wasLocked;
      if (!gesture) { board.position.copy(drag.center); screen.scale.setScalar(drag.width); }
      factor = limit(screen.scale.x/baseWidth);
      if (gesture) { try { localStorage.setItem(sizeKey,String(factor)); } catch {} }
    }
    drag = null;
    if (gesture) {
      custom = true;
      // Persist a deliberate drop relative to the working direction, never an XR world coordinate.
      const basis = heading.angleTo(yaw) <= THREE.MathUtils.degToRad(36) ? heading : yaw;
      offset.subVectors(board.position, eye).applyQuaternion(basis.clone().invert());
      try { localStorage.setItem(key, JSON.stringify(offset.toArray())); } catch {}
    }
  }
  return {step, toggle, recall, begin, move, moveTo, end, setBase, get locked() { return locked; }, get drag() { return drag; }};
}

// Draw the controls inside the XR scene so the headset does not need DOM Overlay.
export async function openPanel(session, onHandContact = () => {}, workspace = null) {
  const renderer = new THREE.WebGLRenderer({alpha: true, antialias: true});
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local");
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const canvas = document.createElement("canvas");
  const surface = captureSurface(canvas);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({map: texture, alphaTest: .5, toneMapped: false});
  const board = new THREE.Group();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, canvas.height / canvas.width), material);
  board.add(screen);
  scene.add(board);
  screen.name = "MR panel";
  const placement = panelPlacement(board, screen, workspace?.placementKey);
  const stand = new THREE.Group();
  board.add(stand);
  stand.position.set(0, .245, 0);
  stand.rotation.set(.15, -.4, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x67716a, 2.7));
  const lamp = new THREE.DirectionalLight(0xffffff, 2);
  lamp.position.set(2, 4, 3);
  scene.add(lamp);
  let gltf, motion, outline, selected, modelUrl, figureUrl, figure, previousTime = 0;
  function disposeModel(model) {
    model?.scene.traverse(node => {
      node.geometry?.dispose();
      for (const mat of [].concat(node.material || [])) mat.dispose();
    });
  }
  // The generic-hand GLBs have 25 sibling bones in WebXR reference-space coordinates.
  // Share each side's mesh across controller/hand switches in this session.
  const handModels = new Map();
  function handModel(side) {
    if (side !== "left" && side !== "right") return null;
    if (handModels.has(side)) return handModels.get(side);
    const model = {};
    handModels.set(side, model);
    new GLTFLoader().load("/hands/" + side + ".glb", loaded => {
      if (ended) { disposeModel(loaded); return; }
      const mesh = loaded.scene.getObjectByProperty("type", "SkinnedMesh");
      mesh.frustumCulled = false;
      // Depth-only skin leaves the XR layer clear for the actual passthrough hand.
      // Grow the surface, not the tracked skeleton or fingertip measurement.
      const positions = mesh.geometry.attributes.position, normals = mesh.geometry.attributes.normal;
      const margin = .002;
      for (let i = 0; i < positions.count; i++) {
        positions.setXYZ(i,positions.getX(i)+margin*normals.getX(i),
          positions.getY(i)+margin*normals.getY(i),positions.getZ(i)+margin*normals.getZ(i));
      }
      positions.needsUpdate = true;
      mesh.material.dispose();
      mesh.material = new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true});
      mesh.renderOrder = -100;
      model.bones = mesh.skeleton.bones;
      for (const bone of model.bones) bone.matrixAutoUpdate = false;
      model.matrices = new Float32Array(model.bones.length * 16);
      model.asset = loaded;
      loaded.scene.visible = false;
      scene.add(loaded.scene);
    }, undefined, () => {
      handModels.delete(side); // Retry on the next connection, while touch input stays available.
    });
    return model;
  }
  function poseHand(model, hand, frame, space) {
    if (!model?.asset) return;
    const root = model.asset.scene;
    if (model.source !== hand) {
      model.source = hand;
      model.spaces = model.bones.map(bone => hand.get(bone.name));
    }
    root.visible = !!frame?.fillPoses && frame.fillPoses(model.spaces, space, model.matrices);
    if (!root.visible) return;
    model.bones.forEach((bone, i) => {
      bone.matrix.fromArray(model.matrices, i * 16);
      bone.matrixWorldNeedsUpdate = true;
    });
  }
  function selectGuide() {
    outline?.dispose();
    outline?.removeFromParent();
    outline = null;
    if (!motion || !view.guide) return;
    const node = motion.nodes.get(view.guide.node);
    if (node) {
      outline = new THREE.BoxHelper(node, 0xffc540);
      outline.material.depthTest = true;
      outline.renderOrder = 2;
      scene.add(outline);
    }
    motion.play(view.guide.clips);
  }
  async function loadModel(url) {
    modelUrl = url;
    try {
      const loaded = await new GLTFLoader().loadAsync(url);
      if (ended || modelUrl !== url) { disposeModel(loaded); return; }
      gltf = loaded;
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const size = bounds.getSize(new THREE.Vector3());
      const holder = new THREE.Group();
      holder.add(gltf.scene);
      holder.position.copy(bounds.getCenter(new THREE.Vector3())).negate();
      stand.scale.setScalar(.16 / (Math.max(size.x, size.y, size.z) || 1));
      stand.add(holder);
      motion = modelMotion(gltf);
      selectGuide();
    } catch { /* The manual and camera remain usable without the provisional model. */ }
  }
  const ray = new THREE.Raycaster(), controllers = [];
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  const rayMaterial = new THREE.LineBasicMaterial({color: 0xb4def5});
  const cursorGeometry = new THREE.RingGeometry(.68, 1, 24);
  const cursorMaterial = new THREE.MeshBasicMaterial({color: 0xd5efff, depthWrite: false, toneMapped: false});
  const cursorEdge = new THREE.MeshBasicMaterial({color: 0x203849, depthWrite: false, toneMapped: false});
  let ended = false, focus, view, lastPreview = 0;

  function buttonAt(x, y) {
    return surface.buttons.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  }
  function aim(controller) {
    controller.updateWorldMatrix(true, false);
    ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    ray.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    return ray.ray;
  }
  function hit(controller) {
    aim(controller);
    screen.updateWorldMatrix(true, false);
    const point = ray.intersectObject(screen, false)[0];
    controller.userData.beam.scale.z = point?.distance || .12;
    if (!point) return {};
    const x = point.uv.x * canvas.width, y = (1 - point.uv.y) * canvas.height;
    return {point, button: buttonAt(x, y)};
  }
  function draw() {
    if (!view || ended) return;
    surface.draw(view, figure, placement.locked, focus, !!placement.drag, touches.some(touch => touch.hand));
    texture.needsUpdate = true;
  }
  function activate(button) {
    for (const controller of controllers) controller.userData.touch.armed = null;
    if (button.id === "lock" || button.id === "unlock") { placement.toggle(); draw(); }
    else button.run();
  }
  const touches = [];
  function resizePanel() {
    const hands = touches.some(touch => touch.hand);
    let width = hands ? .36 : .52;
    if (view?.alignmentSize === "reading") width = hands ? .56 : .78;
    else if (view?.alignmentSize === "work") width = hands ? .44 : .60;
    else if (view?.preview) width = hands ? .26 : .32;
    else if (view?.compact) width = hands ? .32 : .42;
    placement.setBase(width);
  }
  // Read two WebXR joints in the same reference space as the panel. Only an
  // approach from its front can press a control; a held fingertip cannot repeat.
  function trackHand(controller) {
    const cursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
    const inner = new THREE.Mesh(cursorGeometry, cursorEdge);
    inner.scale.setScalar(.70);
    inner.renderOrder = 5;
    cursor.add(inner);
    cursor.visible = false;
    cursor.renderOrder = 4;
    screen.add(cursor);
    const pulse = new THREE.Mesh(cursorGeometry, new THREE.MeshBasicMaterial({
      color: 0x44aee0, transparent: true, depthWrite: false, toneMapped: false
    }));
    pulse.visible = false;
    screen.add(pulse);
    const local = new THREE.Vector3(), tip = new THREE.Vector3(), thumb = new THREE.Vector3();
    let pinchReady = false, pressedAt = 0;
    const touch = {hand: null, model: null, near: false, valid: false, armed: null, update, reset,
      dispose: () => pulse.material.dispose()};
    function confirm() {
      pulse.position.set(local.x, local.y, .0015 / screen.scale.x);
      pulse.scale.setScalar(.008 / screen.scale.x);
      pulse.material.opacity = 1;
      pulse.visible = true;
      pressedAt = performance.now();
      onHandContact();
    }
    function reset() {
      cursor.visible = touch.near = touch.valid = pinchReady = false;
      pulse.visible = false;
      if (touch.model?.asset) touch.model.asset.scene.visible = false;
      touch.armed = null;
      if (placement.drag?.controller === controller) placement.end(controller);
    }
    function update(frame, space) {
      if (!touch.hand) return;
      if (pulse.visible) {
        const progress = Math.min(1, (performance.now() - pressedAt) / 160);
        pulse.scale.setScalar((.008 + .017 * progress) / screen.scale.x);
        pulse.material.opacity = 1 - progress;
        pulse.visible = progress < 1;
      }
      const indexPose = frame?.getJointPose(touch.hand.get("index-finger-tip"), space);
      const thumbPose = frame?.getJointPose(touch.hand.get("thumb-tip"), space);
      if (!indexPose || !thumbPose) { reset(); return; }
      poseHand(touch.model, touch.hand, frame, space);
      touch.valid = true;
      tip.copy(indexPose.transform.position);
      thumb.copy(thumbPose.transform.position);
      const gap = tip.distanceTo(thumb);
      if (placement.drag?.controller === controller && placement.drag.gesture === "pinch") {
        if (gap >= .033) placement.end(controller, "pinch");
        else placement.moveTo(tip);
        touch.near = true;
        cursor.visible = false;
        touch.armed = null;
        return placement.drag?.corner ? "size-"+corners.indexOf(placement.drag.corner) : "grip";
      }
      screen.worldToLocal(local.copy(tip));
      const scale = screen.scale.x, z = local.z * scale;
      touch.near = z >= -.065 && z < .10 &&
        (Math.abs(local.x) - .5) * scale < .025 && (Math.abs(local.y) - .3) * scale < .025;
      const button = touch.near && buttonAt((local.x + .5) * canvas.width, (.5 - local.y / .6) * canvas.height);
      cursor.visible = !!button && z >= -(indexPose.radius || .008) && !placement.drag;
      if (cursor.visible) {
        cursor.position.set(local.x, local.y, .001 / scale);
        cursor.scale.setScalar((z > .022 ? .006 : .004) / scale);
      }
      const freshPinch = pinchReady && gap <= .022;
      if (gap >= .033) pinchReady = true;
      if (gap <= .022) pinchReady = false;
      if (!button || placement.drag) { touch.armed = null; return; }
      if (button.id === "grip" || button.corner) {
        touch.armed = null;
        if (freshPinch && z >= -.025 && z <= .035) {
          placement.begin(controller, "pinch", {point: tip, distance: 0},button.corner);
          if (placement.drag?.controller === controller) confirm();
        }
      } else if (z >= .028) {
        touch.armed = button.id;
      } else if (z <= Math.min(.012, indexPose.radius || .008)) {
        const press = touch.armed === button.id && z >= -.035 && gap > .022;
        touch.armed = null;
        if (press) { confirm(); activate(button); }
      } else if (touch.armed !== button.id) touch.armed = null;
      return button.id;
    }
    return touch;
  }
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    const beam = new THREE.Line(rayGeometry, rayMaterial);
    controller.userData.beam = beam;
    controller.add(beam);
    const touch = controller.userData.touch = trackHand(controller);
    touches.push(touch);
    let pressed;
    const directInput = () => touch.hand && (touch.near || !touch.valid);
    controller.addEventListener("connected", ({data}) => {
      touch.hand = data.hand;
      touch.model = data.hand ? handModel(data.handedness) : null;
      resizePanel();
    });
    controller.addEventListener("selectstart", () => {
      pressed = null;
      if (!controller.visible || placement.drag || directInput() || session.visibilityState === "visible-blurred") return;
      const {button, point} = hit(controller);
      if (button?.id === "grip" || button?.corner) placement.begin(controller, "select", point,button.corner);
      else pressed = button?.id;
      draw();
    });
    controller.addEventListener("select", () => {
      const id = pressed;
      pressed = null;
      if (!id || placement.drag || !controller.visible || directInput()) return;
      const {button} = hit(controller);
      if (button?.id === id) activate(button);
    });
    controller.addEventListener("selectend", () => { placement.end(controller, "select"); draw(); });
    controller.addEventListener("squeezestart", () => {
      pressed = null;
      if (!controller.visible || placement.drag || touch.hand) return;
      const {point,button} = hit(controller);
      if (point) placement.begin(controller, "squeeze", point,button?.corner);
      else if (!workspace?.grab?.(controller,aim(controller))) placement.recall();
      draw();
    });
    controller.addEventListener("squeezeend", () => { workspace?.release?.(controller); placement.end(controller, "squeeze"); draw(); });
    controller.userData.cancelPress = () => { pressed = null; };
    controller.addEventListener("disconnected", () => {
      workspace?.release?.(controller);
      controller.userData.cancelPress();
      touch.reset();
      touch.hand = null;
      touch.model = null;
      beam.visible = true;
      resizePanel();
      draw();
    });
    controllers.push(controller);
    scene.add(controller);
  }
  function resetInputs() {
    for (const {userData} of controllers) {
      userData.cancelPress();
      userData.touch.reset();
    }
    focus = null;
    draw();
  }
  session.addEventListener("visibilitychange", resetInputs);
  function close() {
    if (ended) return;
    ended = true;
    workspace?.close();
    session.removeEventListener("visibilitychange", resetInputs);
    motion?.mixer.stopAllAction();
    outline?.dispose();
    disposeModel(gltf);
    for (const model of handModels.values()) {
      model.asset?.scene.traverse(node => node.skeleton?.dispose());
      disposeModel(model.asset);
    }
    for (const touch of touches) touch.dispose();
    renderer.setAnimationLoop(null);
    screen.geometry.dispose();
    material.dispose();
    texture.dispose();
    rayGeometry.dispose();
    rayMaterial.dispose();
    cursorGeometry.dispose();
    cursorMaterial.dispose();
    cursorEdge.dispose();
    renderer.dispose();
  }
  // Three must release its session before its WebGL renderer is disposed.
  session.addEventListener("end", () => queueMicrotask(close), {once: true});
  try {
    workspace?.mount(scene, screen, placement);
    // Install the loop before sessionstart so Three stops its window RAF when
    // WebXR takes over. Window frames have no joint poses and cancel touches.
    renderer.setAnimationLoop((time, frame) => {
      const pose = frame?.getViewerPose(renderer.xr.getReferenceSpace());
      const interactive = !!pose && (!session.visibilityState || session.visibilityState === "visible");
      if (pose) placement.step(pose.transform, Math.min(.1, (time - previousTime) / 1000),
        touches.some(touch => touch.hand), touches.some(touch => touch.near));
      const hand = placement.drag?.controller;
      if (hand && placement.drag.gesture !== "pinch") {
        if (hand.visible && interactive) placement.move(aim(hand));
        else placement.end(hand);
      }
      let next, directFocus;
      for (const controller of controllers) {
        const {touch, beam, cancelPress} = controller.userData;
        if (!interactive) { touch.reset(); cancelPress(); continue; }
        const target = touch.update(frame, renderer.xr.getReferenceSpace());
        if (target) directFocus = target;
        beam.visible = !touch.hand || (touch.valid && !touch.near);
        if (!beam.visible) { cancelPress(); continue; }
        if (!controller.visible) continue;
        const {button} = hit(controller);
        if (button && (!next || button.id === focus)) next = button.id;
      }
      next = directFocus || next;
      if (next !== focus || (view?.preview && time - lastPreview >= 80)) {
        focus = next;
        lastPreview = time;
        draw();
      }
      if (stand.visible) {
        stand.position.y = screen.scale.x*.3+.09;
        motion?.mixer.update(Math.min(.1, (time - previousTime) / 1000));
        stand.updateWorldMatrix(true, true);
        outline?.update();
      }
      workspace?.frame(interactive ? frame : null, renderer.xr.getReferenceSpace(), Math.min(.1, (time - previousTime) / 1000));
      previousTime = time;
      renderer.render(scene, camera);
    });
    await renderer.xr.setSession(session);
    if (ended) throw new Error("Session ended");
    workspace?.ready(renderer.xr.getReferenceSpace());
  } catch (error) {
    await session.end().catch(() => {});
    close();
    throw error;
  }
  return state => {
    view = state;
    resizePanel();
    stand.visible = !!view.guide;
    if (view.modelUrl && view.modelUrl !== modelUrl) loadModel(view.modelUrl);
    if (selected !== view.guide) { selected = view.guide; selectGuide(); }
    const url = view.figure?.url;
    if (url !== figureUrl) {
      figureUrl = url;
      figure = null;
      if (url) {
        const img = new Image();
        img.onload = () => { if (!ended && figureUrl === url) { figure = img; draw(); } };
        img.onerror = () => { if (!ended && figureUrl === url) { figure = false; draw(); } };
        img.src = url;
      }
    }
    draw();
  };
}
