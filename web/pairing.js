import {isHostPC, language, ui} from "./language.js";
import {displayQr, setupVenue} from "./venue.js";

if (isHostPC) {
  document.querySelector(".entry").classList.add("host-entry");
  ui(document.querySelector("#entry-title"), "配信PC");
  ui(document.querySelector("title"), "配信PC | AR作業支援");
  import("./devices.js");
  setupVenue();
  document.querySelector("#host-pairing").hidden = false;
  const button = document.querySelector("#issue-device-qr"), output = document.querySelector("#device-status");
  const image = document.querySelector("#device-qr"), section = document.querySelector("#personal-pairing");
  let timer;
  function hideQr() {
    clearTimeout(timer);
    image.hidden = true;
    image.removeAttribute("src");
    ui(output, "");
  }
  section.ontoggle = () => { if (!section.open) hideQr(); };
  document.querySelector("#venue-code").addEventListener("click", () => { section.open = false; });
  button.onclick = async () => {
    button.disabled = true;
    hideQr();
    try {
      const response = await fetch("/api/device-qr", {method: "POST", headers: {"X-Host-Management": "1"}});
      const {url, expires, error} = await response.json();
      if (!response.ok) throw new Error(error);
      if (!section.open) return;
      await displayQr(image, url);
      const end = new Date(expires * 1000);
      ui(output, "1台限り（{time}まで）", {time: end.toLocaleTimeString(language)});
      timer = setTimeout(() => {
        hideQr();
        ui(output, "QRの有効期限が切れました。");
      }, end - Date.now());
    } catch (error) {
      ui(output, error.message || "QRを表示できませんでした。");
    } finally {
      button.disabled = false;
    }
  };
} else if (location.protocol === "https:") {
  fetch("/api/venue-view/session", {cache: "no-store"}).then(response => {
    document.querySelector("#open-demo").hidden = response.status !== 204;
  }).catch(() => {});
}
