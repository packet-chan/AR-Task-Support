import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {openAlignment} from "./alignment-xr.js";
import {captureVoice} from "./capture-voice.js";

async function verified(url, hash, json = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("位置合わせの資料を読み込めません。");
  const data = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)),b => b.toString(16).padStart(2,"0")).join("");
  if (hash !== digest) throw new Error("位置合わせの資料とモデルの版が一致しません。");
  return json ? JSON.parse(new TextDecoder().decode(data)) : data;
}

export async function prepareAlignment(api, generation) {
  const button = document.querySelector("#enter-assist"), status = document.querySelector("#assist-status");
  const response = await fetch(api+"/S4/alignment.json");
  if (!response.ok) throw new Error("プランが開けません。");
  const plan = await response.json();
  const details = document.querySelector("#alignment-record");
  details.hidden = false;
  details.ontoggle = async () => {
    if (!details.open) return;
    const note = details.querySelector("p"), list = details.querySelector("ul");
    list.replaceChildren();
    try {
      const res = await fetch(api+"/S4/alignment-latest.json");
      if (!res.ok) throw Error();
      const last = await res.json();
      note.textContent = last ? new Date(last.received).toLocaleString("ja-JP")+"　確認した範囲　"+(last.groups.join("・") || "なし") :
        "測定記録はまだ届いていません。";
      if (last?.provisionalGroups?.length) note.textContent += "　仮合わせ　"+last.provisionalGroups.join("・");
      for (const p of last?.parts || []) {
        const li = document.createElement("li");
        li.textContent = p.label+"　"+(p.verified || p.provisional ? (p.verified ? "目視確認済み" : "仮位置")+"　モデルからの補正 "+Math.round(p.correction*1000)+
          " mm"+(p.repeat == null ? "（1点）" : "、2回の差 "+Math.round(p.repeat*1000)+" mm") : "保留");
        list.append(li);
      }
      for (const photo of last?.photos || []) {
        const li=document.createElement("li"), a=document.createElement("a");
        a.href=api+"/S4/alignment-photos/"+photo.file; a.target="_blank"; a.rel="noopener";
        a.textContent=photo.step+"　"+photo.label+"の指差し写真"; li.append(a); list.append(li);
      }
      if (last?.session) {
        const li=document.createElement("li"), a=document.createElement("a");
        a.href=api+"/S4/alignment-records/"+last.session+".json";a.target="_blank";a.rel="noopener";
        a.textContent="モデル修正用の記録（対象・座標・写真の対応）";li.append(a);list.append(li);
      }
    } catch { note.textContent = "記録を開けません。閉じて開き直してください。"; }
  };
  if (!await navigator.xr?.isSessionSupported("immersive-ar").catch(() => false)) {
    status.textContent = "S4 位置合わせを用意しました。承認済みのQuestでこの機器を開いてください。";
    return;
  }
  button.hidden = false;
  button.onclick = async () => {
    button.disabled = true;
    let session, sound, saved = false;
    try {
      const opening = navigator.xr.requestSession("immersive-ar",{optionalFeatures:["local-floor","hand-tracking"]});
      sound = captureVoice(document.querySelector("#capture-live")?.checked,()=>{});
      session = await opening;
      let ended = false;
      session.addEventListener("end", () => {
        ended = true; button.disabled = false;
        sound?.close();
        status.textContent = saved ? "位置合わせの測定記録を配信PCに保存しました。" : "位置合わせを終了しました。";
      },{once:true});
      const revision = api+"/S4/"+plan.round+"/revisions/"+plan.revision+"/S2/";
      const [model,bindings,guide] = await Promise.all([
        verified(revision+"model.glb",plan.sha256["model.glb"]),
        verified(revision+"bindings.json",plan.sha256["bindings.json"],true),
        verified(api+"/S1/task_step.json",plan.sha256["task_step.json"],true)]);
      const gltf = await new GLTFLoader().parseAsync(model,"");
      if (ended) return;
      const label = t => t.ja || plan.japanese[t.en] || t[guide.source_language];
      const steps = guide.tasks.flatMap(t => t.steps.map((s,i) => ({id:s.id,text:label(s.text),task:t.id,taskTitle:label(t.title),number:i+1,
        precautions:(t.precautions || []).map(p => label(p.text)),pages:s.pages,figures:s.figures || [],
        part:bindings.steps[s.id]?.target_part,clips:bindings.steps[s.id]?.clips || []})));
      await openAlignment(session,plan,gltf,steps,document.querySelector("#steps").value,async (record,images) => {
        const wanted = new Set(record.events.map(e=>e.result?.photo).filter(Boolean));
        for (const name of wanted) {
          const uploaded = await fetch(api+"/S4/alignment-photos/"+name,{method:"POST",
            headers:{"X-Library-Generation":generation,"Content-Type":"image/jpeg"},body:images.get(name)});
          if (!uploaded.ok) throw Error("写真を保存できません。Wi-Fiを確認して再送してください。");
        }
        const res = await fetch(api+"/S4/alignment-record.json",{method:"POST",headers:{"Content-Type":"application/json",
          "X-Library-Generation":generation},body:JSON.stringify(record)});
        if (!res.ok) throw new Error("保存できません。Wi-Fiを確認して再送してください。");
        saved = true;
      },() => sound.tap(),{
        base:api+"/S1/figure/",parts:bindings.parts,overview:guide.parts_figures || [],speak:text=>sound.say(text)
      });
    } catch (error) {
      if (session) await session.end().catch(() => {});
      else sound?.close();
      status.textContent = "AR支援を開始できません。"+error.message;
      button.disabled = false;
    }
  };
}
