import * as THREE from "three";

export function modelMotion(gltf) {
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
  const nodes = new Map();
  gltf.scene.traverse(node => {
    const index = gltf.parser.associations.get(node)?.nodes;
    if (index !== undefined) nodes.set(gltf.parser.json.nodes[index].name, node);
  });
  let queue = [], action;
  function advance() {
    if (!queue.length) return;
    action?.stop();
    action = mixer.clipAction(clips.get(queue.shift()));
    action.reset().setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
  }
  mixer.addEventListener("finished", advance);
  function play(sequence) {
    mixer.stopAllAction();
    action = null;
    queue = sequence.filter(name => clips.has(name));
    advance();
  }
  return {nodes, play, mixer};
}
