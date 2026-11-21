import {language, t, ui} from "./language.js";
import {captureVoice} from "./capture-voice.js";

const entry = document.querySelector("#enter-mr");
const feedback = document.querySelector("#mr-feedback");
const retry = document.querySelector("#retry-capture");
const records = document.querySelector("#captures");
const participantField = document.querySelector("#user");
const params = new URLSearchParams(location.search);
const demo = params.get("demo") === "1";
const manuals = user => demo ? "/api/venue-view" : "/api/users/" + encodeURIComponent(user) + "/manuals";
const supportBase = manuals(params.get("user")) + "/" + encodeURIComponent(params.get("id"));
let openPanel, session, paint, voice, view, voiceLabel, devices, deviceIndex, base, generation, guides, index;
let stream, preview, recorder, timeout, ticker, cameraRequest, pending, uploading = false, starting = false;
let motionReview = false, savedPhoto = null, question = null;
const leave = ["MRを終了", () => session?.end(), "exit"];

function status(message) { ui(feedback, message); }
function controls() {
  entry.disabled = !!(starting || session || recorder || pending || uploading);
  retry.hidden = !pending || uploading || !!session;
}
function refresh() {
  if (view) paint?.({...view, caption: [view.caption, view.showVoice && voiceLabel && t(voiceLabel)].filter(Boolean).join("　·　")});
}
function panel(title, message, actions = [], options = {}) {
  view = {title, message, actions, ...options};
  refresh();
}
function say(message) { voice?.say(message); }
function showDevice() {
  const device = devices[deviceIndex];
  const actions = [["撮影へ", loadGuide, "check"], ["次の機器", () => {
    deviceIndex = (deviceIndex + 1) % devices.length;
    showDevice();
  }, "next"], leave];
  panel("撮影する機器", [device.name, device.model].filter(Boolean).join(" · "), actions);
}
function sourceText(text) { return text?.[language] || text?.ja || text?.en || ""; }
function pages(numbers) { return numbers?.length ? "p." + numbers.join(", ") : ""; }
async function ask(g,withPhoto=false) {
  const current=session;
  const photo=withPhoto && savedPhoto?.key===g.key ? savedPhoto.blob : null;
  const {openQuestion}=await import("./live-question.js");
  if (!current || current!==session) return;
  voice?.say("");
  const read=photo ? ()=>new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(photo);
  }) : null;
  question=openQuestion(JSON.stringify({model:devices[deviceIndex].model,step:g.step,part:g.name,
    request:g.request,manual:g.text,precautions:g.precautions,pages:g.pages}),read,panel,()=>{
    if (current===session) { if (photo) reviewSavedPhoto(false); else showGuide("",false); }
  });
}
function visual(g, figure = g.figures[0]) {
  return {guide: g, modelUrl: base + "/workflow/S2/model.glb",
    figure: figure && {...figure, url: base + "/workflow/S1/figure/" + encodeURIComponent(figure.file)}};
}
function details(g) {
  const entries = [];
  function add(title, text, fig) {
    // Split long source paragraphs so every character remains accessible on the headset.
    const chars = Array.from(text);
    for (let j = 0; j < chars.length || j === 0; j += 88)
      entries.push({title, text: chars.slice(j, j + 88).join(""), fig});
  }
  for (const n of g.precautions) {
    add(t("作業前の注意") + "　" + pages(n.pages), sourceText(n.text));
    if (n.text[g.source] && n.text[g.source] !== sourceText(n.text))
      add(t("原文") + "　" + pages(n.pages), n.text[g.source]);
  }
  if (g.text) {
    if (sourceText(g.text) !== g.text[g.source]) add(t("手順") + "　" + pages(g.pages), sourceText(g.text));
    add(t("原文") + "　" + pages(g.pages), g.text[g.source] || sourceText(g.text));
  }
  if (g.note) add("実機確認メモ（原文）", g.note.text);
  for (const [i, f] of g.figures.entries()) add(t("説明書の図") + "　" + (i + 1) + " / " + g.figures.length, g.name, f);
  if (!entries.length) add(t("撮影依頼"), g.request);
  let page = 0;
  function show() {
    const e = entries[page];
    const actions = [["撮影依頼に戻る", () => showGuide(), "back"]];
    if (page > 0) actions.push(["前へ", () => { page--; show(); }, "prev"]);
    if (page + 1 < entries.length) actions.push(["続きへ", () => { page++; show(); }, "next"]);
    panel(e.title, e.text, [...actions, leave], {...visual(g, e.fig || null), showVoice: true, progress: (page + 1) + " / " + entries.length});
  }
  show();
}
function showGuide(prefix = "", speak = true) {
  const g = guides[index];
  if (!g) {
    const done = prefix ? prefix + " 撮影依頼は以上です。PCの「実機の撮影記録」で確認できます。" : "撮影依頼がありません。";
    panel("撮影終了", prefix ? t("配信PCに保存しました") : t("撮影依頼がありません。"), [leave]);
    say(done);
    return;
  }
  const medium = g.mode === "video" ? "動画" : "写真";
  if (g.mode === "video" && !motionReview) {
    const text = g.name+"の動きを追加で確かめますか。写真で判断できたら終了できます。";
    panel("動きを確かめますか",text,[["動きを確認",()=>{motionReview=true;showGuide();},"video"],
      ["次の候補",()=>{index++;showGuide();},"skip"],leave],{...visual({...g,clips:[]})});
    if (speak) say(text);
    return;
  }
  const actions = [[medium + "を準備", () => prepare(g.mode), g.mode]];
  if (g.mode === "video") actions.push(["今の状態を写真に", () => prepare("photo"), "photo"]);
  actions.push(["手順・注意・図", () => details(g), "book"]);
  if (!demo) actions.push(["音声で相談",()=>ask(g),"question"]);
  if (index + 1 < guides.length) actions.push(["見送る", () => { index++; motionReview=false; showGuide(); }, "skip"]);
  const heading = g.ordinal ? "STEP " + g.ordinal + "　" + sourceText(g.title) : g.name;
  const modelLabel = g.mode === "video" && !g.clips.length ? "暫定モデル（動作データなし）" : "暫定モデル";
  const caption = [prefix && t("配信PCに保存しました"), t(modelLabel), pages(g.pages)].filter(Boolean).join("　·　");
  panel(heading, g.request, [...actions, leave],
    {...visual(g), caption, progress: (index + 1) + " / " + guides.length});
  if (speak) say([prefix, g.ordinal ? "ステップ" + g.ordinal + "の撮影です。" : "",
    g.precautions.length ? "操作前に本のマークを選んで、注意を確認してください。" : "", g.request].filter(Boolean).join(" "));
}
async function getJson(url) {
  const response = await fetch(url, {cache: "no-store"});
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
async function loadGuide() {
  const current = session;
  base = manuals(participant()) + "/" + devices[deviceIndex].id;
  panel("撮影項目を読み込み中…", "", [leave]);
  try {
    const items = await getJson(base + "/workflow/S3/guide.json");
    if (current !== session) return;
    guides = items; index = 0; motionReview=false; savedPhoto=null;
    showGuide();
  } catch {
    if (current === session) panel("撮影項目を開けませんでした", "", [["再取得", loadGuide, "retry"], leave]);
  }
}
function participant() {
  if (demo) return "DEMO";
  return (participantField?.value || params.get("user") || "").trim().toUpperCase();
}
function releaseCamera() {
  stream?.getTracks().forEach(track => track.stop());
  if (preview) preview.srcObject = null;
  preview = stream = null;
}
function stopRecording() {
  if (recorder?.state === "recording") recorder.stop();
  clearTimeout(timeout); clearInterval(ticker);
}
function finishSession() {
  cameraRequest = null; question?.close(); question=null; savedPhoto=null;
  session = paint = view = null;
  voice?.close(); voice = null;
  stopRecording(); releaseCamera(); controls();
}
function reviewSavedPhoto(speak=true) {
  const msg="写真を配信PCに保存しました。対象が見えれば終了できます。";
  const advice = demo ? msg : msg+"迷ったらマイクの「この写真で相談」を選べます。";
  const actions=[["次の依頼",()=>{index++;showGuide();},"next"],["撮り直す",()=>prepare("photo"),"retry"]];
  if (!demo) actions.push(["この写真で相談",()=>ask(guides[index],true),"question"]);
  const firstVideo=guides.findIndex(g=>g.mode==="video");
  if(firstVideo>=0) actions.push(["動きの疑問へ",()=>{index=firstVideo;showGuide();},"video"]);
  panel("保存した写真",advice,[...actions,leave],{figure:{url:savedPhoto.url}}); if (speak) say(advice);
}
async function sendCapture() {
  if (!pending || uploading) return;
  uploading = true;
  controls();
  panel("配信PCに送信中…", "");
  status("配信PCに送信中…");
  say("撮影を終えました。配信PCに送信中です。");
  try {
    const response = await fetch(pending.url, {method: "POST", headers: pending.headers, body: pending.blob,
      signal: AbortSignal.timeout(90000)});
    if (!response.ok) throw new Error(String(response.status));
    await response.json();
    const last = pending;
    pending = null;
    status("配信PCに保存しました");
    if (session) {
      motionReview=false;
      if (last.mode === "photo") {
        savedPhoto={key:guides[index].key,blob:last.blob,url:last.url};
        reviewSavedPhoto();
      } else { index++; showGuide("配信PCに保存しました。"); }
    }
    if (records?.open) loadRecords();
  } catch {
    const message = "このページを開いたまま接続を確認し、再送してください。";
    status("送信できませんでした。" + message);
    panel("送信できませんでした", message, [["再送する", sendCapture, "retry"], leave]);
    say("送信できませんでした。" + message);
  } finally { uploading = false; controls(); }
}
function takeInfo(mode) {
  const g = guides[index];
  return {url: base + "/captures/" + crypto.randomUUID().replaceAll("-", ""),
    headers: {"X-Library-Generation": generation, "X-Capture-Request": g.key,
      "X-Capture-Note": String(g.noteIndex ?? "overview")}, mode};
}
function captured(take, blob) {
  releaseCamera();
  if (!blob?.size || blob.size > 64 * 1024 * 1024) {
    status("撮影できませんでした。撮り直してください。");
    panel("撮影できませんでした", "撮り直してください。", [["撮り直す", () => prepare(take.mode), "retry"], leave]);
    say("撮影できませんでした。撮り直してください。");
    return;
  }
  take.headers["Content-Type"] = blob.type.split(";")[0];
  pending = {...take, blob};
  sendCapture();
}
async function photograph() {
  if (!preview?.videoWidth || cameraRequest) return;
  const request = cameraRequest = {};
  const take = takeInfo("photo");
  try {
    const canvas = document.createElement("canvas");
    canvas.width = preview.videoWidth; canvas.height = preview.videoHeight;
    canvas.getContext("2d").drawImage(preview, 0, 0);
    panel("写真を保存中…", "");
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .92));
    if (request === cameraRequest) captured(take, blob);
  } catch { if (request === cameraRequest) captured(take, null); }
  finally { if (request === cameraRequest) cameraRequest = null; }
}
function record() {
  if (!stream || recorder) return;
  const take = takeInfo("video");
  try {
    const mimeType = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(m => MediaRecorder.isTypeSupported(m));
    if (!mimeType) throw Error();
    const rec = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 3000000});
    const chunks = [];
    let failed = false;
    rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    rec.onerror = () => { failed = true; stopRecording(); };
    rec.onstop = () => {
      clearTimeout(timeout); clearInterval(ticker);
      recorder = null;
      captured(take, failed ? null : new Blob(chunks, {type: mimeType}));
      controls();
    };
    rec.start(1000);
    recorder = rec;
    stream.getVideoTracks()[0].addEventListener("ended", stopRecording, {once: true});
    const began = performance.now();
    const tick = () => panel("録画中", "", [["停止して送信", stopRecording, "stop"]],
      {recording: true, preview, timer: "0:" + String(Math.min(59, Math.floor((performance.now() - began) / 1000))).padStart(2, "0")});
    tick(); ticker = setInterval(tick, 1000); timeout = setTimeout(stopRecording, 60000);
    say("録画を開始しました。動きが撮れたら四角い停止ボタンで送信してください。");
  } catch { captured(take, null); }
}
async function prepare(mode) {
  if (!session || cameraRequest || recorder || pending) return;
  if (mode === "video" && !window.MediaRecorder) {
    panel("動画を記録できません","今の状態を写真で残すか、次の候補に進めます。",
      [["今の状態を写真に",()=>prepare("photo"),"photo"],["次の候補",()=>{index++;motionReview=false;showGuide();},"skip"],leave]);return;
  }
  const request = cameraRequest = {};
  panel("カメラを準備中…", "外向きカメラの使用を許可してください。撮影先は配信PCです。", [leave]);
  try {
    const media = await navigator.mediaDevices.getUserMedia({audio: false, video: {
      facingMode: {exact: "environment"}, width: {ideal: 1280}, height: {ideal: 960}, frameRate: {ideal: 30}
    }});
    if (cameraRequest !== request) { media.getTracks().forEach(track => track.stop()); return; }
    stream = media;
    preview = document.createElement("video");
    preview.muted = preview.playsInline = true; preview.srcObject = media;
    await preview.play();
    if (cameraRequest !== request) return;
    const video = mode === "video";
    const prompt = video ? "本体の動かない縁と対象を一緒に映し、動き始めから止まるまでが見える位置で赤い丸を押してください。" :
      "撮影する対象を小窓に収めて、二重丸を押すと写真が送られます。";
    const back = ["戻る", () => { releaseCamera(); showGuide(); }, "back"];
    panel(video ? "動画の画角を確認" : "写真の構図を確認", prompt,
      [[video ? "録画開始" : "写真を撮って送信", video ? record : photograph, video ? "record" : "shutter"], back, leave], {preview});
    say(prompt);
  } catch {
    if (cameraRequest !== request) return;
    releaseCamera();
    const message = "Questのカメラ権限とブラウザのサイト設定を確認してください。";
    status(message); say(message);
    panel("カメラを開けませんでした", message, [["再試行", () => prepare(mode), "retry"], ["依頼へ", () => showGuide(), "back"], leave]);
  } finally { if (cameraRequest === request) cameraRequest = null; }
}

async function enter() {
  if (entry.disabled) return;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(participant())) {
    status("ユーザーIDを入力してください。"); participantField?.focus(); return;
  }
  starting = true; controls(); status("");
  let current;
  try {
    const opening = navigator.xr.requestSession("immersive-ar", {optionalFeatures: ["layers", "hand-tracking"]});
    const live = !demo && document.querySelector("#capture-live").checked;
    voiceLabel = live ? "Gemini音声を接続" : "端末案内";
    voice = captureVoice(live, label => { voiceLabel = label; refresh(); });
    current = await opening;
    session = current;
    current.addEventListener("end", finishSession, {once: true});
    const render = await openPanel(current, () => voice?.tap());
    if (session !== current) return;
    paint = render;
    panel("撮影する機器", "機器を読み込み中…", [leave]);
    const response = await fetch(manuals(participant()), {cache: "no-store"});
    if (!response.ok && response.status !== 404) throw Error();
    const rows = response.ok ? await response.json() : [];
    if (session !== current) return;
    generation = response.headers.get("X-Library-Generation");
    devices = rows.filter(d => d.stage === "ready" && (!records || d.id === params.get("id")));
    deviceIndex = 0;
    if (!devices.length) panel("撮影する機器がありません", "配信PCで機器のS2を完了してください。", [leave]);
    else if (devices.length === 1) await loadGuide();
    else { showDevice(); say("撮影する機器を選んでください。"); }
  } catch {
    if (current && current === session) await current.end().catch(() => {});
    voice?.close(); voice = null;
    status("MRを開始できませんでした。Quest Browserと配信PCへの接続を確認してください。");
  } finally { starting = false; controls(); }
}
async function loadRecords() {
  const list = records.querySelector("ul");
  try {
    const items = await getJson(supportBase + "/captures");
    list.replaceChildren(...items.map(item => {
      const row = document.createElement("li"), link = document.createElement("a");
      link.href = supportBase + "/captures/" + item.id;
      link.target = "_blank"; link.rel = "noopener";
      const label = item.guide ? [item.guide.step, item.guide.name, item.guide.request].filter(Boolean).join(" · ") : item.note?.text || t("全景");
      const medium = item.mime === "image/jpeg" ? (item.guide?.mode === "video" ? "現況写真" : "写真") : "動画";
      link.textContent = [new Date(item.time).toLocaleString(language), t(medium), label].join(" · ");
      row.append(link);
      return row;
    }));
    if (!items.length) status("撮影記録はまだありません。");
  } catch { status("撮影記録を取得できませんでした。"); }
}
records?.addEventListener("toggle", () => { if (records.open) loadRecords(); });
retry.onclick = sendCapture;
entry.onclick = enter;
if (await navigator.xr?.isSessionSupported("immersive-ar").catch(() => false)) {
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      ({openPanel} = await import("./capture-panel.js"));
      entry.hidden = false;
      document.querySelector("#capture-voice-option").hidden = demo;
    } catch { status("撮影画面を読み込めませんでした。配信PCのThree.jsを確認してください。"); }
  } else status("このブラウザではカメラを使えません。");
}
