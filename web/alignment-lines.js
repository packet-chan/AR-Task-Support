import * as THREE from "three";
import {LineSegments2} from "three/addons/lines/LineSegments2.js";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";

// Keep glTF transforms live for animation and measurement, rendering only crease edges.
export function alignmentLines(gltf, motion, plan, mini) {
  const accessoryRoots = new Set((plan.accessoryRoots || []).map(id => motion.nodes.get(plan.targets[id].node)));
  for (const node of accessoryRoots) mini.getObjectByName(node.name)?.removeFromParent();
  const housing = new Set(plan.groups[0].surfaces.map(name => motion.nodes.get(name)));
  const moving = new LineMaterial({color:0xbcff46,linewidth:1.8,transparent:true,opacity:.94,depthWrite:false,toneMapped:false});
  const hint = moving.clone(); hint.opacity = .68; hint.linewidth = 1.4;
  const body = moving.clone(); body.opacity = .30; body.linewidth = 1.15;
  const meshes = [];
  gltf.scene.traverse(n => { if (n.isMesh) meshes.push(n); });
  const lines = meshes.map(mesh => {
    // Do not hide the node itself: it may carry other animated nodes.
    mesh.layers.disableAll();
    const edges = new THREE.EdgesGeometry(mesh.geometry,6);
    const line = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(edges),hint);
    edges.dispose();
    line.onBeforeRender = function(renderer,scene,camera) {
      if (camera.viewport) this.material.resolution.set(camera.viewport.z,camera.viewport.w);
      else LineSegments2.prototype.onBeforeRender.call(this,renderer);
    };
    line.visible = false; mesh.add(line);
    const branch = [];
    for (let n=mesh; n; n=n.parent) {
      branch.push(n);
      if (accessoryRoots.has(n)) break;
    }
    return {mesh,line,branch};
  });
  const clips = gltf.animations.map((clip,i) => ({
    clip,roots:new Set(gltf.parser.json.animations[i].channels.map(channel =>
      motion.nodes.get(gltf.parser.json.nodes[channel.target.node].name)))
  }));
  let reveal = 0, remaining = 0, target, inspecting, current, dirty = true;
  function select(node, inspect, revealBody) {
    target = node; inspecting = inspect; remaining = node ? 8 : 0;
    if (revealBody) reveal = 1.1;
    dirty = true;
  }
  function tick(dt) {
    const clip = clips.find(({clip}) => motion.mixer.existingAction(clip)?.isRunning());
    const before = remaining > 0, wasRevealing = reveal > 0;
    remaining = Math.max(0,remaining-dt); reveal = Math.max(0,reveal-dt);
    if (dirty || clip !== current || before !== (remaining>0) || wasRevealing !== (reveal>0)) {
      for (const {mesh,line,branch} of lines) {
        const animated = clip && branch.some(n => clip.roots.has(n));
        const selected = (inspecting || remaining>0) && branch.includes(target);
        line.visible = !!(animated || selected || (reveal>0 && housing.has(mesh)));
        line.material = animated ? moving : selected ? hint : body;
      }
      current = clip; dirty = false;
    }
    return inspecting || remaining>0 || !!(clip && target && clip.roots.has(target));
  }
  return {select,tick,materials:[moving,hint,body]};
}
