import {Matrix4, Quaternion, Vector3} from "three";

function spread(points) {
  let a, b, span = 0;
  for (const p of points) for (const q of points) {
    const d = p.distanceToSquared(q);
    if (d > span) { a = p; b = q; span = d; }
  }
  if (!span) return false;
  const axis = b.clone().sub(a);
  return points.some(p => p.clone().sub(a).cross(axis).length() > Math.max(.00001, span * .02));
}

// Largest eigenvector of Horn's symmetric 4x4 absolute-orientation matrix.
function rotation(matrix) {
  const basis = Array.from({length:4}, (_, i) => [0,1,2,3].map(j => Number(i === j)));
  for (let iter = 0; iter < 80; iter++) {
    let p = 0, q = 1;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      if (Math.abs(matrix[i][j]) > Math.abs(matrix[p][q])) { p = i; q = j; }
    }
    if (Math.abs(matrix[p][q]) < 1e-13) break;
    const pp = matrix[p][p], qq = matrix[q][q], pq = matrix[p][q];
    const angle = .5 * Math.atan2(2*pq, qq-pp), c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < 4; k++) {
      if (k !== p && k !== q) {
        const x = matrix[k][p], y = matrix[k][q];
        matrix[k][p] = matrix[p][k] = c*x-s*y;
        matrix[k][q] = matrix[q][k] = s*x+c*y;
      }
      const x = basis[k][p], y = basis[k][q];
      basis[k][p] = c*x-s*y; basis[k][q] = s*x+c*y;
    }
    matrix[p][p] = c*c*pp-2*s*c*pq+s*s*qq;
    matrix[q][q] = s*s*pp+2*s*c*pq+c*c*qq;
    matrix[p][q] = matrix[q][p] = 0;
  }
  const best = [0,1,2,3].reduce((a,b) => matrix[a][a] >= matrix[b][b] ? a : b);
  return new Quaternion(basis[1][best],basis[2][best],basis[3][best],basis[0][best]).normalize();
}

export function fitSimilarity(source, target) {
  if (source.length < 3 || source.length !== target.length ||
      ![...source,...target].every(p => p.length === 3 && p.every(Number.isFinite))) return null;
  const a = source.map(p => new Vector3(...p)), b = target.map(p => new Vector3(...p));
  if (!spread(a) || !spread(b)) return null;
  const mean = list => list.reduce((sum,p) => sum.add(p), new Vector3()).divideScalar(list.length);
  const ac = mean(a), bc = mean(b);
  const cov = Array.from({length:3}, () => [0,0,0]);
  let variance = 0;
  for (let i = 0; i < a.length; i++) {
    a[i].sub(ac); b[i].sub(bc); variance += a[i].lengthSq();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += a[i].getComponent(r)*b[i].getComponent(c);
  }
  const [[xx,xy,xz],[yx,yy,yz],[zx,zy,zz]] = cov;
  const rot = rotation([[xx+yy+zz,yz-zy,zx-xz,xy-yx],[yz-zy,xx-yy-zz,xy+yx,zx+xz],
    [zx-xz,xy+yx,-xx+yy-zz,yz+zy],[xy-yx,zx+xz,yz+zy,-xx-yy+zz]]);
  const scale = a.reduce((sum,p,i) => sum+p.applyQuaternion(rot).dot(b[i]),0)/variance;
  if (!Number.isFinite(scale) || scale < .005 || scale > 20) return null;
  const pos = bc.clone().sub(ac.applyQuaternion(rot).multiplyScalar(scale));
  const matrix = new Matrix4().compose(pos,rot,new Vector3().setScalar(scale));
  const errors = a.map((p,i) => p.multiplyScalar(scale).distanceTo(b[i]));
  return {matrix:matrix.toArray(), rms:Math.sqrt(errors.reduce((s,e) => s+e*e,0)/errors.length), errors};
}
