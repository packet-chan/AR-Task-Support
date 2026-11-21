// Publish a reviewed set of model-space targets beside a verified S4 revision.
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {readFile, writeFile, rename, mkdir} from "node:fs/promises";
import path from "node:path";
import {Box3, Vector3} from "../web/node_modules/three/build/three.module.js";
import {GLTFLoader} from "../web/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import {modelMotion} from "../web/model-motion.js";
import {fitSimilarity} from "../web/alignment-fit.js";

const [root, round, revision, recipe] = process.argv.slice(2);
assert(root && recipe && [round,revision].every(id => /^[a-f0-9]{16}$/.test(id)), "device-folder round-id revision-id recipe.json");
const folder = path.join(root,"S4",round,"revisions",revision);
const read = file => readFile(file, "utf8").then(JSON.parse);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const spec = await read(recipe), verify = await read(path.join(folder,"verification.json"));
const guideBytes = await readFile(path.join(root,"S1/task_step.json")), guide = JSON.parse(guideBytes);
const boundBytes = await readFile(path.join(folder,"S2/bindings.json")), bindings = JSON.parse(boundBytes);
const bytes = await readFile(path.join(folder,"S2/model.glb"));
assert(spec.model === guide.model && verify.round.startsWith(round) && verify.review.startsWith(revision));
assert.equal(hash(bytes), verify.sha256["model.glb"]);
assert.equal(hash(boundBytes), verify.sha256["bindings.json"]);
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength),"");
const {nodes} = modelMotion(gltf);
gltf.scene.updateMatrixWorld(true);
function point(nodeName, uvw) {
  const node = nodes.get(nodeName);
  assert(node && uvw.length === 3 && uvw.every(v => Number.isFinite(v) && v >= 0 && v <= 1), nodeName);
  let box;
  if (node.geometry) {
    node.geometry.computeBoundingBox();
    box = node.geometry.boundingBox;
  } else {
    box = new Box3().setFromObject(node,true);
  }
  assert(!box.isEmpty(), nodeName);
  const p = box.getSize(new Vector3()).multiply(new Vector3(...uvw)).add(box.min);
  if (node.geometry) node.localToWorld(p);
  return p.toArray().map(x => Number(x.toFixed(7)));
}
const groups = spec.groups.map(g => {
  function expand([node,uvw,label]) { return {node,label,position:point(node,uvw)}; }
  const fit = g.fit.map(expand), check = g.check.map(expand);
  const positions = fit.map(p => p.position);
  if (g.diagram) {
    assert(guide.parts_figures.includes(g.diagram.file));
    assert.equal(g.diagram.points.length,fit.length+check.length);
    assert(g.diagram.points.every(p => p === null || (Array.isArray(p) && p.length === 2 &&
      p.every(v => Number.isFinite(v) && v >= 0 && v <= 1))));
  }
  assert(g.surfaces.length && g.surfaces.every(name => nodes.get(name)?.geometry));
  assert(fitSimilarity(positions,positions) && check.length && g.fitLimit > 0 && g.checkLimit > 0);
  assert.equal(new Set([...fit,...check].map(p => p.position.join())).size,fit.length+check.length);
  return {...g,fit,check};
});
assert.equal(groups[0].id,"body");
const quick = groups[0].quickFit;
assert(Array.isArray(quick) && quick.length === 3 && new Set(quick).size === 3);
assert(quick.every(i => Number.isInteger(i) && groups[0].fit[i]));
const coarse = quick.map(i => groups[0].fit[i].position);
assert(fitSimilarity(coarse,coarse),"Quick registration requires three non-collinear landmarks");
assert(!groups[0].node && groups.slice(1).every(g => nodes.has(g.node)));
assert.equal(new Set(groups.map(g => g.id)).size,groups.length);
assert.deepEqual(Object.keys(bindings.parts).sort(),Object.keys(spec.targets).sort());
const targets = {};
for (const [id,[node,label,uvw = [.5,.5,.5]]] of Object.entries(spec.targets)) {
  const target = nodes.get(bindings.parts[id].node);
  let group = groups[0];
  for (let n = target; n; n = n.parent) {
    const local = groups.slice(1).find(g => nodes.get(g.node) === n);
    if (local) { group = local; break; }
  }
  targets[id] = {node:bindings.parts[id].node,label,group:group.id,position:point(node,uvw)};
}
for (const [step,id] of Object.entries(spec.stepTargets)) assert(bindings.steps[step] && targets[id]);
assert(spec.movable.every(id => targets[id]));
const accessoryRoots = spec.accessoryRoots || [];
assert(accessoryRoots.every(id => targets[id]) && new Set(accessoryRoots).size === accessoryRoots.length);
const rules = new URL("../generation/s4-alignment.md",import.meta.url);
const translated = await read(new URL("../generation/capture-manual-ja.json",import.meta.url));
const japanese = {};
for (const task of guide.tasks) for (const entry of [{text:task.title},...task.steps,...(task.precautions || [])]) {
  if (translated[entry.text.en]) japanese[entry.text.en] = translated[entry.text.en];
}
const plan = {protocol:"s4-alignment-1",promptSha256:hash(await readFile(rules)),round,revision,model:guide.model,pdf:guide.pdf_id,
  sha256:{...verify.sha256,"task_step.json":hash(guideBytes)},reference:spec.reference,groups,targets,
  partLimit:spec.partLimit,movable:spec.movable,accessoryRoots,japanese,stepTargets:spec.stepTargets,stepHints:spec.stepHints};
plan.id = hash(JSON.stringify(plan));
const destination = path.join(root,"S4");
await mkdir(path.join(destination,"alignment-plans"),{recursive:true});
const output = JSON.stringify(plan,null,2)+"\n";
async function publish(file, data) {
  const tmp = file+"."+randomUUID()+".tmp";
  await writeFile(tmp,data);
  await rename(tmp,file);
}
await publish(path.join(destination,"alignment-plans",plan.id+".json"),output);
await publish(path.join(destination,"alignment.json"),output);
console.log(JSON.stringify({profile:plan.id,groups:groups.length,parts:Object.keys(targets).length}));
