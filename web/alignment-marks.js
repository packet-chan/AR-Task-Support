import * as THREE from "three";

// Labels sit in the XR reference space, independent of both the panel and the CG.
export function placedMarks(scene) {
  const group = new THREE.Group(), marks = new Map();
  group.name = "Recorded physical landmarks";
  scene.add(group);
  const geometry = new THREE.SphereGeometry(.008,12,8);
  const material = new THREE.MeshBasicMaterial({color:0x59e4ae,depthTest:false,depthWrite:false});
  function create(label) {
    const sphere = new THREE.Mesh(geometry,material);
    sphere.renderOrder = 6;
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#153b32"; ctx.fillRect(0,0,128,64);
    ctx.fillStyle = "#fff"; ctx.font = "bold 38px system-ui"; ctx.textAlign = "center";
    ctx.fillText(label,64,46,118);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({map,depthWrite:false,depthTest:false}));
    tag.scale.set(.042,.021,1); tag.position.set(0,.023,0); tag.renderOrder = 7;
    sphere.add(tag); group.add(sphere);
    return sphere;
  }
  function remove(key,mesh) {
    mesh.children[0].material.map.dispose(); mesh.children[0].material.dispose();
    mesh.removeFromParent(); marks.delete(key);
  }
  function update(run) {
    const active = new Set();
    function place(key,label,p) {
      if (!p) return;
      active.add(key);
      if (!marks.has(key)) marks.set(key,create(label));
      marks.get(key).position.fromArray(p);
    }
    run.plan.groups.forEach((g,gi) => {
      const active = g.id === run.group?.id;
      const points = active ? run.samples : run.record.groups[g.id]?.locations || [];
      points.forEach((p,i) => {
        const number = active ? run.group.indices?.[i] ?? i : i;
        place(g.id+"/"+number,(gi+1)+"-"+(number+1),p);
      });
    });
    for (const [id,p] of Object.entries(run.record.parts)) place(id,"部品",p.first);
    if (!run.group && run.candidate) place("first","候補",run.candidate.first);
    for (const [key,mesh] of marks) if (!active.has(key)) remove(key,mesh);
  }
  return {group,update,close() {
    for (const [key,mesh] of marks) remove(key,mesh);
    geometry.dispose(); material.dispose(); group.removeFromParent();
  }};
}
