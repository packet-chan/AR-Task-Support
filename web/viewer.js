import * as THREE from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";

export async function loadViewer(url) {
  const viewport = document.getElementById("viewport");
  const panel = document.getElementById("panel");
  const leader = document.getElementById("leader");
  const gltf = await new GLTFLoader().loadAsync(url);
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0x6d7265, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(3, 5, 4);
  scene.add(light);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const span = bounds.getSize(new THREE.Vector3()).length() || 1;
  const camera = new THREE.PerspectiveCamera(38, 1, span / 1000, span * 50);
  camera.position.copy(center).addScaledVector(new THREE.Vector3(.65, .45, 1).normalize(), span * 1.65);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.update();

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
  const nodes = new Map();
  gltf.scene.traverse(node => {
    const index = gltf.parser.associations.get(node)?.nodes;
    if (index !== undefined) nodes.set(gltf.parser.json.nodes[index].name, node);
  });
  let target, queue = [], sequence = [], action, highlight;
  const point = new THREE.Vector3();
  function advance() {
    if (!queue.length) return;
    action?.stop();
    action = mixer.clipAction(clips.get(queue.shift()));
    action.reset().setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }
  mixer.addEventListener("finished", advance);
  function replay() {
    mixer.stopAllAction();
    action = null;
    queue = [...sequence];
    advance();
  }

  function select(part, orderedClips) {
    if (highlight) {
      scene.remove(highlight);
      highlight.dispose();
      highlight = null;
    }
    target = part ? nodes.get(part.node) : null;
    panel.hidden = !target;
    leader.toggleAttribute("hidden", !target);
    if (target) {
      panel.textContent = part.name;
      highlight = new THREE.BoxHelper(target, 0x168153);
      scene.add(highlight);
    }
    sequence = orderedClips;
    replay();
  }

  const observer = new ResizeObserver(() => {
    const {clientWidth: w, clientHeight: h} = viewport;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.zoom = Math.min(1, w / h);
    camera.updateProjectionMatrix();
  });
  observer.observe(viewport);
  let lastTime = performance.now();
  const line = leader.querySelector("line"), dot = leader.querySelector("circle");
  renderer.setAnimationLoop(time => {
    mixer.update(Math.min(.1, (time - lastTime) / 1000));
    lastTime = time;
    if (target) {
      highlight.update();
      bounds.setFromObject(target).getCenter(point).project(camera);
      const w = viewport.clientWidth, h = viewport.clientHeight;
      const x = (point.x + 1) * w / 2, y = (1 - point.y) * h / 2;
      const left = THREE.MathUtils.clamp(x + (x < w / 2 ? 40 : -panel.offsetWidth - 40), 4, w - panel.offsetWidth - 4);
      const top = THREE.MathUtils.clamp(y - 45, 4, h - panel.offsetHeight - 4);
      panel.style.transform = "translate(" + left + "px," + top + "px)";
      line.setAttribute("x1", left + panel.offsetWidth / 2);
      line.setAttribute("y1", top + panel.offsetHeight / 2);
      line.setAttribute("x2", x); line.setAttribute("y2", y);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    }
    renderer.render(scene, camera);
  });
  return {select, replay};
}
