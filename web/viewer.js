import * as THREE from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";

function litScene(model) {
  const scene = new THREE.Scene();
  scene.add(model, new THREE.HemisphereLight(0xffffff, 0x6d7265, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(3, 5, 4);
  scene.add(light);
  return scene;
}

export async function showModelThumbnails(pictures) {
  const renderer = new THREE.WebGLRenderer({alpha: true, antialias: true});
  const loader = new GLTFLoader();
  renderer.setSize(480, 360, false);
  try {
    for (const picture of pictures) {
      if (!picture.isConnected) continue;
      let model;
      try {
        ({scene: model} = await loader.loadAsync(picture.dataset.glb));
        if (!picture.isConnected) continue;
        const view = new THREE.Group();
        view.add(model);
        view.rotation.set(.28, -.48, 0);
        const bounds = new THREE.Box3().setFromObject(view, true);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const halfHeight = Math.max(size.y, size.x * .75) * .55 || 1;
        const halfWidth = halfHeight * 4 / 3;
        const depth = Math.max(size.z, halfHeight);
        const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0, depth * 3);
        camera.position.set(center.x, center.y, bounds.max.z + depth);
        renderer.render(litScene(view), camera);
        const still = document.createElement("canvas");
        still.width = 480;
        still.height = 360;
        still.setAttribute("aria-hidden", "true");
        still.getContext("2d").drawImage(renderer.domElement, 0, 0);
        picture.replaceChildren(still);
      } catch (error) {
        console.warn("モデルのサムネイルを表示できません。", error);
      } finally {
        model?.traverse(node => {
          node.geometry?.dispose();
          if (node.material) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach(material => material.dispose());
          }
        });
      }
    }
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

export async function loadViewer(url) {
  const viewport = document.getElementById("viewport");
  const panel = document.getElementById("panel");
  const leader = document.getElementById("leader");
  const gltf = await new GLTFLoader().loadAsync(url);
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewport.prepend(renderer.domElement);
  const scene = litScene(gltf.scene);
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
    leader.toggleAttribute("hidden", !target);
    if (target) {
      highlight = new THREE.BoxHelper(target, 0xa1f0e0);
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
    camera.zoom = 1.22 * Math.min(1, w / h);
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
      const view = viewport.getBoundingClientRect(), area = leader.parentElement.getBoundingClientRect();
      const anchor = panel.getBoundingClientRect();
      const compact = anchor.top >= view.bottom && anchor.left < view.right;
      const x = view.left - area.left + (point.x + 1) * view.width / 2;
      const y = view.top - area.top + (1 - point.y) * view.height / 2;
      leader.toggleAttribute("hidden", Math.abs(point.x) > 1 || Math.abs(point.y) > 1 || Math.abs(point.z) > 1);
      line.setAttribute("x1", anchor.left - area.left + (compact ? anchor.width / 2 : -8));
      line.setAttribute("y1", anchor.top - area.top + (compact ? -2 : anchor.height / 2));
      line.setAttribute("x2", x); line.setAttribute("y2", y);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    }
    renderer.render(scene, camera);
  });
  return {select, replay};
}
