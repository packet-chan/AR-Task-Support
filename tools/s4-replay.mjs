import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {GLTFLoader} from "../web/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import {modelMotion} from "../web/model-motion.js";

async function replay(folder) {
  const bytes = await readFile(folder + "/model.glb");
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const bindings = JSON.parse(await readFile(folder + "/bindings.json", "utf8"));
  const duration = new Map(gltf.animations.map(a => [a.name, a.duration]));
  const {mixer, play, nodes} = modelMotion(gltf);
  let finished;
  mixer.addEventListener("finished", event => finished.push(event.action.getClip().name));
  const result = {};
  for (const [id, step] of Object.entries(bindings.steps)) {
    if (step.target_part) assert(nodes.has(bindings.parts[step.target_part].node));
    finished = [];
    play(step.clips);
    const samples = [];
    for (const clip of step.clips) {
      const dt = duration.get(clip);
      assert(dt > 0);
      for (const fraction of [.5, .49, .01]) {
        mixer.update(dt * fraction + (fraction === .01 ? 1e-7 : 0));
        gltf.scene.updateMatrixWorld(true);
        const pose = {};
        for (const [name, node] of nodes) {
          assert(node.matrixWorld.elements.every(Number.isFinite));
          pose[name] = node.matrixWorld.elements.map(x => Math.round(x * 1e6));
        }
        samples.push(pose);
      }
    }
    assert.deepEqual(finished, step.clips, id + " clip order");
    result[id] = {samples, order: [...finished]};
  }
  return result;
}
const before = await replay(process.argv[2]), after = await replay(process.argv[3]);
const results = Object.entries(before).map(([step, a]) => {
  const b = after[step];
  const changed = new Set();
  for (let i = 0; i < Math.min(a.samples.length, b.samples.length); i++) {
    for (const k of Object.keys(a.samples[i])) {
      if (JSON.stringify(a.samples[i][k]) !== JSON.stringify(b.samples[i][k])) changed.add(k);
    }
  }
  return {step, before: a.order, after: b.order, changedSampledNodes: [...changed]};
});
console.log(JSON.stringify({steps: results.length, playback: results}));