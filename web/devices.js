import {language, t, ui} from "./language.js";

const manager = document.querySelector("#device-manager");
const refresh = document.querySelector("#refresh-devices");
const feedback = document.querySelector("#device-feedback");
const dialog = document.querySelector("#edit-device"), form = dialog.querySelector("form");
const nameInput = dialog.querySelector("#edit-name"), editError = dialog.querySelector(".edit-error");
const stamp = time => time ? new Date(time * 1000).toLocaleString(language) : t("未記録");
let sequence = 0;

async function request(path = "", data) {
  const response = await fetch("/api/devices" + path, {
    method: "POST", headers: {"X-Host-Management": "1", "Content-Type": "application/json"},
    body: data ? JSON.stringify(data) : undefined
  });
  if (!response.ok) throw new Error();
  return response.json();
}

function row(device, pending = false) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  const fallback = (device.agent || t("ブラウザ")) + " #" + device.id;
  title.textContent = device.name || fallback;
  const heading = document.createElement("div");
  heading.className = "device-heading";
  heading.append(title);
  if (device.name && device.agent) {
    const kind = document.createElement("span");
    kind.className = "device-kind";
    kind.textContent = device.agent;
    heading.append(kind);
  }
  const meta = document.createElement("dl");
  meta.className = "device-meta";
  for (const [label, value] of [["接続元IP", device.ip || t("未記録")], ["最終アクセス", stamp(device.last_seen)]]) {
    const term = document.createElement("dt"), detail = document.createElement("dd");
    ui(term, label);
    detail.textContent = value;
    meta.append(term, detail);
  }
  const actions = document.createElement("div");
  actions.className = "device-actions";
  const edit = document.createElement("button"), revoke = document.createElement("button");
  edit.type = revoke.type = "button";
  edit.className = "quiet";
  revoke.className = "quiet revoke";
  if (pending) {
    const reference = document.createElement("span");
    ui(reference, "申請 #{id}", {id: device.id});
    heading.prepend(reference);
    ui(edit, "承認する");
    ui(revoke, "拒否する");
    async function decide(action) {
      edit.disabled = revoke.disabled = true;
      try {
        await request("/" + device.id + "/" + action);
        await reload();
        refresh.focus();
      } catch {
        ui(feedback, "端末情報を更新できませんでした。");
      } finally { edit.disabled = revoke.disabled = false; }
    }
    edit.onclick = () => decide("approve");
    revoke.onclick = () => decide("deny");
    actions.append(edit, revoke);
    item.append(heading, meta, actions);
    return item;
  }
  ui(edit, "名前を変更");
  ui(revoke, "許可を解除");
  edit.onclick = () => {
    dialog.dataset.id = device.id;
    nameInput.value = device.name;
    nameInput.placeholder = fallback;
    ui(editError, "");
    dialog.showModal();
    nameInput.select();
  };
  revoke.onclick = async () => {
    const role = device.role === "demo" ? "DEMO" : t("個人端末");
    if (!confirm(role + " / " + title.textContent + "\n" + t("この端末の許可を解除しますか？"))) return;
    revoke.disabled = true;
    try {
      await request("/" + device.id + "/revoke");
      await reload();
      refresh.focus();
    } catch {
      ui(feedback, "端末情報を更新できませんでした。");
    } finally { revoke.disabled = false; }
  };
  actions.append(edit, revoke);
  item.append(heading, meta, actions);
  return item;
}

async function reload() {
  const version = ++sequence;
  refresh.disabled = true;
  try {
    const [devices, pending] = await Promise.all([request(), request("/pending")]);
    if (version !== sequence) return;
    document.querySelector("#pending-section").hidden = !pending.length;
    document.querySelector("#pending-devices").replaceChildren(...pending.map(d => row(d, true)));
    for (const role of ["demo", "personal"]) {
      const group = devices.filter(device => device.role === role && !device.revoked);
      ui(document.querySelector("#" + role + "-count"), "{count} 台", {count: group.length});
      const list = document.querySelector("#" + role + "-devices");
      list.replaceChildren(...group.map(d => row(d)));
      if (!group.length) {
        const empty = document.createElement("li");
        empty.className = "device-empty";
        ui(empty, "許可中の端末はありません。");
        list.append(empty);
      }
    }
    ui(feedback, "");
  } catch {
    ui(feedback, "端末情報を更新できませんでした。");
  } finally {
    if (version === sequence) refresh.disabled = false;
  }
}
refresh.onclick = reload;
document.querySelector("#cancel-edit").onclick = () => dialog.close();
form.onsubmit = async event => {
  event.preventDefault();
  const save = form.querySelector("[type=submit]");
  save.disabled = true;
  try {
    await request("/" + dialog.dataset.id + "/rename", {name: nameInput.value});
    dialog.close();
    await reload();
    refresh.focus();
  } catch { ui(editError, "端末情報を更新できませんでした。"); }
  finally { save.disabled = false; }
};
reload();
setInterval(() => {
  if (!document.hidden && !dialog.open && !refresh.disabled && !manager.querySelector(".device-actions:focus-within")) reload();
}, 15000);
for (const event of ["device-list-changed", "guide-language-change"]) {
  document.addEventListener(event, reload);
}
