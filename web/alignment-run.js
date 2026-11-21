import {Matrix4, Vector3} from "three";
import {fitSimilarity} from "./alignment-fit.js";

export const transform = (point, matrix) => new Vector3(...point).applyMatrix4(new Matrix4().fromArray(matrix)).toArray();
const distance = (p,q) => new Vector3(...p).distanceTo(new Vector3(...q));
const mm = m => Math.round(m*1000)+" mm";

function widestTriangle(points) {
  let best = [], area = -1;
  for (let i=0; i<points.length; i++) for (let j=i+1; j<points.length; j++) for (let k=j+1; k<points.length; k++) {
    const origin = new Vector3(...points[i].position);
    const a = new Vector3(...points[j].position).sub(origin);
    const b = new Vector3(...points[k].position).sub(origin);
    const size = a.cross(b).lengthSq();
    if (size > area) { area = size; best = [i,j,k]; }
  }
  return best;
}

export class AlignmentRun {
  constructor(plan, steps, initialStep) {
    this.plan = plan;
    this.steps = steps;
    this.index = Math.max(0, steps.findIndex(s => s.id === initialStep));
    this.groupIndex = 0;
    const body = plan.groups[0];
    // Older frozen plans retain their authored points. Pick a usable triangle from them.
    const indices = body.quickFit || widestTriangle(body.fit);
    this.quickGroup = {...body,fit:indices.map(i => body.fit[i]),check:[],indices};
    this.quick = true;
    this.samples = [];
    this.cursor = 0;
    this.phase = "fit";
    this.message = "";
    this.record = {protocol:plan.protocol,interactionVersion:4,profile:plan.id,session:crypto.randomUUID(),
      groups:{},parts:{},events:[]};
  }
  get group() { return this.quick ? this.quickGroup : this.plan.groups[this.groupIndex]; }
  get bodyResult() { return this.record.groups[this.plan.groups[0].id]; }
  get step() { return this.steps[this.index]; }
  get part() { return this.override || this.plan.stepTargets[this.step.id] || this.step.part; }
  get target() { return this.plan.targets[this.part]; }
  get groupResult() {
    const local = this.record.groups[this.target?.group];
    if (local?.matrix || !this.bodyResult?.matrix) return local;
    return {matrix:this.bodyResult.matrix,verified:false,source:this.plan.groups[0].id};
  }
  get groupPoint() {
    if (this.phase === "fit") return this.group.fit[this.cursor];
    if (this.phase === "check") return this.group.check[this.cursor-this.group.fit.length];
  }
  enterPart() {
    this.first = null;
    this.candidate = null;
    this.phase = this.target && this.groupResult?.matrix ? "assist" : "unavailable";
  }
  moveStep(delta) {
    this.override = null;
    const next = Math.min(this.steps.length-1, Math.max(0,this.index+delta));
    if (next !== this.index) {
      for (const part of this.plan.movable) delete this.record.parts[part];
    }
    this.index = next;
    this.message = "";
    this.enterPart();
  }
  choosePart(id) {
    if (!this.plan.targets[id]) return;
    this.override = id;
    this.message = "";
    this.enterPart();
  }
  retryPart() {
    this.enterPart();
    if (this.phase !== "assist") return;
    this.phase = "point";
    this.message = "実機の点を取り直します。";
  }
  confirmPart() {
    if (this.phase !== "inspect" || !this.candidate) return;
    const verified = this.groupResult.verified && !this.candidate.provisional;
    if (this.groupResult.source) {
      this.record.groups[this.target.group] = {...this.record.groups[this.target.group],...this.groupResult};
    }
    this.record.parts[this.part] = {...this.candidate,verified,provisional:!verified};
    this.record.events.push({type:"part-confirmed",id:this.part,step:this.step.id,result:this.record.parts[this.part]});
    this.candidate = null;
    this.phase = "assist";
  }
  defer() {
    this.record.parts[this.part] = {verified:false};
    this.record.events.push({type:"defer",id:this.part,step:this.step.id});
    this.first = null;
    this.phase = "deferred";
    this.message = "この部品を保留しました。";
  }
  nextGroup() {
    this.samples = [];
    this.cursor = 0;
    this.replacing = false;
    this.fit = null;
    this.quick = false;
    this.groupIndex = this.plan.groups.length;
    this.enterPart();
  }
  skipGroup() {
    if (!this.group) return;
    if (!this.fit) {
      const ids = this.group.fit.map((_,i) => i).filter(i => this.samples[i]);
      this.fit = fitSimilarity(ids.map(i => this.group.fit[i].position),ids.map(i => this.samples[i]));
    }
    const locations = [];
    this.samples.forEach((p,i) => { locations[this.group.indices?.[i] ?? i] = p; });
    this.record.groups[this.group.id] = {...this.fit,locations,verified:false};
    this.record.events.push({type:"continue-unverified",group:this.group.id});
    this.message = this.fit ? "仮合わせで続けます。" : "この範囲は保留しました。";
    this.nextGroup();
  }
  restartGroup() {
    this.record.events.push({type:"retry-group",group:this.group.id});
    this.samples = []; this.cursor = 0; this.replacing = false; this.fit = null; this.phase = "fit";
    this.message = "この範囲の点を取り直します。";
  }
  recalibrate(index) {
    this.quick = false;
    const affected = index === 0 ? this.plan.groups : [this.plan.groups[index]];
    const ids = new Set(affected.map(g => g.id));
    for (const id of ids) delete this.record.groups[id];
    for (const id of Object.keys(this.record.parts)) {
      if (ids.has(this.plan.targets[id].group)) delete this.record.parts[id];
    }
    this.groupIndex = index;
    this.override = null;
    this.restartGroup();
  }
  selectPoint(index) {
    this.cursor = index;
    this.phase = index < this.group.fit.length ? "fit" : "check";
  }
  undo() {
    if (!this.group) return;
    if (!this.samples.length && this.groupIndex > 0) {
      const previous = this.record.groups[this.plan.groups[this.groupIndex-1].id]?.locations;
      if (previous?.length) {
        this.recalibrate(this.groupIndex-1);
        this.samples = [...previous];
      }
    }
    if (!this.samples.length) return;
    if (this.replacing) { this.replacing = false; this.evaluateGroup(); return; }
    this.samples.pop();
    this.selectPoint(this.samples.length);
    this.fit = null;
    this.message = "ひとつ前の目印を指してください。";
    this.record.events.push({type:"undo",group:this.group.id,index:this.cursor});
  }
  retryPoint(index = this.worst) {
    if (this.phase !== "failed" || !Number.isInteger(index) || index < 0 || index >= this.samples.length) return;
    this.replacing = true;
    this.selectPoint(index);
    this.message = "この点だけを指し直してください。";
  }
  recordLandmark(xyz) {
    this.record.events.push({type:xyz ? this.phase : "skip-point",id:this.group.id,index:this.group.indices?.[this.cursor] ?? this.cursor,xyz});
    this.samples[this.cursor] = xyz;
    this.message = "";
    if (this.samples.length < this.group.fit.length+this.group.check.length) {
      this.selectPoint(this.samples.length);
    } else {
      this.replacing = false;
      this.evaluateGroup();
    }
  }
  evaluateGroup() {
    const g = this.group, refs = [...g.fit,...g.check];
    const ids = g.fit.map((_,i) => i).filter(i => this.samples[i]);
    this.fit = fitSimilarity(ids.map(i => refs[i].position),ids.map(i => this.samples[i]));
    this.phase = "failed";
    if (!this.fit) {
      this.worst = Math.max(0,g.fit.findIndex((_,i) => !this.samples[i]));
      this.message = "離れた基準点が3点必要です。";
      return;
    }
    if (this.quick) { this.skipGroup(); return; }
    const errors = this.samples.map((p,i) => p && distance(transform(refs[i].position,this.fit.matrix),p));
    const ratios = errors.map((e,i) => e === null ? -1 : e/(i<g.fit.length ? g.fitLimit : g.checkLimit));
    this.worst = ratios.indexOf(Math.max(...ratios));
    const checks = errors.slice(g.fit.length);
    this.fit.checks = checks.map((error,i) => ({xyz:this.samples[g.fit.length+i],error}));
    this.fit.pointErrors = errors;
    if (ratios[this.worst] > 1) {
      this.message = "目印 "+(this.worst+1)+" のずれ "+mm(errors[this.worst])+"（目安 "+mm(this.worst<g.fit.length ? g.fitLimit : g.checkLimit)+"）";
      return;
    }
    if (!checks.length || checks.includes(null)) {
      this.worst = g.fit.length+Math.max(0,checks.indexOf(null));
      this.message = "確認点が未測定です。"; return;
    }
    this.record.groups[g.id] = {...this.fit,locations:[...this.samples],samples:this.samples.slice(0,g.fit.length),verified:true};
    this.message = g.label+"を確認しました。";
    this.nextGroup();
  }
  point(xyz) {
    if (!Array.isArray(xyz) || xyz.length !== 3 || !xyz.every(Number.isFinite)) return;
    if (this.groupPoint) { this.recordLandmark(xyz); return; }
    if (this.phase !== "point" || !this.groupResult?.matrix) return;
    this.first = xyz;
    const basis = this.groupResult.matrix;
    const local = new Vector3(...xyz).applyMatrix4(new Matrix4().fromArray(basis).invert());
    this.candidate = {method:"single-point",first:xyz,step:this.step.id,basis:[...basis],
      predicted:transform(this.target.position,basis),localPoint:local.toArray(),
      offset:local.sub(new Vector3(...this.target.position)).toArray(),time:new Date().toISOString()};
    this.record.events.push({type:"point",id:this.part,step:this.step.id,xyz});
    this.phase = "inspect";
    this.message = "";
  }
}
