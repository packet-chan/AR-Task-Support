import assert from "node:assert/strict";
import {Euler, Matrix4, Quaternion, Vector3} from "../web/node_modules/three/build/three.module.js";
import {fitSimilarity} from "../web/alignment-fit.js";
import {AlignmentRun,transform} from "../web/alignment-run.js";

const source = [[-.14,.40,.14],[.14,.40,.14],[.14,.40,-.16],[-.14,0,.15]];
const independent = [.14,.02,-.11];
for (const angle of [0,.8,Math.PI]) {
  const rotation = new Quaternion().setFromEuler(new Euler(.1,angle,-.23));
  const matrix = new Matrix4().compose(new Vector3(1,1.2,-2),rotation,new Vector3().setScalar(1.15)).toArray();
  for (const points of [source,source.slice(0,3)]) {
    const fitted = fitSimilarity(points,points.map(p => transform(p,matrix)));
    assert(fitted && fitted.rms < 1e-8);
    const expected = new Vector3(...transform(independent,matrix));
    assert(expected.distanceTo(new Vector3(...transform(independent,fitted.matrix))) < 1e-7);
  }
}
const line = [[0,0,0],[1,0,0],[2,0,0]];
assert.equal(fitSimilarity(line,line),null);
assert.equal(fitSimilarity(source,[...source.slice(0,-1),[NaN,1,2]]),null);
assert.equal(fitSimilarity(source,source.map(() => [0,0,0])),null);
console.log("Known rotations, scale, planar and 3D fits, independent points and degenerate input passed.");

const body = {id:"body",fit:source.map(position => ({position})),check:[{position:independent}],fitLimit:.025,checkLimit:.025};
function trial() {
  return new AlignmentRun({groups:[body],targets:{socket:{group:"body",position:source[0]}},
    partLimit:.012,stepTargets:{},movable:[]},[{id:"cable",part:"socket"}],"cable");
}
const skipped = trial();
skipped.recalibrate(0);
for (const point of source.slice(0,3)) skipped.point(point);
skipped.recordLandmark(null);
skipped.point(independent);
assert.equal(skipped.groupResult.verified,true);
assert.equal(skipped.groupResult.locations[3],null);
skipped.retryPart();
skipped.point(source[0]);
assert.equal(skipped.phase,"inspect");
skipped.confirmPart();
assert.equal(skipped.record.parts.socket.method,"single-point");
assert.equal(skipped.record.parts.socket.verified,true);
assert(!("repeat" in skipped.record.parts.socket));

const insufficient = trial();
insufficient.recalibrate(0);
for (const p of source) insufficient.recordLandmark(null);
insufficient.point(independent);
assert.equal(insufficient.phase,"failed");
insufficient.retryPoint(1); insufficient.point(source[1]);
assert.deepEqual(insufficient.samples[1],source[1]);
insufficient.skipGroup();
assert.equal(insufficient.phase,"unavailable");
assert.equal(insufficient.groupResult.matrix,undefined);
console.log("Skipped points, targeted replacement, provisional part approval and continuation without a fit passed.");

const panel = {...body,id:"panel"};
const review = new AlignmentRun({groups:[{...body,quickFit:[0,2,3]},panel],targets:{
  display:{group:"panel",position:source[0]}},partLimit:.012,stepTargets:{},movable:[]},
  [{id:"first",part:"display"},{id:"second",part:"display"}],"first");
for (const i of [0,2,3]) review.point(source[i]);
assert.equal(review.phase,"assist");
assert.equal(review.groupResult.source,"body");
review.moveStep(1);
assert.deepEqual(review.record.parts,{});
assert.deepEqual(Object.keys(review.record.groups),["body"]);
review.retryPart(); review.point(source[0]); review.confirmPart();
assert.equal(review.record.groups.panel.source,"body");
assert.equal(review.record.parts.display.provisional,true);
review.retryPart(); review.enterPart();
assert.equal(review.phase,"assist");
assert.deepEqual(review.record.parts.display.first,source[0]);
console.log("Quick fit, unmeasured STEP browsing, optional panel correction and cancellation passed.");
