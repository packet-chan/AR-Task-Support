import {language, t, ui} from "./language.js";

const byId = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const user = encodeURIComponent(params.get("user") || "");
const id = encodeURIComponent(params.get("id") || "");
const demo = params.get("demo") === "1";
const manual = demo ? "/api/venue-view/" + id : "/api/users/" + user + "/manuals/" + id;
const api = manual + "/workflow";
if (demo) {
  import("./venue-session.js");
}
import("./capture-entry.js");
byId("back").href = demo ? "/venue/DEMO/" : "/users/" + user + "/";
byId("pdf").href = manual + "/pdf";
let token, state, timer, guide, bindings, viewer, figures = [], figureIndex;

async function asset(path) {
  const response = await fetch(api + "/" + path);
  if (!response.ok) throw new Error("成果物を読み込めませんでした。");
  return response.json();
}

function label(text) {
  return text[language] || text[guide.source_language];
}

byId("image").onload = event => {
  const image = event.currentTarget;
  image.style.setProperty("--figure-ratio", image.naturalWidth / image.naturalHeight);
  image.style.setProperty("--double-width", (2 * image.naturalWidth) + "px");
};

function showFigure() {
  byId("illustration").hidden = !figures.length;
  if (!figures.length) return;
  const figure = figures[figureIndex];
  byId("image").src = api + "/S1/figure/" + encodeURIComponent(figure.file);
  ui(byId("fig-count"), figure.point ? "部品図 {index} / {total}" : "手順図 {index} / {total}", {
    index: figureIndex + 1, total: figures.length
  });
  byId("prev").disabled = figureIndex === 0;
  byId("next").disabled = figureIndex + 1 === figures.length;
  const pin = byId("pin");
  pin.hidden = !figure.point;
  if (figure.point) {
    pin.style.left = (100 * figure.point[0]) + "%";
    pin.style.top = (100 * figure.point[1]) + "%";
  }
}
byId("prev").onclick = () => { figureIndex--; showFigure(); };
byId("next").onclick = () => { figureIndex++; showFigure(); };

function pageLink(page) {
  const a = document.createElement("a");
  a.textContent = "p." + page + " ";
  a.href = manual + "/pdf#page=" + page;
  a.target = "_blank"; a.rel = "noopener";
  return a;
}

function showStep() {
  const task = guide.tasks[byId("tasks").selectedIndex];
  const step = task.steps[byId("steps").selectedIndex];
  const link = bindings?.steps[step.id];
  const part = link?.target_part ? bindings.parts[link.target_part] : null;
  const taskIndex = byId("tasks").selectedIndex;
  const stepIndex = byId("steps").selectedIndex;
  const position = guide.tasks.slice(0, taskIndex).reduce((count, t) => count + t.steps.length, stepIndex + 1);
  const total = guide.tasks.reduce((count, t) => count + t.steps.length, 0);
  byId("counter").textContent = String(position).padStart(2, "0") + " / " + total;
  byId("step-back").disabled = position === 1;
  byId("step-next").disabled = position === total;
  showInstruction(step);
  byId("instruction").scrollTop = 0;
  byId("pages").replaceChildren(...step.pages.map(pageLink));
  const marks = new Map((part?.figures || []).map(mark => [mark.file, mark]));
  const files = new Set([...step.figures, ...marks.keys()]);
  figures = [...files].map(file => marks.get(file) || {file});
  figureIndex = 0;
  showFigure();
  byId("play").disabled = !(viewer && link?.clips.length);
  byId("panel").hidden = !part;
  byId("panel").textContent = part?.name || "";
  byId("panel").lang = guide.source_language;
  viewer?.select(part, link?.clips || []);
}

function showInstruction(step) {
  const displayed = step.text[language] ? language : guide.source_language;
  byId("instruction").lang = displayed;
  byId("instruction").textContent = label(step.text);
  byId("language").textContent = t(displayed === guide.source_language ? "原文" : displayed === "en" ? "英訳" : "日本語訳");
}

function showTaskText(task) {
  byId("task-title").textContent = label(task.title);
  const precautions = task.precautions || [];
  byId("precautions").hidden = !precautions.length;
  byId("task-title").lang = task.title[language] ? language : guide.source_language;
  byId("precaution-list").replaceChildren(...precautions.map(note => {
    const li = document.createElement("li");
    li.lang = note.text[language] ? language : guide.source_language;
    li.append(label(note.text) + " ", ...note.pages.map(pageLink));
    return li;
  }));
}

document.addEventListener("guide-language-change", () => {
  if (!guide) return;
  const tasks = byId("tasks"), steps = byId("steps");
  const task = guide.tasks[tasks.selectedIndex];
  for (const [i, entry] of guide.tasks.entries()) tasks.options[i].text = label(entry.title);
  for (const [i, step] of task.steps.entries()) steps.options[i].text = (i + 1) + ". " + label(step.text);
  showTaskText(task);
  showInstruction(task.steps[steps.selectedIndex]);
});

function showTask() {
  const task = guide.tasks[byId("tasks").selectedIndex];
  showTaskText(task);
  byId("precautions").open = !!task.precautions?.length;
  byId("precaution-list").scrollTop = 0;
  byId("steps").replaceChildren(...task.steps.map((step, i) => new Option((i + 1) + ". " + label(step.text), step.id)));
  showStep();
}

function moveStep(direction) {
  const tasks = byId("tasks"), steps = byId("steps");
  const next = steps.selectedIndex + direction;
  if (next >= 0 && next < steps.length) {
    steps.selectedIndex = next;
  } else {
    const nextTask = tasks.selectedIndex + direction;
    if (nextTask < 0 || nextTask >= tasks.length) return;
    tasks.selectedIndex = nextTask;
    showTask();
    if (direction > 0) return;
    steps.selectedIndex = steps.length - 1;
  }
  showStep();
}
byId("step-back").onclick = () => moveStep(-1);
byId("step-next").onclick = () => moveStep(1);
byId("index").onclick = () => byId("contents").showModal();
byId("exit").onclick = () => location.assign(byId("back").href);

async function loadGuide(ready) {
  if (!guide) {
    guide = await asset("S1/task_step.json");
    byId("tasks").replaceChildren(...guide.tasks.map(task => new Option(label(task.title), task.id)));
    byId("guide").hidden = false;
    byId("tasks").onchange = showTask;
    byId("steps").onchange = showStep;
    byId("viewport").hidden = !ready;
    showTask();
  }
  if (ready && !bindings) {
    if (!demo && state.alignment) import("./alignment-entry.js").then(m => m.prepareAlignment(api, token))
      .catch(() => { byId("assist-status").textContent = "位置合わせを読み込めませんでした。"; });
    bindings = await asset("S2/bindings.json");
    byId("viewport").hidden = false;
    ui(byId("model-status"), "3Dモデルを読み込み中…");
    try {
      const {loadViewer} = await import("./viewer.js?quest-panel");
      viewer = await loadViewer(api + "/S2/model.glb");
      ui(byId("model-status"), "");
      byId("play").onclick = () => viewer.replay();
    } catch {
      ui(byId("model-status"), "3Dを表示できません。WebGLと配信PCのThree.jsの設定を確認してください。");
    }
    showStep();
  }
}

async function refresh(action) {
  clearTimeout(timer);
  byId("action").disabled = byId("choose").querySelector("button").disabled = true;
  try {
    const response = await fetch(api, action ? {method: "POST", headers: {
      "Content-Type": "application/json", "X-Library-Generation": token
    }, body: JSON.stringify(action)} : {});
    if (response.status === 404) throw new Error("この機器は見つかりません。");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    token = response.headers.get("X-Library-Generation");
    state = data;
    byId("capture-tools").hidden = data.stage !== "ready";
    ui(byId("name"), "{name}", {name: data.name});
    byId("model").textContent = data.model || "";
    ui(document.querySelector("title"), "{name} | 作業支援", {name: data.name});
    const status = {models: "PDFから型番を確認中…", select: "型番を選ぶと手順と3Dモデルを作成します。",
      s1: "手順と図を抽出中…", s2: "初版モデルを作成中…"};
    ui(byId("status"), data.error || (data.stage === "ready" ? "" :
      status[data.stage] || "登録済みPDFから作業支援を作成できます。"));
    byId("choose").hidden = data.stage !== "select";
    if (data.stage === "select") {
      byId("models").replaceChildren(...data.models.map(m => new Option(m.model + " (p." + m.page + ")", m.model)));
      byId("models").hidden = !data.models.length;
      byId("custom").hidden = !!data.models.length;
      byId("custom").required = !data.models.length;
      byId("custom").value = data.model || "";
    }
    byId("action").hidden = !!data.stage && !data.error;
    ui(byId("action"), data.error ? "この段階を再試行" : "Codexで型番を調べる");
    byId("action").onclick = () => refresh({action: data.error ? "retry" : "start"});
    if (["s2","ready"].includes(data.stage)) await loadGuide(data.stage === "ready");
    if (!data.error && ["models","s1","s2"].includes(data.stage)) timer = setTimeout(refresh, 2500);
  } catch (error) {
    ui(byId("status"), error.message || "状態を読み取れませんでした。");
    byId("action").hidden = false;
    ui(byId("action"), "再読み込み");
    byId("action").onclick = () => location.reload();
  } finally {
    byId("action").disabled = byId("choose").querySelector("button").disabled = false;
  }
}
byId("choose").onsubmit = event => {
  event.preventDefault();
  refresh({action: "select", model: byId(state.models.length ? "models" : "custom").value});
};
refresh();
