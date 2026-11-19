const byId = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const user = encodeURIComponent(params.get("user") || "");
const id = encodeURIComponent(params.get("id") || "");
const manual = "/api/users/" + user + "/manuals/" + id;
const api = manual + "/workflow";
byId("back").href = "/users/" + user + "/";
byId("pdf").href = manual + "/pdf";
let token, state, timer, guide, bindings, viewer, figures = [], figureIndex;

async function asset(path) {
  const response = await fetch(api + "/" + path);
  if (!response.ok) throw new Error("成果物を読み込めませんでした。");
  return response.json();
}

function label(text) {
  return text.ja || text[guide.source_language];
}

function showFigure() {
  byId("illustration").hidden = !figures.length;
  if (!figures.length) return;
  const figure = figures[figureIndex];
  byId("image").src = api + "/S1/figure/" + encodeURIComponent(figure.file);
  byId("fig-count").textContent = (figure.point ? "部品図 " : "手順図 ") + (figureIndex + 1) + " / " + figures.length;
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

function showStep() {
  const task = guide.tasks[byId("tasks").selectedIndex];
  const step = task.steps[byId("steps").selectedIndex];
  const link = bindings?.steps[step.id];
  const part = link?.target_part ? bindings.parts[link.target_part] : null;
  byId("instruction").textContent = label(step.text);
  byId("pages").replaceChildren(...step.pages.map(page => {
    const a = document.createElement("a");
    a.textContent = "p." + page + " ";
    a.href = manual + "/pdf#page=" + page;
    a.target = "_blank"; a.rel = "noopener";
    return a;
  }));
  const marks = new Map((part?.figures || []).map(mark => [mark.file, mark]));
  const files = new Set([...step.figures, ...marks.keys()]);
  figures = [...files].map(file => marks.get(file) || {file});
  figureIndex = 0;
  showFigure();
  byId("play").hidden = !(viewer && link?.clips.length);
  viewer?.select(part, link?.clips || []);
}

function showTask() {
  const task = guide.tasks[byId("tasks").selectedIndex];
  byId("steps").replaceChildren(...task.steps.map((step, i) => new Option(String(i + 1), step.id)));
  showStep();
}

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
    bindings = await asset("S2/bindings.json");
    byId("viewport").hidden = false;
    byId("model-status").textContent = "3Dモデルを読み込み中…";
    try {
      const {loadViewer} = await import("./viewer.js");
      viewer = await loadViewer(api + "/S2/model.glb");
      byId("model-status").textContent = "";
      byId("play").onclick = () => viewer.replay();
    } catch {
      byId("model-status").textContent = "3Dを表示できません。WebGLと配信PCのThree.jsの設定を確認してください。";
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
    byId("name").textContent = data.name;
    document.title = data.name + " | 作業支援";
    const status = {models: "PDFから型番を確認中…", select: "型番を選ぶと手順と3Dモデルを作成します。",
      s1: "手順と図を抽出中…", s2: "初版モデルを作成中…", ready: "PDFから作成した初版"};
    byId("status").textContent = data.error || ((data.model && ["s1","s2","ready"].includes(data.stage) ? data.model + " · " : "")
      + (status[data.stage] || "登録済みPDFから作業支援を作成できます。"));
    byId("choose").hidden = data.stage !== "select";
    if (data.stage === "select") {
      byId("models").replaceChildren(...data.models.map(m => new Option(m.model + "（p." + m.page + "）", m.model)));
      byId("models").hidden = !data.models.length;
      byId("custom").hidden = !!data.models.length;
      byId("custom").required = !data.models.length;
      byId("custom").value = data.model || "";
    }
    byId("action").hidden = !!data.stage && !data.error;
    byId("action").textContent = data.error ? "この段階を再試行" : "Codexで型番を調べる";
    byId("action").onclick = () => refresh({action: data.error ? "retry" : "start"});
    if (["s2","ready"].includes(data.stage)) await loadGuide(data.stage === "ready");
    if (!data.error && ["models","s1","s2"].includes(data.stage)) timer = setTimeout(refresh, 2500);
  } catch (error) {
    byId("status").textContent = error.message || "状態を読み取れませんでした。";
    byId("action").hidden = false;
    byId("action").textContent = "再読み込み";
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
