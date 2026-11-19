import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import * as T from "../web/node_modules/three/build/three.module.js";
import {GLTFExporter} from "../web/node_modules/three/examples/jsm/exporters/GLTFExporter.js";

// The texture-free binary exporter only needs the Blob → ArrayBuffer part of FileReader.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend();
  }
};

const {scene} = JSON.parse(await readFile(process.argv[2], "utf8"));
const root = new T.Scene();
const objects = new Map();
const triple = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
function angles(degrees) {
  assert(triple(degrees));
  return new T.Euler(...degrees.map(T.MathUtils.degToRad), "XYZ");
}

function geometry(spec) {
  if (spec.shape === "mesh") {
    const {vertices, indices} = spec;
    assert(Array.isArray(vertices) && vertices.length >= 9 && vertices.length % 3 === 0 && vertices.every(Number.isFinite));
    assert(Array.isArray(indices) && indices.length >= 3 && indices.length % 3 === 0);
    assert(indices.every(i => Number.isInteger(i) && i >= 0 && i < vertices.length / 3));
    const mesh = new T.BufferGeometry();
    mesh.setAttribute("position", new T.Float32BufferAttribute(vertices, 3));
    mesh.setIndex(indices);
    mesh.computeVertexNormals();
    return mesh;
  }
  assert(triple(spec.size) && spec.size.every(n => n > 0));
  let shape;
  switch (spec.shape) {
    case "box": shape = new T.BoxGeometry(); break;
    case "cylinder": shape = new T.CylinderGeometry(.5, .5, 1, 32); break;
    case "sphere": shape = new T.SphereGeometry(.5, 24, 16); break;
    default: throw new Error("Unknown shape");
  }
  return shape.scale(...spec.size);
}

for (const spec of scene.nodes) {
  assert(typeof spec.name === "string" && /^[a-zA-Z0-9_]+$/.test(spec.name) && !objects.has(spec.name));
  const obj = spec.shape ? new T.Mesh(geometry(spec), new T.MeshStandardMaterial({
    color: spec.color ?? "#bdc4bc", roughness: .72
  })) : new T.Group();
  obj.name = spec.name;
  if (spec.position) {
    assert(triple(spec.position));
    obj.position.set(...spec.position);
  }
  if (spec.rotation) obj.rotation.copy(angles(spec.rotation));
  objects.set(spec.name, obj);
}
for (const spec of scene.nodes) {
  const parent = spec.parent ? objects.get(spec.parent) : root;
  assert(parent);
  parent.add(objects.get(spec.name));
}
const reachable = new Set();
root.traverse(obj => reachable.add(obj));
assert([...objects.values()].every(obj => reachable.has(obj)), "Disconnected or cyclic scene");

const animations = scene.animations.map(clip => {
  assert(typeof clip.name === "string" && clip.name && clip.tracks.length);
  const tracks = clip.tracks.map(({node, path, times, values}) => {
    assert(objects.has(node) && ["rotation", "position"].includes(path));
    assert(times.length >= 2 && times[0] === 0 && times.every((v, i) => Number.isFinite(v) && (!i || v > times[i-1])));
    assert(values.length === times.length && values.every(triple));
    if (path === "rotation") {
      const rotations = values.flatMap(v => new T.Quaternion().setFromEuler(angles(v)).toArray());
      return new T.QuaternionKeyframeTrack(node + ".quaternion", times, rotations);
    }
    return new T.VectorKeyframeTrack(node + ".position", times, values.flat());
  });
  return new T.AnimationClip(clip.name, -1, tracks);
});
assert(new Set(animations.map(a => a.name)).size === animations.length);
const glb = await new GLTFExporter().parseAsync(root, {binary: true, animations});
await writeFile(process.argv[3], Buffer.from(glb));
