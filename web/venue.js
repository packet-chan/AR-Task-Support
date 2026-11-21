import {language, t, ui} from "./language.js";

async function loadQrEncoder() {
  if (window.qrcode) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/node_modules/qrcode-generator/qrcode.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("QRを表示できませんでした。"));
    document.head.append(script);
  });
}

export async function setupVenue() {
  const controls = document.querySelector("#venue-controls");
  const start = document.querySelector("#venue-code");
  const end = document.querySelector("#venue-end");
  const output = document.querySelector("#venue-result");
  const image = document.querySelector("#venue-qr");
  let timer;
  async function request(action) {
    const response = await fetch("/api/venue/" + action, {method: "POST", headers: {"X-Host-Management": "1"}});
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "会場デモの状態を更新できませんでした。");
    }
    return response.json();
  }
  async function update(action) {
    if (start) start.disabled = true;
    end.disabled = true;
    try {
      const data = await request(action);
      if (action === "status" && data.admission * 1000 > Date.now() && !image.hidden) return;
      clearTimeout(timer);
      controls.hidden = false;
      image.hidden = true;
      image.removeAttribute("src");
      end.hidden = !(data.active || data.url);
      if (data.url) {
        await displayQr(image, data.url);
        const deadline = new Date(data.expires * 1000);
        ui(output, "スマホ・HMDで読み取ってください（{time}まで）", {time: deadline.toLocaleTimeString(language)});
        timer = setTimeout(() => {
          image.hidden = true;
          image.removeAttribute("src");
          ui(output, "受付終了。参加済みの方は引き続き閲覧できます。");
        }, deadline - Date.now());
      } else if (action === "end") {
        ui(output, "DEMO端末の許可を解除しました。");
      } else if (data.active) {
        ui(output, "会場デモを配信中です。");
      } else {
        ui(output, "");
      }
    } catch (error) {
      controls.hidden = false;
      ui(output, error.message);
    } finally {
      if (start) start.disabled = false;
      end.disabled = false;
    }
  }
  start.onclick = () => update("qr");
  window.addEventListener("focus", () => { if (!end.disabled) update("status"); });
  end.onclick = () => {
    if (confirm(t("すべてのDEMO端末の許可と現在の参加QRを解除しますか？"))) {
      update("end").then(() => document.dispatchEvent(new Event("device-list-changed")));
    }
  };
  await update("status");
}

export async function displayQr(image, url) {
  await loadQrEncoder();
  const qr = window.qrcode(0, "M");
  qr.addData(url);
  qr.make();
  image.src = qr.createDataURL(8, 32);
  image.hidden = false;
}
