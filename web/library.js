import {isHostPC, ui} from "./language.js";

const participant = location.pathname.split("/")[2];
const demo = location.pathname === "/venue/DEMO/";
if (demo) {
  const participantLabel = Object.assign(document.createElement("strong"), {id: "participant"});
  const personal = Object.assign(document.createElement("a"), {id: "open-personal", href: "/", hidden: true});
  ui(personal, "個人端末の画面へ");
  document.querySelector(".switch-user").replaceWith(participantLabel, document.createTextNode(" "), personal);
  import("./venue-session.js");
}
document.querySelector("#participant").textContent = participant;
ui(document.querySelector("title"), "{user} の機器一覧 | AR作業支援", {user: participant});
const userApi = "/api/users/" + encodeURIComponent(participant);
const api = demo ? "/api/venue-view" : userApi + "/manuals";
const list = document.querySelector("#manuals");
const listStatus = document.querySelector("#list-status");
const retry = document.querySelector("#retry");
const dialog = document.querySelector("dialog[aria-labelledby='import-heading']");
const form = dialog.querySelector("form");
const file = form.querySelector("input[type=file]");
const metadata = form.querySelector("fieldset");
const feedback = form.querySelector(".import-feedback");
const submit = form.querySelector("button[type=submit]");
const cancel = form.querySelector("#cancel");
let importId;
let listRequest = 0;
let generation;
const deleteButton = document.querySelector("#delete-user");
deleteButton.closest("footer").hidden = !isHostPC;
const deleteDialog = document.querySelector("#delete-dialog");
const keepButton = document.querySelector("#keep-user");
const confirmDelete = document.querySelector("#confirm-delete");
const deleteError = document.querySelector("#delete-error");
const addButton = document.querySelector("#add");

deleteButton.onclick = () => {
  ui(document.querySelector("#delete-heading"), "{user} を削除しますか？", {user: participant});
  ui(deleteError, "");
  deleteDialog.dataset.generation = generation;
  deleteDialog.showModal();
  keepButton.focus();
};
keepButton.onclick = () => deleteDialog.close();
deleteDialog.oncancel = event => { if (confirmDelete.disabled) event.preventDefault(); };
confirmDelete.onclick = async () => {
  if (confirmDelete.disabled) return;
  confirmDelete.disabled = keepButton.disabled = true;
  ui(deleteError, "");
  try {
    const response = await fetch(userApi, {method: "DELETE", headers: {
      "X-Library-Generation": deleteDialog.dataset.generation, "X-Host-Management": "1"
    }});
    if (response.status === 409) {
      ui(deleteError, "ユーザー情報が変わりました。一覧を開き直してください。");
    } else if (!response.ok) {
      throw new Error();
    } else {
      location.replace("/");
      return;
    }
  } catch {
    ui(deleteError, "削除できませんでした。配信PCへの接続を確認してください。");
  }
  confirmDelete.disabled = keepButton.disabled = false;
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const milestones = [
  ["PDF取込済み", '<path d="M6 2.5h8l4 4V21H6z M14 2.5v5h4 M9 12h6 M9 16h5"/>'],
  ["動画で改善", '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>'],
  ["部品補正", '<path d="M14 5a5 5 0 0 0-6 6L3.5 16a2.5 2.5 0 0 0 3.5 3.5l5-5A5 5 0 0 0 18 8l-3 3-2-2 3-4z"/>']
];

function manualTile({id, name, model, cover, stage, failed}) {
  const tile = element("a", "tile");
  const base = api + "/" + encodeURIComponent(id);
  tile.href = "/support.html?" + new URLSearchParams(demo ? {demo: "1", id} : {user: participant, id});
  tile.dataset.id = id;
  const labels = {models: "型番を確認中", select: "型番を選ぶ", s1: "手順と図を抽出中",
    s2: "初版モデルを作成中", ready: "作業支援を開く"};
  const action = failed ? "生成状況を確認" : labels[stage] || "作業支援を作成";
  tile.setAttribute("aria-label", [name, model].filter(Boolean).join(" "));
  ui(tile, action, {}, "aria-description");
  const row = element("span", "tile-row");
  const rail = element("span", "rail");
  rail.setAttribute("aria-hidden", "true");
  milestones.forEach(([label, path], index) => {
    const dot = element("span", index === 0 ? "milestone current" : "milestone");
    ui(dot, label, {}, "title");
    dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">' + path + '</svg>';
    rail.append(dot);
  });
  const picture = element("span", "picture");
  if (stage === "ready") picture.dataset.glb = base + "/workflow/S2/model.glb";
  if (cover) {
    const img = element("img");
    img.src = base + "/cover";
    img.alt = "";
    img.width = 320;
    img.height = 250;
    picture.append(img);
  } else if (!demo) {
    picture.append(element("span", "pdf-placeholder", "PDF"));
  }
  row.append(rail, picture);
  const caption = element("span", "body");
  caption.append(element("strong", "", name));
  if (model) caption.append(element("span", "model-number", model));
  if (stage !== "ready" || failed) {
    const status = element("span", "model-number");
    ui(status, action);
    caption.append(status);
  }
  tile.append(row, caption);
  const item = element("article");
  if (demo) {
    rail.hidden = true;
  }
  const pdf = element("a", "support-link");
  ui(pdf, "元PDFを開く");
  pdf.href = base + "/pdf";
  pdf.target = "_blank";
  pdf.rel = "noopener";
  ui(pdf, "{name}の元PDFを開く", {name}, "aria-label");
  item.append(tile, pdf);
  return item;
}

async function refresh(focusId) {
  const request = ++listRequest;
  retry.hidden = true;
  try {
    const response = await fetch(api, {cache: "no-store", signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error();
    const rows = await response.json();
    if (request !== listRequest) return;
    if (demo) document.querySelector("#open-personal").hidden = response.headers.get("X-Personal-Access") !== "1";
    if (isHostPC && rows.some(row => row.stage === "ready") && !document.querySelector("#venue-code").onclick) {
      const {setupVenue} = await import("./venue.js");
      setupVenue();
    }
    generation = response.headers.get("X-Library-Generation");
    deleteButton.disabled = !generation;
    addButton.disabled = demo || !generation;
    list.replaceChildren(...rows.map(manualTile));
    const pictures = list.querySelectorAll("[data-glb]");
    if (pictures.length) {
      import("./viewer.js?model-tiles").then(module => module.showModelThumbnails(pictures))
        .catch(error => console.warn("サムネイルには説明書の表紙を使用します。", error));
    }
    ui(listStatus, rows.length ? "" : "まだ機器が登録されていません。");
    if (focusId) list.querySelector('[data-id="' + CSS.escape(focusId) + '"]')?.focus();
  } catch {
    if (request !== listRequest) return;
    ui(listStatus, "機器一覧を読み込めませんでした。");
    retry.hidden = false;
  }
}

addButton.onclick = () => {
  form.reset();
  metadata.hidden = metadata.disabled = submit.disabled = true;
  ui(feedback, "");
  dialog.showModal();
  file.focus();
};
file.onchange = () => {
  const pdf = file.files[0];
  metadata.hidden = metadata.disabled = submit.disabled = !pdf;
  form.elements.device.value = pdf ? pdf.name.replace(/\.pdf$/i, "") : "";
  ui(feedback, "");
  importId = crypto.randomUUID();
};
cancel.onclick = () => dialog.close();
dialog.oncancel = event => { if (file.disabled) event.preventDefault(); };
form.onsubmit = async event => {
  event.preventDefault();
  const pdf = file.files[0];
  const name = form.elements.device.value.trim();
  if (!pdf || file.disabled) return;
  if (!name) { form.elements.device.focus(); return; }
  file.disabled = metadata.disabled = submit.disabled = cancel.disabled = true;
  ui(feedback, "取り込み中…");
  let savedId;
  try {
    const response = await fetch(api, {method: "POST", headers: {
      "Content-Type": "application/pdf",
      "X-Import-ID": importId,
      "X-Production": "v1",
      "X-Library-Generation": generation,
      "X-Manual-Name": encodeURIComponent(name),
      "X-Model": encodeURIComponent(form.elements.model.value.trim())
    }, body: pdf});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存できませんでした。");
    savedId = result.id;
  } catch (error) {
    ui(feedback, error instanceof TypeError || error instanceof SyntaxError
      ? "配信PCに接続できませんでした。もう一度お試しください。" : error.message);
  } finally {
    file.disabled = metadata.disabled = submit.disabled = cancel.disabled = false;
  }
  if (savedId) {
    dialog.close();
    location.assign("/support.html?" + new URLSearchParams({user: participant, id: savedId}));
  }
};
retry.onclick = () => refresh();
refresh();
