async function checkSession() {
  try {
    const response = await fetch("/api/venue-view/session", {cache: "no-store"});
    if (response.status === 401 || response.status === 403) location.replace("/");
  } catch {}
}
checkSession();
window.addEventListener("pageshow", checkSession);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkSession(); });
setInterval(checkSession, 15000);
